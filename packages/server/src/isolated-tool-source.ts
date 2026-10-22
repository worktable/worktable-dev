import { Parser } from "htmlparser2"

export const ISOLATED_TOOL_SCRIPT_TYPE = "application/worktable"
export const MAX_ISOLATED_TOOL_SOURCE_BYTES = 512 * 1024

export class IsolatedToolSourceError extends Error {
  readonly code = "INVALID_TOOL_SOURCE"
}

/** Extract only inert VM source. Callers build a new trusted document; none of
 * the surrounding authored HTML, styles or attributes belong in its DOM. */
export function isolatedToolSource(html: string): string | null {
  let scripts = 0
  let isolatedScripts = 0
  let collecting = false
  let source = ""
  let bytes = 0
  let external = false
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (name !== "script") return
        scripts++
        collecting =
          attributes.type?.trim().toLowerCase() === ISOLATED_TOOL_SCRIPT_TYPE
        if (!collecting) return
        isolatedScripts++
        if (Object.hasOwn(attributes, "src")) external = true
      },
      ontext(text) {
        if (!collecting) return
        bytes += Buffer.byteLength(text, "utf8")
        if (bytes > MAX_ISOLATED_TOOL_SOURCE_BYTES)
          throw new IsolatedToolSourceError("The tool source exceeds 512 KiB.")
        source += text
      },
      onclosetag(name) {
        if (name === "script") collecting = false
      },
    },
    { decodeEntities: false }
  )
  parser.end(html)
  if (isolatedScripts === 0) return null
  if (isolatedScripts !== 1 || scripts !== 1 || external)
    throw new IsolatedToolSourceError(
      "Use one application/worktable script with bundled code."
    )
  if (!source.trim())
    throw new IsolatedToolSourceError("The tool script is empty.")
  return source
}
