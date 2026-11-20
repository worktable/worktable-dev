// How much of a file's contents one read gives. Kept apart from the readers
// so tool schemas can state them without loading any reader.

/**
 * The most text one page carries. Dense text such as a log runs to about
 * 2.5 characters a token, so this stays under the 25,000 tokens Claude Code
 * takes from one tool result.
 */
export const CONTENTS_PAGE_MAX_BYTES = 32 * 1024
/** Lines a page holds when the reader asks for no number. */
export const CONTENTS_DEFAULT_LINES = 1000
/** The most lines a reader may ask for in one page. */
export const CONTENTS_MAX_LINES = 10_000

/**
 * The most of a file's text one exact or regex search reads: the same bound
 * a Doc's projection reads. A larger file is listed as skipped, for a
 * download.
 */
export const GREP_FILE_MAX_BYTES = 8 * 1024 * 1024
