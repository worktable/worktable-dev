import type {
  DocumentFormatClaim,
  DocumentId,
  DocumentSource,
} from "@worktable/types"
import { reservedByAliasIn } from "./doc-aliases.ts"
import {
  buildDocumentCatalog,
  type DocumentCatalogEntry,
} from "./document-catalog.ts"
import { BUILTIN_DOCUMENT_FORMATS } from "./document-format-registry.ts"
import {
  mintDocumentId,
  updateDocumentInventory,
  validateDocumentInventoryMutation,
} from "./document-inventory.ts"
import { analyzeDocumentPath } from "./document-path.ts"
import {
  DOCUMENT_STORAGE_PROFILE_IDS,
  documentStorageProfiles,
} from "./document-storage-profile.ts"
import { withDocPathLock } from "./doc-path-lock.ts"
import { getWorkspaceRoot } from "./workspace.ts"

export type ManagedLegacyDocumentFamily = "doc" | "html"

interface ManagedDocumentClaim {
  format: DocumentFormatClaim
  source: DocumentSource
}

interface ManagedDocumentAdmission {
  documentId: DocumentId
  currentClaim: ManagedDocumentClaim | null
  durable: boolean
}

export interface ManagedDocumentAdmissionContext {
  documentId: DocumentId
  durable: boolean
}

export class ManagedDocumentAdmissionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ManagedDocumentAdmissionError"
  }
}

function entryComparisonKey(entry: DocumentCatalogEntry): string {
  return entry.kind === "conflict"
    ? entry.pathKey
    : (analyzeDocumentPath(entry.descriptor.path).comparisonKey ??
        entry.descriptor.path)
}

function isFamilyClaim(
  family: ManagedLegacyDocumentFamily,
  path: string,
  claim: ManagedDocumentClaim,
  intent: "write" | "delete" = "write"
): boolean {
  if (family === "html") {
    if (claim.format.id !== BUILTIN_DOCUMENT_FORMATS.html) return false
    const profile =
      documentStorageProfiles.resolve(claim.format, claim.source)
    if (
      profile ===
        DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle &&
      claim.source.kind === "bundle"
    ) {
      return claim.source.relativePath === `widgets/${path}`
    }
    if (
      profile === DOCUMENT_STORAGE_PROFILE_IDS.legacyDocFile &&
      claim.source.kind === "file"
    ) {
      return claim.source.relativePath === `docs/${path}.html`
    }
    return false
  }
  // This is the legacy Doc authoring family, not every managed file. A
  // registered attachment or specialized format may share its lifecycle
  // profile without being writable through Markdown/BlockNote APIs.
  if (
    intent === "write" &&
    claim.format.id !== BUILTIN_DOCUMENT_FORMATS.markdown &&
    claim.format.id !== BUILTIN_DOCUMENT_FORMATS.richText
  ) {
    return false
  }
  const profileId = documentStorageProfiles.resolve(claim.format, claim.source)
  if (profileId !== DOCUMENT_STORAGE_PROFILE_IDS.legacyDocFile) return false
  const expectedSource = documentStorageProfiles
    .get(profileId)
    .sourceForLogicalPath?.(claim.format, path)
  return (
    expectedSource?.kind === claim.source.kind &&
    expectedSource.relativePath === claim.source.relativePath
  )
}

