import { themeConfig } from "../theme/theme-config.ts"
import type { ToolHostConfig } from "./broker.ts"
import manifest from "./generated/manifest.json"

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
html{font-family:var(--font-sans)}\n*,*::before,*::after{box-sizing:border-box}\nbutton,input,select,textarea{font:inherit}\n:focus-visible{outline:2px solid var(--ad-accent);outline-offset:2px}\nhtml,body{margin:0;min-height:100%;background:var(--ad-bg);color:var(--ad-text)}
:root{--font-sans:"General Sans",system-ui,sans-serif;--font-display:Fraunces,Georgia,serif;--font-mono:ui-monospace,monospace}
#worktable-tool-notice{margin:0;padding:12px;color:var(--ad-muted)}
#worktable-tool-notice:empty{display:none}`

/** Always creates a new document. No authored element, style rule, metadata,
 * script attribute or URL can enter the trusted browser DOM. */
export function isolatedToolFrame(
  source: string,
  config: ToolHostConfig,
  options: { theme: "light" | "dark"; fontStyles: string; assetPrefix?: string }
): string {
  const serialized = JSON.stringify({ ...config, source }).replaceAll(
    "<",
    "\\u003c"
  )
  return `<!doctype html><html data-theme="${options.theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${options.fontStyles}\n${styles}</style></head><body><main id="worktable-tool"></main><p id="worktable-tool-notice" role="status" aria-live="polite"></p><script type="application/json" id="worktable-tool-config">${serialized}</script><script src="${options.assetPrefix ?? ""}${manifest.path}" defer></script></body></html>`
}

export function isolatedToolCsp(options: {
  assetOrigin: string
  assetPrefix?: string
  parentOrigin: string | null
  fontSources?: string[]
}): string {
  const asset = new URL(
    `${options.assetPrefix ?? ""}${manifest.path}`,
    options.assetOrigin
  ).href
  const parent = options.parentOrigin
    ? new URL(options.parentOrigin).origin
    : "'none'"
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
