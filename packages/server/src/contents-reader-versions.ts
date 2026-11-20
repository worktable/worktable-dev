// Each parsing reader's version. Output kept from an older version is read
// again, so a reader that reads better bumps its number here. Shared by the
// worker that runs readers and the server that keeps their output.

export const CONTENTS_READER_VERSIONS = {
  pdf: 1,
} as const

export type ParsingReaderId = keyof typeof CONTENTS_READER_VERSIONS
