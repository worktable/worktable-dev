/**
 * Verbose development logging. `WORKTABLE_DEBUG=1` logs every request and
 * every watcher event; otherwise the server logs only slow or failed requests.
 * Guard call sites with this flag so disabled logging builds no strings.
 */
export const debugLogging = process.env["WORKTABLE_DEBUG"] === "1"
