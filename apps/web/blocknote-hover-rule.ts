import type { Plugin } from "vite"

const BLOCKNOTE_STYLES = /[\\/]@blocknote[\\/][^\\/]+[\\/]dist[\\/]style\.css(?:\?|$)/

// `[data-type=modification] .bn-suggestion-node:hover>*`, with or without
// the dark-theme prefix. Worktable never renders suggestion nodes.
const SUGGESTION_HOVER =
  "(?:\\.dark\\.bn-root )?\\[data-type=\"?modification\"?\\] \\.bn-suggestion-node:hover ?> ?\\*"

/**
 * Removes BlockNote's `.bn-suggestion-node:hover > *` selectors from a style
 * sheet. Chrome tracks which styles a :hover change can affect by the
 * pseudo-class alone, so a :hover rule whose subject is `*` makes every
 * hover change restyle the hovered element's whole subtree. A tap sets
 * hover on the tapped element and all its ancestors, so each tap, and each
 * row that moves under the finger, restyled the whole page.
 */
export function dropSuggestionHover(css: string): string {
  return css
    .replace(new RegExp(`,${SUGGESTION_HOVER}`, "g"), "")
    .replace(new RegExp(`${SUGGESTION_HOVER},`, "g"), "")
}

export function blocknoteHoverRule(): Plugin {
  return {
    name: "worktable-blocknote-hover-rule",
    enforce: "pre",
    transform(code, id) {
      if (!BLOCKNOTE_STYLES.test(id)) return
      const css = dropSuggestionHover(code)
      if (css === code && code.includes(".bn-suggestion-node:hover"))
        this.warn(
          "BlockNote's suggestion-node :hover rule changed shape; check that it no longer restyles every hover (blocknote-hover-rule.ts)"
        )
      return css === code ? undefined : { code: css, map: null }
    },
  }
}
