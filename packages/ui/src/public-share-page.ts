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
  live: "/gateway/assets/public-share-live.js",
  comments: "/gateway/assets/public-share-comments.js",
  commentCheck: "/gateway/assets/public-share-comment-check.js",
} as const

export const PUBLIC_SHARE_COMMENT_CHECK_PATH = "/gateway/comment-check"

/** Loaded only on Docs whose projection carries diagrams. */
const DIAGRAM_SCRIPT_PATHS = [
  PUBLIC_SHARE_ASSET_PATHS.mermaid,
  PUBLIC_SHARE_ASSET_PATHS.diagrams,
] as const

/** The only scripts a share page may load; the gateway CSP admits these exact paths. */
export const PUBLIC_SHARE_SCRIPT_PATHS = [
  ...DIAGRAM_SCRIPT_PATHS,
  PUBLIC_SHARE_ASSET_PATHS.comments,
] as const

/** The comment panel's settings, on a page whose link takes comments. */
export interface PublicShareCommentsPage {
  /** The link's digest, which keys the visitor's storage and the human check. */
  link: string
  /** The trusted check page on the separate content origin. */
  checkUrl: string
  accepting: boolean
  anonymousAllowed: boolean
  visitorsSee: "own" | "all"
}

/** A live link's page admits its broker as well, and only it does. */
export const PUBLIC_SHARE_LIVE_SCRIPT_PATHS = [
  ...PUBLIC_SHARE_SCRIPT_PATHS,
  PUBLIC_SHARE_ASSET_PATHS.live,
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
  const finish = themeConfig.finishes[mode]
  const elevation = themeConfig.elevation[mode]
  const backdrop = themeConfig.backdrop[mode]
  return `
    color-scheme: ${mode};
    --background: ${colors.canvas};
    --field: ${colors.field};
    --border-input: ${colors.borderInput};
    --border-input-hover: ${colors.borderInputHover};
    --foreground: ${colors.foreground};
    --reading-foreground: ${colors.readingForeground};
    --card: ${colors.raised};
    --muted: ${colors.muted};
    --muted-foreground: ${colors.mutedForeground};
    --surface-tint: ${colors.decorative};
    --border: ${colors.border};
    --overlay: ${colors.overlay};
    --overlay-border: ${colors.overlayBorder};
    --floating-shadow: ${elevation.floatingShadow};
    --card-border: ${colors.cardBorder};
    --surface-hover: ${colors.surfaceHover};
    --surface-inset: ${colors.surfaceInset};
    --primary: ${themeConfig.accents.primary[mode]};
    --primary-text: ${themeConfig.accents.primaryText[mode]};
    --primary-top: ${finish.primaryFaceTop};
    --primary-bottom: ${finish.primaryFaceBottom};
    --primary-highlight: ${finish.primaryHighlight};
    --primary-edge: ${finish.primaryEdge};
    --primary-shadow: ${finish.primaryShadow};
    --contrast: ${colors.contrastForeground};
    --destructive: ${themeConfig.status.destructive[mode]};
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
body:not(.html-page) { display: flex; flex-direction: column; }
body:not(.html-page) > main { flex: 1 0 auto; }
.share-footer { display: flex; justify-content: center; min-height: 2.5rem; align-items: center; }
.share-footer a { color: var(--muted-foreground); font-size: .75rem; text-underline-offset: .2em; }
.share-footer a:hover { color: var(--foreground); }
.share-footer a:focus-visible { outline: 2px solid var(--primary); outline-offset: 3px; }
.html-page .share-footer { min-height: 2rem; height: 2rem; }
.html-page.has-footer .html-shell { height: calc(100vh - 5rem); }
.html-shell iframe { display: block; width: 100%; height: 100%; border: 0; background: var(--background); }
.unavailable-shell { min-height: calc(100vh - 3rem); display: grid; place-items: center; padding: 2rem 1.5rem 5rem; text-align: center; }
.unavailable { width: min(100%, 32rem); }
.unavailable .large-mark { width: 3.75rem; height: 3.75rem; display: grid; place-items: center; margin: 0 auto 1.5rem; }
.unavailable .large-mark svg { display: block; width: 100%; height: 100%; }
.unavailable h1 { margin: 0; font-family: var(--font-display); font-size: 1.75rem; font-weight: 400; line-height: 1.2; letter-spacing: -.02em; }
.unavailable p { max-width: 28rem; margin: .875rem auto 0; color: var(--muted-foreground); }
.comment-toggle, .comment-retry { min-height: 2rem; display: inline-flex; flex: none; align-items: center; margin-left: auto; padding: 0 .75rem; border: 1px solid var(--border-input); border-radius: .625rem; color: var(--foreground); background: var(--field); font: inherit; font-size: .8125rem; font-weight: 550; cursor: pointer; }
.comment-retry { margin-left: 0; }
.comment-more { min-height: 2.75rem; margin-top: .75rem; }
.comment-read-error { margin-top: 1rem; }
.comment-read-error[hidden] { display: none; }
.comment-read-error .comment-status { margin-bottom: .5rem; }
.comment-toggle[hidden], .comment-retry[hidden] { display: none; }
.comment-toggle:hover, .comment-retry:hover { border-color: var(--border-input-hover); background: var(--muted); }
.comment-toggle[aria-expanded="true"] { background: var(--muted); }
.comment-toggle:focus-visible, .comment-retry:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.comments-panel { position: fixed; z-index: 20; top: 3.75rem; right: .75rem; bottom: .75rem; width: min(23rem, calc(100vw - 1.5rem)); display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--overlay-border); border-radius: var(--radius); color: var(--foreground); background: var(--overlay); box-shadow: var(--floating-shadow); }
.comments-panel[hidden] { display: none; }
.comments-head { display: flex; flex: none; align-items: center; justify-content: space-between; gap: .5rem; padding: .625rem .625rem .375rem 1rem; }
.comments-head h2 { margin: 0; font-size: .9375rem; font-weight: 600; }
.comments-close { width: 2rem; height: 2rem; display: grid; place-items: center; padding: 0; border: 0; border-radius: .5rem; color: var(--muted-foreground); background: transparent; font: inherit; font-size: 1.25rem; line-height: 1; cursor: pointer; }
.comments-close:hover { color: var(--foreground); background: var(--muted); }
.comments-close:focus-visible { outline: 2px solid var(--primary); outline-offset: 1px; }
.comments-body { flex: 1; min-height: 0; overflow-y: auto; padding: .25rem 1rem 1rem; }
.comment-form { display: flex; flex-direction: column; gap: .875rem; }
.comment-field { display: flex; flex-direction: column; gap: .375rem; }
.comment-field[hidden] { display: none; }
.comment-field label { font-size: .8125rem; font-weight: 550; }
.comment-label-row { display: flex; align-items: baseline; justify-content: space-between; gap: .5rem; }
.comment-count { color: var(--muted-foreground); font-size: .75rem; font-variant-numeric: tabular-nums; }
.comment-form input[type="text"], .comment-form textarea { width: 100%; padding: .5rem .75rem; border: 1px solid var(--border-input); border-radius: .625rem; color: var(--foreground); background: var(--field); font: inherit; font-size: .9375rem; }
.comment-form input[type="text"] { height: 2.5rem; }
.comment-form textarea { min-height: 7.5rem; resize: vertical; line-height: 1.5; }
.comment-form input[type="text"]:hover, .comment-form textarea:hover { border-color: var(--border-input-hover); }
.comment-form input[type="text"]:focus, .comment-form textarea:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px color-mix(in oklch, var(--primary) 30%, transparent); }
.comment-check { display: flex; align-items: center; gap: .5rem; font-size: .875rem; cursor: pointer; }
.comment-check[hidden] { display: none; }
.comment-check-frame { display: block; width: 100%; height: 96px; border: 0; }
.comment-check input { width: 1rem; height: 1rem; margin: 0; accent-color: var(--primary); }
.comment-note, .comment-closed { margin: 0; color: var(--muted-foreground); font-size: .8125rem; line-height: 1.5; }
.comment-closed { padding: .5rem 0; font-size: .875rem; }
.comment-status { margin: 0; color: var(--muted-foreground); font-size: .875rem; }
.comment-status:empty, .comment-turnstile:empty { display: none; }
.comment-status.comment-error { color: var(--destructive); }
.comment-send { align-self: flex-end; height: 2.5rem; padding: 0 1.25rem; border: 1px solid transparent; border-radius: var(--radius); color: var(--contrast); background: linear-gradient(to bottom, var(--primary-top), var(--primary-bottom)); box-shadow: inset 0 1px 0 var(--primary-highlight), 0 2px 0 var(--primary-edge), 0 5px 9px -5px var(--primary-shadow); font: inherit; font-size: .9375rem; font-weight: 500; cursor: pointer; }
.comment-send:hover:not(:disabled) { filter: brightness(1.035); }
.comment-send:disabled { opacity: .65; cursor: default; }
.comment-send:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.comment-list-section { margin-top: 1.5rem; }
.comment-list-section[hidden] { display: none; }
.comment-list-section h3 { margin: 0 0 .25rem; color: var(--muted-foreground); font-size: .8125rem; font-weight: 600; }
.comment-list { margin: 0; padding: 0; list-style: none; }
.comment-item { padding: .75rem 0; border-top: 1px solid var(--border); }
.comment-meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: .375rem .5rem; color: var(--muted-foreground); font-size: .75rem; }
.comment-author { color: var(--foreground); font-size: .8125rem; font-weight: 600; overflow-wrap: anywhere; }
.comment-you { padding: 0 .375rem; border-radius: 999px; background: var(--surface-tint); font-weight: 600; }
.comment-text { margin: .25rem 0 0; color: var(--reading-foreground); font-size: .9375rem; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.comment-reply { margin-top: .625rem; padding-left: .75rem; border-left: 2px solid color-mix(in oklch, var(--primary) 45%, transparent); }
.comment-reply-from { color: var(--muted-foreground); font-size: .75rem; font-weight: 600; }
@media (min-width: 64rem) {
  .comments-open .document-shell { padding-right: 24.5rem; }
  .comments-open .html-shell { margin-right: 24.5rem; }
}
@media (max-width: 40rem) {
  .comments-panel { top: auto; right: .5rem; bottom: .5rem; left: .5rem; width: auto; max-height: min(85vh, 40rem); }
}
@media print {
  .comments-panel, .comment-toggle { display: none; }
  .comments-open .document-shell { padding-right: 0; }
  .comments-open .html-shell { margin-right: 0; }
}
.unavailable button { padding: 0; border: 0; color: var(--primary-text); background: none; font: inherit; font-weight: 500; text-decoration: underline; text-decoration-color: color-mix(in oklch, var(--primary) 40%, transparent); text-underline-offset: 2px; cursor: pointer; }
.unavailable button:hover { text-decoration-color: var(--primary); }
.unavailable button:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; border-radius: .125rem; }
.html-shell .unavailable-shell { min-height: 100%; }
.live-link-prompt { position: fixed; bottom: 1.5rem; left: 50%; z-index: 20; display: flex; align-items: center; gap: .5rem; width: max-content; max-width: calc(100vw - 2rem); padding: .5rem .5rem .5rem 1rem; transform: translateX(-50%); border: 1px solid var(--overlay-border); border-radius: var(--radius); color: var(--foreground); background: var(--overlay); box-shadow: var(--floating-shadow); font-size: .875rem; }
.live-link-prompt span { min-width: 0; margin-right: .5rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.live-link-prompt button { min-height: 2.25rem; flex: none; padding: 0 .875rem; border: 1px solid var(--border); border-radius: calc(var(--radius) * .75); color: var(--foreground); background: transparent; font: inherit; font-weight: 500; cursor: pointer; }
.live-link-prompt button[data-primary] { border-color: transparent; color: var(--contrast); background: linear-gradient(to bottom, var(--primary-top), var(--primary-bottom)); box-shadow: inset 0 1px 0 var(--primary-highlight), 0 2px 0 var(--primary-edge), 0 5px 9px -5px var(--primary-shadow); }
.live-link-prompt button:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
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
  body::before, .app-header, .share-footer { display: none; }
  .shared-document { max-width: none; padding: 0; }
}
`

/**
 * On a link that takes comments, the header's action. The comment script
 * shows it; without scripts the page stays view only.
 */
const commentToggle =
  '<noscript><span class="view-only">View only</span></noscript><button type="button" class="comment-toggle" id="worktable-comments-toggle" aria-controls="worktable-comments" aria-expanded="false" hidden>Comment</button>'

function header(
  iconSvg: string,
  title?: string,
  comments?: PublicShareCommentsPage
): string {
  return `<header class="app-header"><div class="header-inner"><span class="brand-mark" aria-hidden="true">${iconSvg}</span><span class="brand-name">Worktable</span>${title ? `<span class="header-separator" aria-hidden="true"></span><span class="document-name">${escapeHtml(title)}</span>` : ""}${comments ? commentToggle : title ? '<span class="view-only">View only</span>' : ""}</div></header>`
}

/** The source offer for visitors: a small link to this build's source. */
function footer(sourceUrl?: string): string {
  if (!sourceUrl) return ""
  try {
    const url = new URL(sourceUrl)
    if (url.protocol !== "https:" || url.username || url.password) return ""
    return `<footer class="share-footer"><a href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer">Source</a></footer>`
  } catch {
    // Omit invalid links from callers outside the validated share contract.
    return ""
  }
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
  return `<script type="application/json" id="worktable-diagram-config">${configs}</script>${DIAGRAM_SCRIPT_PATHS.map((path) => `<script src="${path}" defer></script>`).join("")}`
}

/** The comment panel's settings, then the script that builds the panel. */
function commentScripts(comments: PublicShareCommentsPage | undefined): string {
  if (!comments) return ""
  const config = JSON.stringify(comments).replace(/</g, "\\u003c")
  return `<script type="application/json" id="worktable-comments-config">${config}</script><script src="${PUBLIC_SHARE_ASSET_PATHS.comments}" defer></script>`
}

/** Isolated from the share page and its visitor state and live data. */
export function renderPublicCommentCheckPage(
  siteKey: string,
  parentOrigin: string
): string {
  const config = scriptJson({ siteKey, parentOrigin })
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Human check</title><style>html,body{margin:0;padding:0;background:transparent;color-scheme:light dark}</style></head><body><div id="worktable-comment-check-widget"></div><script type="application/json" id="worktable-comment-check-config">${config}</script><script src="${PUBLIC_SHARE_ASSET_PATHS.commentCheck}" defer></script></body></html>`
}

/** JSON for a script data block, which must never close its element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c")
}

/** The live script's settings, then the script that reads them. */
function liveScripts(config: unknown): string {
  return `<script type="application/json" id="worktable-live-config">${scriptJson(config)}</script><script src="${PUBLIC_SHARE_ASSET_PATHS.live}" defer></script>`
}

export function renderPublicDocumentPage(
  document: PublicDocumentPage,
  iconSvg: string,
  comments?: PublicShareCommentsPage
): string {
  if (document.kind === "doc") {
    return pageDocument(
      "Shared document",
      `<body>${header(iconSvg, document.title, comments)}<main class="document-shell"><article class="shared-document worktable-markdown ${document.format}">${document.projectionHtml}</article></main>${footer(document.sourceUrl)}${diagramScripts(document.projectionHtml)}${commentScripts(comments)}</body>`
    )
  }

  const htmlFooter = footer(document.sourceUrl)
  return pageDocument(
    "Shared HTML document",
    `<body class="html-page${htmlFooter ? " has-footer" : ""}">${header(iconSvg, document.title, comments)}<main class="html-shell"><iframe title="${escapeHtml(document.title)}" src="${escapeHtml(document.contentUrl)}" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"></iframe></main>${htmlFooter}${commentScripts(comments)}</body>`
  )
}