async function documentIdForManagedWrite(
  spaceId: string,
  path: string,
  family: ManagedLegacyDocumentFamily,
  intent: "write" | "delete",
  allowHtmlMetadataRepair: boolean
): Promise<ManagedDocumentAdmission | null> {
  const analyzed = analyzeDocumentPath(path)
  if (
    !analyzed.safe ||
    !analyzed.canonicalPath ||
    !analyzed.comparisonKey
  ) {
    throw new ManagedDocumentAdmissionError(
      `Document path cannot be created here: ${path}`
    )
  }

  const catalog = await buildDocumentCatalog({
    workspaceRoot: getWorkspaceRoot(),
    spaceId,
  })
  if (
    catalog.inventoryDiagnostics.some(
      (diagnostic) => diagnostic.severity === "error"
    )
  ) {
    throw new ManagedDocumentAdmissionError(
      "Documents cannot be updated until this Space's document conflicts are resolved"
    )
  }

  const reservation = reservedByAliasIn(catalog.aliases, path)
  if (reservation) {
    throw new ManagedDocumentAdmissionError(
      `This path is reserved by another document: ${reservation.path}`
    )
  }

  const occupying = catalog.entries.filter(
    (entry) => entryComparisonKey(entry) === analyzed.comparisonKey
  )
  if (occupying.length === 0) {
    if (intent === "delete") return null
    const newPath = analyzeDocumentPath(path, {
      enforceNewPathGrammar: true,
    })
    if (
      !newPath.safe ||
      !newPath.portable ||
      newPath.canonicalPath !== path
    ) {
      throw new ManagedDocumentAdmissionError(
        `Document path cannot be created here: ${path}`
      )
    }
    return {
      documentId: mintDocumentId(),
      currentClaim: null,
      durable: false,
    }
  }
  if (occupying.length !== 1 || occupying[0]?.kind === "conflict") {
    throw new ManagedDocumentAdmissionError(
      `This path has conflicting documents and cannot be updated: ${analyzed.canonicalPath}`
    )
  }

  const existing = occupying[0]
  if (existing.descriptor.path !== path) {
    throw new ManagedDocumentAdmissionError(
      `Another document already uses this path: ${analyzed.canonicalPath}`
    )
  }
  const errorDiagnostics = existing.handle.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error"
  )
  const exactFamilyClaim = isFamilyClaim(family, path, {
    format: existing.descriptor.format,
    source: existing.handle.source,
  }, intent)
  const deletionCanCleanDegradedSource =
    intent === "delete" &&
    errorDiagnostics.length === 1 &&
    (errorDiagnostics[0]?.code === "inventory-source-missing" ||
      (family === "html" &&
        errorDiagnostics[0]?.code === "widget-content-missing"))
  const writeCanRepairHtmlMetadata =
    intent === "write" &&
    allowHtmlMetadataRepair &&
    family === "html" &&
    exactFamilyClaim &&
    errorDiagnostics.length === 1 &&
    errorDiagnostics[0]?.code === "widget-metadata-invalid"
  if (
    (existing.descriptor.health === "invalid" ||
      errorDiagnostics.length > 0) &&
    !deletionCanCleanDegradedSource &&
    !writeCanRepairHtmlMetadata
  ) {
    throw new ManagedDocumentAdmissionError(
      `This document must be repaired before it can be updated: ${analyzed.canonicalPath}`
    )
  }
  if (!exactFamilyClaim) {
    throw new ManagedDocumentAdmissionError(
      `Another document already uses this path: ${analyzed.canonicalPath}`
    )
  }
  return {
    documentId:
      existing.handle.identity === "durable"
        ? existing.handle.documentId
        : mintDocumentId(),
    currentClaim: {
      format: existing.descriptor.format,
      source: existing.handle.source,
    },
    durable: existing.handle.identity === "durable",
  }
}

/**
 * Admit one managed legacy mutation through the format-neutral namespace.
 * Low-level filesystem writers opt in explicitly so external/fixture writes
 * remain discoverable as provisional documents until a managed write occurs.
 */
