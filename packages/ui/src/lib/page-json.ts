// JSON the server writes into the page it serves, read before the app renders.

/**
 * Facts the app needs for its first render, which it would otherwise request
 * after its code loads (packages/server/src/boot-facts.ts).
 */
export const BOOT_FACTS_ID = "worktable-boot"

/**
 * JSON for a raw-text script element. It never contains a literal '<', so
 * authored text cannot close the element, nor a line separator that older
 * JavaScript parsers reject.
 */
export function inlineScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
}
