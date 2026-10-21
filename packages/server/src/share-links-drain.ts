import { getWorkspaceCollaborationEpoch } from "./collaboration-epoch.ts"
import { publicShareKind } from "./document-page-service.ts"
import { useResolvedDocumentHandle } from "./document-query.ts"
import {
  findShareLinkByToken,
  importV1ShareLink,
  markV1SharesDrained,
  settleV1ShareLinks,
  sharingV2Active,
} from "./share-links-store.ts"
import {
  readStoredDocumentShares,
  removeMovedDocumentShares,
  type StoredDocumentShare,
} from "./share-store.ts"
import { getSpaceArchiveInfo, readSpace } from "./store.ts"
import { runWithoutTeamIdentity } from "./team-policy.ts"

// ============================================================
// Moving today's links into links (v2), once
// ============================================================
//
// Each share in document-shares.json becomes a link under the same token, so
// its URL keeps working, keyed by its document's durable id. Shares whose
// document is gone or archived, or from an earlier workspace, are dropped:
// they open nothing today either. The store then notes the move, and the
// file is rewritten as a valid empty file, which an older binary reads and
// serves nothing from. A link is never kept in both places: a copy in the
// old file would lose the expiry and password it gets here.
//
// Every step can be repeated. A token already in the store is left alone, so
// a move cut short finishes on the next run without duplicating a link or
// bringing back one revoked since. A copied link counts as moving until the
// old file, read under its lock, is seen without it; if an older binary
// stopped it there meanwhile, it is revoked here too. The move runs at boot
// whenever links v2 is on, so a share an older binary made since is moved
// then; and when the owner turns the sharing preview on.

/** A share another binary may still add while the file is read. */
const ROUNDS = 3

let running: Promise<void> | null = null

/**
 * Move today's links into the links store, unless links v2 is off. Calls
 * made while a move runs wait for it. It is the Worktable's own work, whoever
 * set it off, so it reads every Space.
 */
export function drainV1ShareLinks(): Promise<void> {
  if (!sharingV2Active()) return Promise.resolve()
  running ??= runWithoutTeamIdentity(drain).finally(() => {
    running = null
  })
  return running
}

async function drain(): Promise<void> {
  for (let round = 0; round < ROUNDS; round++) {
    const epoch = await getWorkspaceCollaborationEpoch()
    const outcomes = new Map<string, boolean>()
    for (const share of await readStoredDocumentShares()) {
      outcomes.set(
        share.token,
        share.workspaceEpoch !== epoch || (await moveShare(share, epoch))
      )
    }
    // The store says links v2 is on before the file stops serving them, so
    // a stop in between never leaves a link with neither.
    markV1SharesDrained()
    if (
      await removeMovedDocumentShares(
        (share) => outcomes.get(share.token) ?? null,
        // Under the file's lock: a link an older binary stopped since it was
        // copied, in this run or one cut short, is revoked here as well.
        (present, removing) =>
          settleV1ShareLinks(
            present.map((share) => share.token),
            removing.map((share) => share.token)
          )
      )
    ) {
      return
    }
  }
  throw new Error("Shares kept changing while they were moved")
}

/**
 * Move one share. True once it is settled: in the store, or dropped because
 * its document is gone or archived. False when its path names more than one
 * document for now: it stays in the old file, which still serves it, until a
 * later run. A failure to read the document throws, and the share stays
 * where it is.
 */
async function moveShare(
  share: StoredDocumentShare,
  epoch: string
): Promise<boolean> {
  if (findShareLinkByToken(share.token)) return true
  const { data: space } = await readSpace(share.spaceId)
  if (!space || getSpaceArchiveInfo(space)) return true
  // Archived documents resolve as not found. The id is made durable first,
  // as a new link's is, so the link follows the document from now on.
  const resolution = await useResolvedDocumentHandle(
    {
      spaceId: share.spaceId,
      path: share.artifactKey,
      materializeIdentity: true,
    },
    async (handle) => {
      if ((await publicShareKind(handle)) === share.kind) {
        importV1ShareLink({
          token: share.token,
          workspaceEpoch: epoch,
          spaceId: share.spaceId,
          documentId: handle.documentId,
          kind: share.kind,
          createdAt: Date.parse(share.createdAt),
        })
      }
      return { kind: "document" as const }
    }
  )
  return resolution.kind !== "conflict" && resolution.kind !== "alias-error"
}

/** Start the move in the background, logging rather than throwing. */
export function startV1ShareLinkDrain(): Promise<void> {
  return drainV1ShareLinks().catch((error: unknown) => {
    console.error(
      "[share-links] moving earlier links failed:",
      error instanceof Error ? error.name : "error"
    )
  })
}