export async function admitManagedDocumentWrite<T>(options: {
  spaceId: string
  /**
   * Resolve automatic paths while the common namespace is serialized. A
   * fixed path avoids the extra callback for every ordinary update.
   */
  path: string | (() => string | Promise<string>)
  family: ManagedLegacyDocumentFamily
  /**
   * The complete format-specific transaction, including every narrower lock,
   * content write, and history update. Admission owns the outer namespace lock
   * and must never be entered while a format-specific lock is already held.
   */
  transaction: (
    path: string,
    admission?: ManagedDocumentAdmissionContext
  ) => Promise<T>
  committedClaim: (result: T, path: string) => ManagedDocumentClaim | null
  /**
   * A deterministic claim for a genuinely new source. Admission validates its
   * exact inventory publication before the format transaction creates any
   * artifacts. Formats whose final source depends on the transaction may omit
   * this and retain the post-transaction publication path.
   */
  newDocumentClaim?: (path: string) => ManagedDocumentClaim
  onAdmissionFailure?: (result: T) => void | Promise<void>
  /**
   * Exact deletion is idempotent when the namespace is already empty. This
   * explicit mode keeps that no-op under the namespace lock without applying
   * creation grammar or minting an identity for a document that does not
   * exist. All occupied-path validation remains unchanged.
   */
  intent?: "delete"
  /**
   * Preserve the HTML create-as-upsert recovery path for one exact bundle
   * whose widget metadata is corrupt. Every other degraded or conflicting
   * source remains blocked.
   */
  allowHtmlMetadataRepair?: boolean
}): Promise<T> {
  return withDocPathLock(options.spaceId, async () => {
    const path =
      typeof options.path === "function" ? await options.path() : options.path
    const admission = await documentIdForManagedWrite(
      options.spaceId,
      path,
      options.family,
      options.intent ?? "write",
      options.allowHtmlMetadataRepair ?? false
    )
    if (!admission) {
      const result = await options.transaction(path)
      try {
        if (!options.committedClaim(result, path)) return result
        throw new Error(
          "managed document deletion created a source without an identity"
        )
      } catch (error) {
        try {
          await options.onAdmissionFailure?.(result)
        } catch {
          // Preserve the admission failure; cleanup is best effort.
        }
        throw error
      }
    }

    // Materialize a provisional document before its first managed update.
    // A format-changing write can then use the durable lifecycle journal on
    // that very first transition. If the write fails, the unchanged source is
    // still accurately represented by the newly durable claim.
    if (!admission.durable && admission.currentClaim) {
      await updateDocumentInventory(options.spaceId, {
        upsert: [
          {
            documentId: admission.documentId,
            path,
            format: admission.currentClaim.format,
            source: admission.currentClaim.source,
          },
        ],
      })
    }

    if (!admission.currentClaim && options.newDocumentClaim) {
      const claim = options.newDocumentClaim(path)
      if (
        !isFamilyClaim(
          options.family,
          path,
          claim,
          options.intent ?? "write"
        )
      ) {
        throw new Error(
          "managed document write planned an invalid source claim"
        )
      }
      await validateDocumentInventoryMutation(options.spaceId, {
        upsert: [
          {
            documentId: admission.documentId,
            path,
            format: claim.format,
            source: claim.source,
          },
        ],
      })
    }

    const result = await options.transaction(path, {
      documentId: admission.documentId,
      durable: admission.durable,
    })
    try {
      const claim = options.committedClaim(result, path)
      if (!claim) return result
      if (
        !isFamilyClaim(
          options.family,
          path,
          claim,
          options.intent ?? "write"
        )
      ) {
        throw new Error(
          "managed document write returned an invalid source claim"
        )
      }

      // Existing sources are either unchanged or transitioned by the durable
      // lifecycle coordinator, which owns publishing the changed claim. Only
      // a genuinely new source still needs its first inventory entry here.
      if (admission.currentClaim) {
        return result
      }
      await updateDocumentInventory(options.spaceId, {
        upsert: [
          {
            documentId: admission.documentId,
            path,
            format: claim.format,
            source: claim.source,
          },
        ],
      })
      return result
    } catch (error) {
      try {
        await options.onAdmissionFailure?.(result)
      } catch {
        // Preserve the admission failure; cleanup is best effort.
      }
      throw error
    }
  })
}
