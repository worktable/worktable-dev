import { resolveDocAlias } from "./doc-aliases.ts"
import { withDocPathLock } from "./doc-path-lock.ts"
import {
  materializeHtmlDocumentStorageV2,
  usesHtmlDocumentStorageV2,
} from "./html-document-storage-v2.ts"

export class HtmlDocumentPathConflictError extends Error {
  readonly canonicalPath: string | null

  constructor(message: string, canonicalPath: string | null = null) {
    super(message)
    this.name = "HtmlDocumentPathConflictError"
    this.canonicalPath = canonicalPath
  }
}

/**
 * Keep specialized HTML mutations on the canonical side of the universal
 * document alias boundary. The namespace lock makes the check atomic with
 * any narrower widget transaction started by the callback.
 */
export function withCanonicalHtmlDocumentPath<T>(
  spaceId: string,
  path: string,
  transaction: () => Promise<T>,
  options: {
    materialize?: boolean
    transactionOwnsPathLock?: boolean
  } = {}
): Promise<T> {
  const validate = async () => {
    const resolution = await resolveDocAlias(spaceId, path)
    if (!resolution.path) {
      throw new HtmlDocumentPathConflictError(
        resolution.error ?? "Document aliases are unavailable"
      )
    }
    if (resolution.path !== path) {
      throw new HtmlDocumentPathConflictError(
        `This HTML doc moved to ${resolution.path}`,
        resolution.path
      )
    }
    if (options.materialize && (await usesHtmlDocumentStorageV2())) {
      await materializeHtmlDocumentStorageV2(spaceId, path)
    }
  }
  const runLocked = () =>
    withDocPathLock(spaceId, async () => {
      await validate()
      return transaction()
    })
  if (!options.transactionOwnsPathLock) return runLocked()
  return usesHtmlDocumentStorageV2().then(async (storageV2) => {
    if (!storageV2) return runLocked()
    // The common V2 mutation rechecks the exact canonical path while holding
    // the namespace lock. Validate first for the compatibility error shape,
    // then let that one transaction own the non-reentrant lock.
    await validate()
    return transaction()
  })
}
