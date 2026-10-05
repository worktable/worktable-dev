import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

type Page = {
  path: string
  ids: Set<string>
  links: string[]
  redirect?: string
}
const origin = "https://docs.worktable.dev"

function htmlFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory()
      ? htmlFiles(path)
      : entry.name.endsWith(".html")
        ? [path]
        : []
  })
}

export async function checkDocsLinks(
  directory: string
): Promise<{ pages: number; links: number; errors: string[] }> {
  const root = resolve(directory)
  const pages = new Map<string, Page>()
  for (const file of htmlFiles(root)) {
    const path = "/" + relative(root, file).replaceAll("\\", "/")
    const page: Page = {
      path: path.replace(/index\.html$/, ""),
      ids: new Set(),
      links: [],
    }
    await new HTMLRewriter()
      .on("*", {
        element(element) {
          const id = element.getAttribute("id")
          if (id) page.ids.add(id)
          const href = element.getAttribute("href")
          const src = element.getAttribute("src")
          // Canonicals describe indexing, not navigable targets. Astro's error
          // page has a canonical /404/ while its static artifact is 404.html.
          if (href && element.getAttribute("rel") !== "canonical")
            page.links.push(href)
          if (src) page.links.push(src)
          if (
            element.tagName === "meta" &&
            element.getAttribute("http-equiv")?.toLowerCase() === "refresh"
          ) {
            page.redirect = element
              .getAttribute("content")
              ?.match(/url=(.*)$/i)?.[1]
              ?.replace(/^["']|["']$/g, "")
          }
        },
      })
      .transform(new Response(readFileSync(file)))
      .text()
    pages.set(file, page)
  }
  const errors: string[] = []
  let links = 0
  function destination(
    url: URL,
    redirects = new Set<string>()
  ): string | undefined {
    if (url.origin !== origin) return
    const path = decodeURIComponent(url.pathname)
    const file = join(root, path)
    const fromRoot = relative(root, file)
    if (fromRoot === ".." || fromRoot.startsWith(".." + sep) || isAbsolute(fromRoot))
      return "Path leaves the site"
    const target =
      existsSync(file) && statSync(file).isDirectory()
        ? join(file, "index.html")
        : file
    if (!existsSync(target)) return "Missing file"
    const page = pages.get(target)
    if (page?.redirect) {
      if (redirects.has(target)) return "Redirect loop"
      redirects.add(target)
      const next = new URL(page.redirect, url)
      if (!next.hash) next.hash = url.hash
      return destination(next, redirects)
    }
    if (url.hash && page) {
      const id = decodeURIComponent(url.hash.slice(1)).split(":~:text=")[0]!
      if (id && !page.ids.has(id)) return `Missing anchor #${id}`
    }
  }
  for (const page of pages.values()) {
    for (const href of page.links) {
      try {
        const url = new URL(href, origin + page.path)
        if (url.origin !== origin) continue
        links++
        const error = destination(url)
        if (error) errors.push(`${page.path}: ${href} (${error})`)
      } catch {
        errors.push(`${page.path}: ${href} (Invalid URL)`)
      }
    }
  }
  return { pages: pages.size, links, errors }
}

if (import.meta.main) {
  const result = await checkDocsLinks(
    process.argv[2] ?? join(import.meta.dir, "../apps/docs/dist")
  )
  for (const error of result.errors) console.error(error)
  console.log(
    `Documentation links: ${result.pages} pages, ${result.links} local references, ${result.errors.length} errors.`
  )
  if (result.errors.length) process.exitCode = 1
}
