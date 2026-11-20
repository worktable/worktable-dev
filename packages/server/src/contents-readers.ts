// The readers the contents worker runs, by name. Each parses one family of
// formats from bytes alone; the file type table's contents surface names
// which one a file gets. Loaded only by the worker.

import type { ParsingReader } from "./contents-protocol.ts"
import type { ParsingReaderId } from "./contents-reader-versions.ts"
import { pdfReader } from "./pdf-contents-reader.ts"

export const CONTENTS_READERS: Readonly<Record<ParsingReaderId, ParsingReader>> = {
  pdf: pdfReader,
}
