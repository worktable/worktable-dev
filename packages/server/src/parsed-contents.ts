// ============================================================
// Contents of files a reader parses, read from the store
// ============================================================
//
// A PDF's contents are parsed once per version, in the contents lane, and
// kept in the derived store; every read pages them from there. A read of a
// version not parsed yet asks the lane for it and waits a while: most files
// finish inside that, and one that doesn't reads as pending, with the parse
// still going, so the next read finds it. One parse runs per version however
// many ask. Waiting inside the request also keeps a Cloud machine awake
// while the parse runs.
//
// What ends a parse decides what is kept. A reader's contents, and a file it
// refused (encrypted, damaged) or stopped on (time, memory, output), are
// kept for that version, so the next read needn't parse again. A lane that
// was busy, a file that couldn't be read, or a reader switched off are
// answered as they are and tried again on the next read.

import { contentsPageFromStore } from "./contents-pages.ts"
import { parseInLane, type ParsingResult } from "./contents-lane.ts"
import {
  CONTENTS_READER_VERSIONS,
  type ParsingReaderId,
} from "./contents-reader-versions.ts"
import { readCurrentFileSource, type CurrentFileSource } from "./current-file-source.ts"
import { derivedStore, type DerivedKey } from "./derived-store.ts"
import type { ContentsPage } from "./file-contents.ts"
import { contentHashOf, pinnedFileStream, sha256Check, type PinnedFile } from "./file-revision.ts"

/** How long a read waits for a parse before it answers pending. */
export const PARSE_WAIT_MS = 20_000

const parsing = new Map<string, Promise<ParsingResult>>()

function keyId(key: DerivedKey): string {
  return JSON.stringify([key.documentId, key.version, key.maker, key.makerVersion])
}

/** Whether how a parse ended belongs to the file, so it is kept for it. */
function keptFor(result: ParsingResult): boolean {
  return result.kind !== "failed" || !["busy", "source", "off"].includes(result.why)
}

/**
 * Parses one version of a file in the lane and keeps how it ended; a
 * version already being parsed shares that parse.
 */
export function parseVersion(
  key: DerivedKey,
  pinned: PinnedFile,
  priority: "waiting" | "background"
): Promise<ParsingResult> {
  const id = keyId(key)
  const running = parsing.get(id)
  if (running) return running
  const hex = Buffer.from(key.version, "base64url").toString("hex")
  const job = parseInLane({
    reader: key.maker,
    priority,
    owner: key.spaceId,
    bytes: async (write) => {
      // The bytes parsed are the version the output is kept for.
      for await (const chunk of pinnedFileStream(pinned, 0, pinned.size, sha256Check(hex))) {
        await write(chunk)
      }
    },
  })
    .then((result) => {
      if (keptFor(result)) {
        const store = derivedStore()
        store.putContents(
          key,
          result.kind === "ok"
            ? { state: "ready", output: result.output }
            : result.kind === "refused"
              ? { state: "refused", reason: result.reason, message: result.message }
              : { state: "failed", message: result.message }
        )
        store.keepOnlyVersion(key.spaceId, key.documentId, key.version)
      }
      return result
    })
    .finally(() => parsing.delete(id))
  parsing.set(id, job)
  return job
}

/** The key a file's parsed contents are kept under, at its current version. */
async function contentsKey(
  spaceId: string,
  file: CurrentFileSource,
  reader: ParsingReaderId
): Promise<DerivedKey> {
  return {
    spaceId,
    documentId: file.current.documentId,
    version: await contentHashOf(file.current.pinned),
    kind: "contents",
    variant: "",
    maker: reader,
    makerVersion: CONTENTS_READER_VERSIONS[reader],
  }
}

/**
 * One page of a parsed file's contents at its current version, parsing it
 * first when needed; null when `path` names no plain file.
 */
export async function readParsedContents(options: {
  spaceId: string
  path: string
  reader: ParsingReaderId
  offset?: number
  limit?: number
}): Promise<(CurrentFileSource & { contents: ContentsPage }) | null> {
  const file = await readCurrentFileSource({ spaceId: options.spaceId, path: options.path })
  if (!file) return null
  const key = await contentsKey(options.spaceId, file, options.reader)
  const store = derivedStore()
  if (!store.getContents(key)) {
    // Held by a timer the read owns: Bun 1.3 can collect an unreferenced
    // AbortSignal.timeout before it fires.
    let timer: ReturnType<typeof setTimeout> | undefined
    const waited = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), PARSE_WAIT_MS)
    })
    const result = await Promise.race([
      parseVersion(key, file.current.pinned, "waiting"),
      waited,
    ]).finally(() => clearTimeout(timer))
    if (result && !keptFor(result) && result.kind === "failed") {
      return {
        ...file,
        contents: {
          state: "failed",
          text: "",
          startLine: options.offset ?? 1,
          endLine: (options.offset ?? 1) - 1,
          totalLines: 0,
          missing: [{ why: result.message }],
        },
      }
    }
  }
  return {
    ...file,
    contents: contentsPageFromStore(store, key, options.offset, options.limit),
  }
}
