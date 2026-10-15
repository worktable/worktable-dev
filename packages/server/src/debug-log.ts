import { createHmac, randomBytes } from "node:crypto"

/**
 * Verbose development logging. `WORKTABLE_DEBUG=1` logs every request and
 * every watcher event; otherwise the server logs only slow or failed requests.
 * Guard call sites with this flag so disabled logging builds no strings.
 */
export const debugLogging = process.env["WORKTABLE_DEBUG"] === "1"

// Logs carry codes, opaque ids, counts and route templates, never document
// paths, titles or text. Paths are made from titles, and error messages often
// quote a path, so both are kept out unless debug logging is on.

const documentKey = randomBytes(16)

/**
 * How a log line names a document: `space/path` under debug logging,
 * otherwise an opaque id that is stable while this process runs, so lines
 * about one document can still be matched up.
 */
export function logDocument(spaceId: string, docPath: string): string {
  const name = `${spaceId}/${docPath}`
  if (debugLogging) return name
  return `doc:${createHmac("sha256", documentKey).update(name).digest("hex").slice(0, 12)}`
}

/**
 * How a log line describes an error: its class, its code, such as ENOENT,
 * and its stack frames. The message can quote a path or a title, so only
 * debug logging adds it.
 */
export function logError(error: unknown): string {
  if (!(error instanceof Error)) {
    return debugLogging ? String(error) : typeof error
  }
  const code = (error as { code?: unknown }).code
  const head = `${error.name}${typeof code === "string" ? ` ${code}` : ""}`
  return `${head}${debugLogging ? `: ${error.message}` : ""}${stackFrames(error)}`
}

/**
 * The frames after the stack's first line, which repeats the message. A
 * stack that does not start with the message is left out: frames cannot be
 * told apart from message lines that look like them.
 */
function stackFrames(error: Error): string {
  const stack = error.stack ?? ""
  const header = error.message ? `${error.name}: ${error.message}` : error.name
  if (!stack.startsWith(`${header}\n`)) return ""
  return stack.slice(header.length)
}
