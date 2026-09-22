// Remote font CSS must not be an @import in the render-blocking app stylesheet.
// System fallbacks render first; the existing licensed providers still supply
// the fonts. Keep these URLs centralized alongside the shared font tokens.
const fontStylesheets = [
  "https://api.fontshare.com/v2/css?f[]=general-sans@1&display=swap",
  "https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..900;1,9..144,300..900&family=JetBrains+Mono:wght@400;500;600&display=swap",
]

// Runs from the static shell, independently of app hydration. Nonmatching media
// keeps a stalled provider out of the rendering path even after discovery.
export const fontBootstrapScript = `requestAnimationFrame(()=>requestAnimationFrame(()=>{for(const href of ${JSON.stringify(fontStylesheets)}){const link=document.createElement("link");link.rel="stylesheet";link.href=href;link.media="print";link.fetchPriority="low";link.onload=()=>{link.media="all"};document.head.appendChild(link)}}))`
