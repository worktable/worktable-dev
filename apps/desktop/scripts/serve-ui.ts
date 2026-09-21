import { extname, join, normalize } from "node:path"

const uiRoot = join(import.meta.dir, "../ui")
const repositoryRoot = join(import.meta.dir, "../../..")
const port = Number(process.env["WORKTABLE_DESKTOP_UI_PORT"] ?? "15321")
const useFontshare = process.argv.includes("--fontshare")
const config = await Bun.file(
  join(uiRoot, "../src-tauri/tauri.conf.json")
).json()
const contentSecurityPolicy = useFontshare
  ? config.app.security.devCsp
  : config.app.security.csp
const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
}

Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url)
    const relative = normalize(
      decodeURIComponent(
        url.pathname === "/"
          ? "index.html"
          : url.pathname === "/favicon.ico"
            ? "worktable-icon.svg"
            : url.pathname.slice(1)
      )
    )
    if (relative.startsWith(".."))
      return new Response("Not found", { status: 404 })
    // Development obtains the font directly from its publisher. Packaged assets
    // continue to use the local stylesheet and offline font file.
    if (useFontshare && relative === "fonts/general-sans.css") {
      return new Response(
        '@import url("https://api.fontshare.com/v2/css?f[]=general-sans@1&display=swap");\n',
        { headers: { "Content-Type": contentTypes[".css"]! } }
      )
    }
    const file = Bun.file(
      relative === "theme.generated.css"
        ? join(repositoryRoot, "packages/ui/src/styles/theme.generated.css")
        : join(uiRoot, relative)
    )
    if (!(await file.exists()))
      return new Response("Not found", { status: 404 })
    return new Response(file, {
      headers: {
        "Content-Security-Policy": contentSecurityPolicy,
        "Content-Type":
          contentTypes[extname(relative)] ?? "application/octet-stream",
      },
    })
  },
})

console.log(`Desktop UI test server listening on http://127.0.0.1:${port}`)
