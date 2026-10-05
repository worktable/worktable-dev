import type { ExpressiveCodePlugin } from "@astrojs/starlight/expressive-code"
import { h, s } from "@astrojs/starlight/expressive-code/hast"

export interface CopyControlOptions {
  label: string
  text?: string
  source?: string
  install?: boolean
}

// The Astro components and Markdown code blocks render the same control.
export function copyControl({ label, text, source, install }: CopyControlOptions) {
  const icon = (name: string, children: ReturnType<typeof s>[]) =>
    s("svg", {
      className: `wt-copy-${name}`,
      width: 14,
      height: 14,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 2,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
    }, children)

  return h("worktable-copy", {
    hidden: true,
    "data-pagefind-ignore": "all",
    "data-copy-text": text,
    "data-copy-source": source,
    "data-copy-install": install ? "true" : undefined,
  }, [
    h("button", { type: "button", "aria-label": label }, [
      icon("icon", [
        s("rect", { width: 14, height: 14, x: 8, y: 8, rx: 2, ry: 2 }),
        s("path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" }),
      ]),
      icon("check", [s("path", { d: "m20 6-11 11-5-5" })]),
    ]),
    h("span", { className: "wt-copy-tooltip", role: "tooltip" }, label),
    h("span", { className: "wt-copy-status", role: "status", "aria-live": "polite" }),
  ])
}

export const copyButtons: ExpressiveCodePlugin = {
  name: "Worktable copy controls",
  hooks: {
    postprocessRenderedBlock: ({ codeBlock, renderData }) => {
      renderData.blockAst.children.push(copyControl({ label: "Copy example", text: codeBlock.code }))
    },
  },
}
