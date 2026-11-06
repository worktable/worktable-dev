import { HTML_DOC_THEME } from "@worktable/ui/lib/html-doc-theme.generated"
import { DRAWING_FONTS } from "@worktable/ui/lib/drawing-fonts"

type Mode = keyof typeof HTML_DOC_THEME
type Tokens = Record<string, string>

// Noto Sans goes ahead of the shared fallbacks, whose first face is the emoji
// font. Where the served fonts don't load, a system emoji font answers for
// digits too, and numbers come out widely spaced.
const SANS = DRAWING_FONTS.sans.replace(
  /^"General Sans",/,
  '"General Sans","Noto Sans",'
)
if (SANS === DRAWING_FONTS.sans)
  throw new Error("The sans stack no longer starts with General Sans")

const FONTS = {
  "font-sans": SANS,
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
// font: lower headings are often labels in a tool. Weight, tracking and
// smoothing match the app's body text (globals.css) and Docs; the title
// matches the app's page titles (Fraunces, semibold, tracking-tight). Fills and lines mix from
// the text color, so they suit a page that paints its own palette in only
// one mode.
const BASE = `:root{color:var(--foreground);font-family:var(--font-sans);font-weight:480;letter-spacing:0.02em;line-height:1.6;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;scrollbar-color:color-mix(in oklch,currentColor 22%,transparent) transparent}
body{background:var(--background);font-size:15px}
h1,h2,h3,h4,h5,h6{font-weight:600;letter-spacing:-0.005em;text-wrap:balance}
h1{font-family:var(--font-display);font-size:clamp(1.65rem,1.3rem + 1.2vw,2rem);letter-spacing:-0.025em;line-height:1.25}
a{color:var(--primary-text)}
::selection{background:color-mix(in oklch,var(--primary) 28%,transparent)}
mark{background:color-mix(in oklch,var(--warning) 30%,transparent);color:inherit}
hr{border:0;border-top:1px solid color-mix(in oklch,currentColor 16%,transparent)}
code,kbd,samp,pre{font-family:var(--font-mono);font-size:0.9em;letter-spacing:normal}
:not(pre)>code,kbd{background:color-mix(in oklch,currentColor 10%,transparent);border-radius:0.3em;padding:0.1em 0.3em}
pre{background:color-mix(in oklch,currentColor 8%,transparent);border-radius:calc(var(--radius) * 0.8);padding:0.75em 1em;overflow:auto}
table{border-collapse:collapse}
th,td{border-bottom:1px solid color-mix(in oklch,currentColor 14%,transparent);padding:0.45em 1em 0.45em 0}
th{text-align:start;color:color-mix(in oklch,currentColor 70%,transparent);font-weight:600}
:where(button,select,textarea,input:not([type=checkbox],[type=radio],[type=range],[type=color],[type=file],[type=image])){color:inherit;background:color-mix(in oklch,currentColor 5%,transparent);border:1px solid color-mix(in oklch,currentColor 16%,transparent);border-radius:calc(var(--radius) * 0.6);padding:0.35em 0.75em}
button:not(:disabled):hover,select:not(:disabled):hover{background:color-mix(in oklch,currentColor 9%,transparent);border-color:color-mix(in oklch,currentColor 26%,transparent)}
:disabled{color:color-mix(in oklch,currentColor 50%,transparent);cursor:default}
input::placeholder,textarea::placeholder{color:color-mix(in oklch,currentColor 55%,transparent)}
input,select,textarea,progress,meter{accent-color:var(--primary)}
svg[data-icon]{vertical-align:-0.125em;flex-shrink:0}`

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
