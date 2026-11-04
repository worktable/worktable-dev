// ============================================================
// Recording what each `.html` and plain `.json` is
// ============================================================
//
// Before this record, any `.html` below a Space's docs/ was an HTML Doc by
// its name. Now only Worktable makes one (doc-source-kind.ts). So that
// nothing already in a Space changes, each Space is recorded once: every
// `.html` that is an HTML Doc without a claim gets one, every plain `.json`
// file without one gets a file claim, and the inventory says from then on
// that its HTML Docs are those it claims. All of it is one inventory write,
// so a Space is either recorded or not, and an interrupted run starts again
// on the next pass. A Space that isn't recorded yet keeps the earlier rule,
// so recording only fixes what it already showed.
//
// Runs off the request path: once after boot recovery for every Space, and
// for a Space that appears later. It holds the Space's namespace lock, which
// every create, move and delete holds, so no lifecycle operation is midway.
//
// A plain `.json` that changes on disk afterwards is recorded as a file when
// its versions are kept (recordExternalFileChanges), so Doc blocks written
// into it later don't make it a Doc.

import { readdir } from "node:fs/promises"
import { CanonicalIdSchema, type DocumentId } from "@worktable/types"
import { logError } from "./debug-log.ts"
import { withDocPathLock } from "./doc-path-lock.ts"
import { inventoryClaimsHtmlDocs } from "./doc-source-kind.ts"
import {
  buildDocumentCatalog,
  type DocumentCatalog,
} from "./document-catalog.ts"
import { BUILTIN_DOCUMENT_FORMATS } from "./document-format-registry.ts"
import {
  DocumentInventorySpaceNotFoundError,
  mintDocumentId,
  readDocumentInventory,
  updateDocumentInventory,
  type DocumentInventoryMutation,
} from "./document-inventory.ts"
import { readWorkspaceStorageLayoutAt } from "./workspace-storage-v2.ts"
import { getSpacesDir, getWorkspaceRoot } from "./workspace.ts"

type Upsert = NonNullable<DocumentInventoryMutation["upsert"]>[number]

/**
 * The claims a catalog's unclaimed `.html` HTML Docs and plain `.json` files
 * need to stay what they are. A conflict's claims are kept too, so the
 * conflict stays as it shows.
 */
export function sourceKindClaims(
  catalog: DocumentCatalog,
  options: { html: boolean; paths?: ReadonlySet<string> }
): Upsert[] {
  const claims: Upsert[] = []
  for (const entry of catalog.entries) {
    const found =
      entry.kind === "document"
        ? [
            {
              identity: entry.handle.identity,
              path: entry.descriptor.path,
              format: entry.descriptor.format,
              source: entry.handle.source,
            },
          ]
        : entry.claims.flatMap((claim) =>
            claim.kind === "document" ? [claim] : []
          )
    for (const claim of found) {
      if (claim.identity !== "provisional" || claim.source.kind !== "file") {
        continue
      }
      if (options.paths && !options.paths.has(claim.path)) continue
      const kept =
        (options.html &&
          claim.format.id === BUILTIN_DOCUMENT_FORMATS.html &&
          claim.source.relativePath.endsWith(".html")) ||
        (claim.format.id === BUILTIN_DOCUMENT_FORMATS.file &&
          claim.source.relativePath.endsWith(".json"))
      if (!kept) continue
      claims.push({
        documentId: mintDocumentId() as DocumentId,
        path: claim.path,
        format: claim.format,
        source: claim.source,
      })
    }
  }
  return claims
}

/**
 * Record one Space's `.html` and plain `.json` kinds, once: "recorded" by
 * this call, "already" recorded, or "later" when it can't be now.
 */
export async function recordSourceKinds(
  spaceId: string
): Promise<"recorded" | "already" | "later"> {
  CanonicalIdSchema.parse(spaceId)
  const workspaceRoot = getWorkspaceRoot()
  return withDocPathLock(spaceId, async () => {
    if ((await readWorkspaceStorageLayoutAt(workspaceRoot)).kind !== "v2") {
      return "later"
    }
    const inventory = await readDocumentInventory(spaceId).catch((error) => {
      // A Space removed before its turn has nothing to record.
      if (error instanceof DocumentInventorySpaceNotFoundError) return null
      throw error
    })
    if (!inventory) return "later"
    if (inventoryClaimsHtmlDocs(inventory.raw)) return "already"
    // An inventory that needs repair is left as it is; the Space keeps the
    // earlier rule until it is repaired and a later pass records it.
    if (inventory.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      return "later"
    }
    const catalog = await buildDocumentCatalog({ workspaceRoot, spaceId })
    await updateDocumentInventory(spaceId, {
      upsert: sourceKindClaims(catalog, { html: true }),
      claimHtmlDocs: true,
    })
    return "recorded"
  })
}

let queue: Promise<void> = Promise.resolve()
const recorded = new Set<string>()

/**
 * Record these Spaces' kinds in the background, one Space at a time. A Space
 * this process already recorded is skipped without a read. The returned
 * promise settles when they are done, so the server's drains can wait for it.
 */
export function scheduleSourceKindRecords(
  spaceIds: Iterable<string>
): Promise<void> {
  const pending = [...spaceIds].filter((spaceId) => !recorded.has(spaceId))
  if (pending.length === 0) return queue
  queue = queue.then(async () => {
    for (const spaceId of pending) {
      if (recorded.has(spaceId)) continue
      try {
        const outcome = await recordSourceKinds(spaceId)
        if (outcome === "recorded") {
          console.info("[documents] recorded which files are HTML Docs in a Space")
        }
        if (outcome !== "later") recorded.add(spaceId)
      } catch (error) {
        // Left for the next pass; the Space keeps the earlier rule meanwhile.
        console.warn("[documents] a Space's HTML Docs were not recorded:", logError(error))
      }
    }
  })
  return queue
}

/** Every Space folder in the workspace, archived ones included. */
export async function workspaceSpaceIds(): Promise<string[]> {
  const entries = await readdir(getSpacesDir(), { withFileTypes: true }).catch(
    () => []
  )
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() && CanonicalIdSchema.safeParse(entry.name).success
    )
    .map((entry) => entry.name)
}

/** Forget what this process recorded, for a replaced workspace or tests. */
export function resetSourceKindRecords(): void {
  recorded.clear()
}