export function renderPublicShareUnavailablePage(iconSvg: string): string {
  return pageDocument(
    "Document unavailable",
    `<body>${header(iconSvg)}<main class="unavailable-shell"><section class="unavailable"><span class="large-mark" aria-hidden="true">${iconSvg}</span><h1>This document isn't available</h1><p>The link may have been stopped, or the document may no longer exist.</p></section></main></body>`
  )
}

/**
 * An HTML link whose tool runs live on the link's data. The live script frames
 * the tool once it is ready to broker its calls, so the frame's first message
 * always has a listener.
 */
export function renderPublicLivePage(
  document: { title: string; sourceUrl?: string },
  frame: { url: string; poll: number },
  iconSvg: string,
  comments?: PublicShareCommentsPage
): string {
  const liveFooter = footer(document.sourceUrl)
  return pageDocument(
    "Shared HTML document",
    `<body class="html-page${liveFooter ? " has-footer" : ""}">${header(iconSvg, document.title, comments)}<main class="html-shell"><noscript><div class="unavailable-shell"><section class="unavailable"><h1>This tool needs JavaScript</h1></section></div></noscript></main>${liveFooter}${liveScripts({ frame: { url: frame.url, title: document.title }, poll: frame.poll })}${commentScripts(comments)}</body>`
  )
}

function statusPage(
  iconSvg: string,
  title: string,
  heading: string,
  text: string,
  action = "",
  scripts = ""
): string {
  return pageDocument(
    title,
    `<body>${header(iconSvg)}<main class="unavailable-shell"><section class="unavailable"><span class="large-mark" aria-hidden="true">${iconSvg}</span><h1>${heading}</h1>${text ? `<p>${text}</p>` : ""}${action}</section></main>${scripts}</body>`
  )
}

/**
 * The waking page for a Worktable whose links may run live. Instead of
 * reloading on a timer, the live script asks the Worktable whether it is up
 * and reloads once it is, or stops after a minute and offers to try again.
 */
export function renderPublicShareLiveOpeningPage(iconSvg: string): string {
  return statusPage(
    iconSvg,
    "Opening document",
    "Opening the document",
    "This can take a few seconds.",
    '<noscript><p><a href="">Try again</a></p></noscript>',
    liveScripts({ waking: true })
  )
}
