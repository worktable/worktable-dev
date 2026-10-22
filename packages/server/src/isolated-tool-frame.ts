import { themeConfig } from "@worktable/ui/theme"
import type { ToolHostConfig } from "../../ui/src/tool-runtime/broker.ts"
import manifest from "../../ui/src/tool-runtime/generated/manifest.json"

function palette(mode: "light" | "dark"): string {
  const colors = themeConfig.modes[mode]
  const values = {
    bg: colors.canvas,
    surface: colors.panel,
    "surface-2": colors.raised,
    text: colors.foreground,
    muted: colors.mutedForeground,
    border: colors.border,
    accent: themeConfig.accents.primaryText[mode],
    "accent-soft": colors.controlActive,
    danger: themeConfig.status.destructive[mode],
    warning: themeConfig.status.warning[mode],
    success: themeConfig.status.success[mode],
  }
  return `html[data-theme="${mode}"]{color-scheme:${mode};${Object.entries(
    values
  )
    .map(([name, value]) => `--ad-${name}:${value}`)
    .join(";")}}`
}

const styles = `${palette("light")}${palette("dark")}
html,body{margin:0;min-height:100%;background:var(--ad-bg);color:var(--ad-text)}
:root{--font-sans:"General Sans",system-ui,sans-serif;--font-display:Fraunces,Georgia,serif;--font-mono:ui-monospace,monospace}
#worktable-tool-notice{margin:0;padding:12px;color:var(--ad-muted)}
#worktable-tool-notice:empty{display:none}`

/** Always creates a new document. No authored element, style rule, metadata,
 * script attribute or URL can enter the trusted browser DOM. */
export function isolatedToolFrame(
  source: string,
  config: ToolHostConfig,
  options: { theme: "light" | "dark"; hostStyles: string }
): string {
  const serialized = JSON.stringify({ ...config, source }).replaceAll(
    "<",
    "\\u003c"
  )
  return `<!doctype html><html data-theme="${options.theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${options.hostStyles}<style>${styles}</style></head><body><main id="worktable-tool"></main><p id="worktable-tool-notice" role="status" aria-live="polite"></p><script type="application/json" id="worktable-tool-config">${serialized}</script><script src="${manifest.path}" defer></script></body></html>`
}

export function isolatedToolCsp(options: {
  assetOrigin: string
  parentOrigin: string
  fontSources?: string[]
}): string {
  const asset = new URL(manifest.path, options.assetOrigin).href
  const parent = new URL(options.parentOrigin).origin
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src ${asset} 'wasm-unsafe-eval'`,
    "worker-src blob:",
    "style-src 'unsafe-inline'",
    "connect-src 'none'",
    "img-src 'none'",
    `font-src ${options.fontSources?.join(" ") || "'none'"}`,
    "frame-src 'none'",
    `frame-ancestors ${parent}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ")
}
