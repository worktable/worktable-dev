import {
  PUBLIC_SHARE_DIAGRAM_ATTRIBUTE,
  PUBLIC_SHARE_MERMAID_DIAGRAM,
} from "@worktable/hosted-contract"
import { getWorktableMermaidConfig } from "./theme/mermaid-config"
import { themeConfig } from "./theme/theme-config"
import { DOCUMENT_CONTENT_CSS } from "./styles/document-content.generated"

export const PUBLIC_SHARE_ASSET_PATHS = {
  fraunces: "/gateway/assets/fraunces-variable-latin.woff2",
  generalSans: "/gateway/assets/general-sans-variable.woff2",
  icon: "/gateway/assets/worktable-icon.svg",
  mermaid: "/gateway/assets/mermaid.min.js",
  diagrams: "/gateway/assets/public-share-diagrams.js",
} as const

/** The only scripts a share page may load; the gateway CSP admits these exact paths. */
export const PUBLIC_SHARE_SCRIPT_PATHS = [
  PUBLIC_SHARE_ASSET_PATHS.mermaid,
  PUBLIC_SHARE_ASSET_PATHS.diagrams,
] as const

type PublicDocumentPage =
  | {
      kind: "doc"
      format: "blocknote" | "markdown"
      title: string
      sourceUrl?: string
      projectionHtml: string
    }
  | {
      kind: "html"
      title: string
      sourceUrl?: string
      contentUrl: string
    }

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character
  )
}

function themeVariables(mode: "light" | "dark"): string {
  const colors = themeConfig.modes[mode]
  const backdrop = themeConfig.backdrop[mode]
  return `
    color-scheme: ${mode};
    --background: ${colors.canvas};
    --foreground: ${colors.foreground};
    --reading-foreground: ${colors.readingForeground};
    --card: ${colors.raised};
    --muted: ${colors.muted};
    --muted-foreground: ${colors.mutedForeground};
    --surface-tint: ${colors.decorative};
    --border: ${colors.border};
    --card-border: ${colors.cardBorder};
    --surface-hover: ${colors.surfaceHover};
    --surface-inset: ${colors.surfaceInset};
    --primary: ${themeConfig.accents.primary[mode]};
    --primary-text: ${themeConfig.accents.primaryText[mode]};
    --code-accent-foreground: ${themeConfig.accents.technicalInk[mode]};
    --code-accent-background: color-mix(in oklch, ${themeConfig.accents.technical[mode]} ${themeConfig.content.inlineCode[mode].surfaceMix}, transparent);
    --grid-line: ${backdrop.lineColor};
    --grid-wash: ${backdrop.washColor};
    --scrollbar-thumb: ${colors.scrollbarThumb};
    --scrollbar-thumb-hover: ${colors.scrollbarThumbHover};
  `
}

