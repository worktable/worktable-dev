// The readers the contents worker runs, by name. Each parses one family of
// formats from bytes alone; the file type table's contents surface names
// which one a file gets. Loaded only by the worker.

import type { ParsingReader } from "./contents-protocol.ts"

export const CONTENTS_READERS: Readonly<Record<string, ParsingReader>> = {}
