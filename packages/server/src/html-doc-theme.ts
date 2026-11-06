import { HTML_DOC_THEME } from "@worktable/ui/lib/html-doc-theme.generated"
import { DRAWING_FONTS } from "@worktable/ui/lib/drawing-fonts"

type Mode = keyof typeof HTML_DOC_THEME
type Tokens = Record<string, string>

const FONTS = {
  "font-sans": DRAWING_FONTS.sans,
  "font-display": `"Fraunces",${DRAWING_FONTS.serif}`,
  "font-mono": `"JetBrains Mono",${DRAWING_FONTS.mono}`,
}

/** Names HTML Docs written before the theme used. They carry literal values,
 * never var() references, so a page that maps its own names onto them
 * (`--background: var(--ad-bg)`) cannot form a cycle. */
const LEGACY_NAMES: Record<string, string> = {
  "ad-bg": "background",
  "ad-surface": "card",
  "ad-surface-2": "secondary",
  "ad-text": "foreground",
  "ad-muted": "muted-foreground",
  "ad-border": "border",
  "ad-accent": "primary-text",
  "ad-danger": "destructive",
  "ad-warning": "warning",
  "ad-success": "success",
  "ad-shadow": "shadow",
}

const RADIUS = "0.75rem"

function modeTokens(mode: Mode): Tokens {
  const theme: Tokens = HTML_DOC_THEME[mode]
  const tokens: Tokens = { ...theme }
  for (const [legacy, role] of Object.entries(LEGACY_NAMES)) {
    tokens[legacy] = theme[role]!
  }
  tokens["ad-accent-soft"] =
    `color-mix(in oklch, ${theme["primary-text"]} 14%, transparent)`
  return tokens
}

function declarations(tokens: Tokens): string {
  return Object.entries(tokens)
    .map(([name, value]) => `--${name}:${value};`)
    .join("")
}

// Paint, type and the padding bare tables and controls need; no layout, so a
// page's own design keeps its shape. Inherited text styles sit on :root, so
// a page's own html or body rules still reach every element. Font size stays
// on body, so rem keeps its meaning. Only the page title takes the display
// font: lower headings are often labels in a tool.
const BASE = `:root{color:var(--foreground);font-family:var(--font-sans);line-height:1.55}
body{background:var(--background);font-size:15px}
h1{font-family:var(--font-display);font-weight:600;line-height:1.2;text-wrap:balance}
h2,h3,h4,h5,h6{font-weight:600;text-wrap:balance}
a{color:var(--primary-text)}
::selection{background:color-mix(in oklch,var(--primary) 28%,transparent)}
mark{background:color-mix(in oklch,var(--warning) 30%,transparent);color:inherit}
hr{border:0;border-top:1px solid var(--border)}
code,kbd,samp,pre{font-family:var(--font-mono);font-size:0.9em}
:not(pre)>code,kbd{background:var(--muted);border-radius:0.3em;padding:0.1em 0.3em}
pre{background:var(--muted);border-radius:calc(var(--radius) * 0.8);padding:0.75em 1em;overflow:auto}
table{border-collapse:collapse}
th,td{border-bottom:1px solid var(--border);padding:0.45em 1em 0.45em 0}
th{text-align:start}
th{color:var(--muted-foreground);font-weight:600}
button,select,textarea,input:not([type=checkbox],[type=radio],[type=range],[type=color],[type=file],[type=image]){color:inherit;background:var(--well-bg);border:1px solid var(--input);border-radius:calc(var(--radius) * 0.6);padding:0.35em 0.75em}
button:not(:disabled):hover,select:not(:disabled):hover{background:var(--well-hover-bg);border-color:var(--input-hover)}
:disabled{color:var(--muted-foreground);cursor:default}
input::placeholder,textarea::placeholder{color:var(--muted-foreground)}
input,select,textarea,progress,meter{accent-color:var(--primary)}
:root{scrollbar-color:color-mix(in oklch,var(--foreground) 22%,transparent) transparent}`

/**
 * The theme and base styles every HTML Doc gets, in the lowest cascade layer,
 * so any rule the page writes wins. `attribute` follows the data-theme
 * Worktable sets; `system` follows the reader's system theme, for pages served
 * without a script to set it. Dark values apply on screen only, so a page
 * always prints light.
 */
function renderHtmlDocThemeCss(variant: "attribute" | "system"): string {
  const light = declarations({
    ...modeTokens("light"),
    ...FONTS,
    radius: RADIUS,
    "ad-radius": RADIUS,
  })
  const dark = declarations(modeTokens("dark"))
  const darkRule =
    variant === "attribute"
      ? `@media screen{html[data-theme="dark"]{${dark}}}`
      : `@media screen and (prefers-color-scheme:dark){:root{${dark}}}`
  return `@layer worktable{:root{${light}}\n${darkRule}\n${BASE}}`
}

const THEME_CSS = {
  attribute: renderHtmlDocThemeCss("attribute"),
  system: renderHtmlDocThemeCss("system"),
}

export function buildHtmlDocThemeCss(variant: "attribute" | "system"): string {
  return THEME_CSS[variant]
}

/** Native controls and scrollbars follow the theme the page is shown in, even
 * when a page declares both schemes. This sits outside the layer on purpose. */
export const HTML_DOC_COLOR_SCHEME_CSS = `html[data-theme="light"]{color-scheme:light}
@media screen{html[data-theme="dark"]{color-scheme:dark}}
@media print{html{color-scheme:light}}`