const PUBLIC_SHARE_CSS = `
@font-face {
  font-family: "General Sans";
  src: url("${PUBLIC_SHARE_ASSET_PATHS.generalSans}") format("woff2");
  font-style: normal;
  font-weight: 200 700;
  font-display: swap;
}
@font-face {
  font-family: Fraunces;
  src: url("${PUBLIC_SHARE_ASSET_PATHS.fraunces}") format("woff2");
  font-style: normal;
  font-weight: 300 900;
  font-display: swap;
}
:root {
  ${themeVariables("light")}
  --radius: .75rem;
  --font-sans: "General Sans", "Avenir Next", Avenir, "Segoe UI", system-ui, sans-serif;
  --font-display: Fraunces, "Iowan Old Style", "Palatino Linotype", Georgia, serif;
  --font-mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  --grid-size: ${themeConfig.backdrop.gridSize}px;
  --grid-fade-width: ${themeConfig.backdrop.fadeWidth};
  --grid-fade-height: ${themeConfig.backdrop.fadeHeight};
  --grid-fade-midpoint: ${themeConfig.backdrop.fadeMidpoint};
  --grid-fade-mid-opacity: ${themeConfig.backdrop.fadeMidOpacity};
  --grid-fade-tail: ${themeConfig.backdrop.fadeTail};
  --grid-fade-tail-opacity: ${themeConfig.backdrop.fadeTailOpacity};
  --grid-fade-stop: ${themeConfig.backdrop.fadeStop};
}
@media (prefers-color-scheme: dark) {
  :root { ${themeVariables("dark")} }
}
* { box-sizing: border-box; }
html, body { min-height: 100%; }
html { background: var(--background); }
body {
  isolation: isolate;
  margin: 0;
  min-height: 100vh;
  color: var(--foreground);
  background: var(--background);
  font: 480 1rem/1.6 var(--font-sans);
  letter-spacing: .015em;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
body::before {
  content: "";
  position: fixed;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background-image:
    linear-gradient(to right, var(--grid-line) 1px, transparent 1px),
    linear-gradient(to bottom, var(--grid-line) 1px, transparent 1px),
    radial-gradient(ellipse at 0% 100%, var(--grid-wash), transparent 100%),
    radial-gradient(ellipse at 100% 100%, var(--grid-wash), transparent 100%);
  background-size:
    var(--grid-size) var(--grid-size),
    var(--grid-size) var(--grid-size),
    100% 100%,
    100% 100%;
  -webkit-mask-image:
    radial-gradient(
      ellipse var(--grid-fade-width) var(--grid-fade-height) at 0% 100%,
      black 0%,
      rgb(0 0 0 / var(--grid-fade-mid-opacity)) var(--grid-fade-midpoint),
      rgb(0 0 0 / var(--grid-fade-tail-opacity)) var(--grid-fade-tail),
      transparent var(--grid-fade-stop)
    ),
    radial-gradient(
      ellipse var(--grid-fade-width) var(--grid-fade-height) at 100% 100%,
      black 0%,
      rgb(0 0 0 / var(--grid-fade-mid-opacity)) var(--grid-fade-midpoint),
      rgb(0 0 0 / var(--grid-fade-tail-opacity)) var(--grid-fade-tail),
      transparent var(--grid-fade-stop)
    );
  mask-image:
    radial-gradient(
      ellipse var(--grid-fade-width) var(--grid-fade-height) at 0% 100%,
      black 0%,
      rgb(0 0 0 / var(--grid-fade-mid-opacity)) var(--grid-fade-midpoint),
      rgb(0 0 0 / var(--grid-fade-tail-opacity)) var(--grid-fade-tail),
      transparent var(--grid-fade-stop)
    ),
    radial-gradient(
      ellipse var(--grid-fade-width) var(--grid-fade-height) at 100% 100%,
      black 0%,
      rgb(0 0 0 / var(--grid-fade-mid-opacity)) var(--grid-fade-midpoint),
      rgb(0 0 0 / var(--grid-fade-tail-opacity)) var(--grid-fade-tail),
      transparent var(--grid-fade-stop)
    );
}
.app-header {
  position: sticky;
  top: 0;
  z-index: 10;
  min-height: 3rem;
  display: flex;
  align-items: center;
  background: oklch(from var(--background) l c h / .75);
  -webkit-backdrop-filter: blur(28px) saturate(1.3);
  backdrop-filter: blur(28px) saturate(1.3);
}
.header-inner {
  width: 100%;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: .625rem;
  padding: .5rem clamp(.75rem, 3vw, 1.5rem);
}
.brand-mark {
  width: 1.65rem;
  height: 1.65rem;
  display: grid;
  flex: none;
  place-items: center;
}
.brand-mark svg { display: block; width: 100%; height: 100%; }
.brand-name { flex: none; font-size: .875rem; font-weight: 600; }
.header-separator { width: 1px; height: 1rem; flex: none; background: var(--border); }
.document-name {
  min-width: 0;
  overflow: hidden;
  color: var(--muted-foreground);
  font-size: .8125rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.source-link { display: inline-flex; align-items: center; flex: none; min-height: 2.75rem; margin: -.375rem 0; color: var(--primary-text); font-size: .8125rem; white-space: nowrap; text-underline-offset: .2em; }
.source-link:focus-visible { outline: 2px solid var(--primary); outline-offset: 3px; }
.view-only {
  min-height: 1.5rem;
  display: inline-flex;
  flex: none;
  align-items: center;
  margin-left: auto;
  padding: .15rem .5rem;
  border-radius: 999px;
  color: var(--muted-foreground);
  background: var(--surface-tint);
  font-size: .6875rem;
  font-weight: 600;
  letter-spacing: .02em;
}
.document-shell { width: 100%; }
.shared-document {
  width: 100%;
  max-width: 48rem;
  margin: 0 auto;
  padding: 2rem 1.5rem 5rem;
}
.shared-document .shared-diagram { position: relative; margin: 0 0 1rem; overflow-x: auto; text-align: center; contain: paint; }
.shared-document .shared-diagram svg { max-width: 100%; height: auto; }
.shared-document .shared-diagram a { color: inherit; font-weight: inherit; text-decoration: none; }
.shared-image-placeholder { display: block; padding: 1.75rem; border-radius: var(--radius); color: var(--muted-foreground); background: var(--surface-tint); text-align: center; }
${DOCUMENT_CONTENT_CSS}
.html-page { height: 100vh; overflow: hidden; }
.html-page::before { display: none; }
.html-shell { height: calc(100vh - 3rem); background: var(--background); }
.html-shell iframe { display: block; width: 100%; height: 100%; border: 0; background: var(--background); }
.unavailable-shell { min-height: calc(100vh - 3rem); display: grid; place-items: center; padding: 2rem 1.5rem 5rem; text-align: center; }
.unavailable { width: min(100%, 32rem); }
.unavailable .large-mark { width: 3.75rem; height: 3.75rem; display: grid; place-items: center; margin: 0 auto 1.5rem; }
.unavailable .large-mark svg { display: block; width: 100%; height: 100%; }
.unavailable h1 { margin: 0; font-family: var(--font-display); font-size: 1.75rem; font-weight: 400; line-height: 1.2; letter-spacing: -.02em; }
.unavailable p { max-width: 28rem; margin: .875rem auto 0; color: var(--muted-foreground); }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-thumb { border: 3px solid transparent; border-radius: 999px; background: var(--scrollbar-thumb); background-clip: padding-box; }
::-webkit-scrollbar-thumb:hover { background-color: var(--scrollbar-thumb-hover); }
@media (min-width: 40rem) {
  .shared-document { padding-right: 2rem; padding-left: 2rem; }
}
@media (min-width: 48rem) {
  .shared-document { padding-right: 3rem; padding-left: 3rem; }
}
@media (max-width: 32rem) {
  .brand-name, .header-separator { display: none; }
}
@media print {
  body::before, .app-header { display: none; }
  .shared-document { max-width: none; padding: 0; }
}
`

function header(iconSvg: string, title?: string, sourceUrl?: string): string {
  let sourceLink = ""
  if (sourceUrl) {
    try {
      const url = new URL(sourceUrl)
      if (url.protocol === "https:" && !url.username && !url.password) {
        sourceLink = `<a class="source-link" href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer">Source code</a>`
      }
    } catch {
      // Omit invalid links from callers outside the validated share contract.
    }
  }
  return `<header class="app-header"><div class="header-inner"><span class="brand-mark" aria-hidden="true">${iconSvg}</span><span class="brand-name">Worktable</span>${title ? `<span class="header-separator" aria-hidden="true"></span><span class="document-name">${escapeHtml(title)}</span><span class="view-only">View only</span>` : ""}${sourceLink}</div></header>`
}

function pageDocument(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <link rel="icon" href="${PUBLIC_SHARE_ASSET_PATHS.icon}" type="image/svg+xml">
  <title>${escapeHtml(title)} · Worktable</title>
  <style>${PUBLIC_SHARE_CSS}</style>
</head>
${body}
</html>`
}

/** Load the diagram renderer only on Docs whose projection carries diagrams. */
function diagramScripts(projectionHtml: string): string {
  // Text escapes "<", so this matches only a diagram element, never prose.
  if (
    !projectionHtml.includes(
      `<pre ${PUBLIC_SHARE_DIAGRAM_ATTRIBUTE}="${PUBLIC_SHARE_MERMAID_DIAGRAM}">`
    )
  ) {
    return ""
  }
  const configs = JSON.stringify({
    light: getWorktableMermaidConfig("light"),
    dark: getWorktableMermaidConfig("dark"),
  }).replace(/</g, "\\u003c")
  return `<script type="application/json" id="worktable-diagram-config">${configs}</script>${PUBLIC_SHARE_SCRIPT_PATHS.map((path) => `<script src="${path}" defer></script>`).join("")}`
}

export function renderPublicDocumentPage(
  document: PublicDocumentPage,
  iconSvg: string
): string {
  if (document.kind === "doc") {
    return pageDocument(
      "Shared document",
      `<body>${header(iconSvg, document.title, document.sourceUrl)}<main class="document-shell"><article class="shared-document worktable-markdown ${document.format}">${document.projectionHtml}</article></main>${diagramScripts(document.projectionHtml)}</body>`
    )
  }

  return pageDocument(
    "Shared HTML document",
    `<body class="html-page">${header(iconSvg, document.title, document.sourceUrl)}<main class="html-shell"><iframe title="${escapeHtml(document.title)}" src="${escapeHtml(document.contentUrl)}" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"></iframe></main></body>`
  )
}

export function renderPublicShareUnavailablePage(iconSvg: string): string {
  return pageDocument(
    "Document unavailable",
    `<body>${header(iconSvg)}<main class="unavailable-shell"><section class="unavailable"><span class="large-mark" aria-hidden="true">${iconSvg}</span><h1>This document isn't available</h1><p>The link may have been stopped, or the document may no longer exist.</p></section></main></body>`
  )
}
