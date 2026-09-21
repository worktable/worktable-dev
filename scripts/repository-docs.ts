import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"

const repositoryDocuments = new Set([
  "README.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "DCO",
  "apps/desktop/README.md",
  "docs/README.md",
  "docs/building.md",
  "docs/development.md",
  "docs/openclaw-release.md",
  ".github/CODEOWNERS",
  ".github/PULL_REQUEST_TEMPLATE.md",
])

// Deliberately excludes product docs, workflows, manifests, generated inputs,
// executable examples, and unknown paths. Renames must supply both paths.
export function isRepositoryDoc(path: string): boolean {
  return (
    repositoryDocuments.has(path) ||
    /^\.github\/ISSUE_TEMPLATE\/[^/]+\.(?:md|ya?ml)$/.test(path) ||
    /^docs\/images\/[^/]+\.(?:png|jpe?g|webp)$/.test(path)
  )
}

export function repositoryDocsOnly(paths: string[]): boolean {
  return paths.length > 0 && paths.every(isRepositoryDoc)
}

export function checkRepositoryDocument(
  root: string,
  source: string,
  target = source
): string[] {
  const errors: string[] = []
  if (
    !existsSync(resolve(root, source)) ||
    /\.(?:png|jpe?g|webp)$/.test(source)
  )
    return errors
  const content = readFileSync(resolve(root, source), "utf8")
  if (/^(?:<<<<<<< |=======\s*$|>>>>>>> )/m.test(content))
    errors.push(`${source}: unresolved merge conflict`)
  if (/\.ya?ml$/.test(source)) {
    try {
      const parsed = Bun.YAML.parse(content)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("expected a mapping")
    } catch (error) {
      errors.push(`${source}: invalid YAML: ${error}`)
    }
  } else if (target.endsWith(".md")) {
    function checkLink(url: string): void {
      // External availability, heading anchors and prose accuracy remain review
      // concerns. Local Markdown links and images must resolve in this checkout.
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url)) return
      try {
        const path = decodeURIComponent(url.split(/[?#]/, 1)[0] ?? "")
        if (!path) return
        const absolute = path.startsWith("/")
          ? resolve(root, `.${path}`)
          : resolve(root, dirname(target), path)
        const local = relative(resolve(root), absolute)
        if (local.startsWith("../") || local === ".." || !existsSync(absolute))
          errors.push(`${source}: missing local target ${url}`)
      } catch {
        errors.push(`${source}: invalid local URL ${url}`)
      }
    }
    Bun.markdown.render(content, {
      link(children, { href }) {
        checkLink(href)
        return children
      },
      image(children, { src }) {
        checkLink(src)
        return children
      },
    })
  }
  return errors
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args[0] === "--classify" && args.length === 3) {
    let paths: string[] = []
    try {
      if (!/^[a-f0-9]{40}$/.test(args[1]!) || !/^[a-f0-9]{40}$/.test(args[2]!))
        throw new Error("missing immutable revisions")
      paths = execFileSync(
        "git",
        [
          "diff",
          "--name-only",
          "--no-renames",
          "-z",
          `${args[1]}...${args[2]}`,
        ],
        { encoding: "utf8" }
      )
        .split("\0")
        .filter(Boolean)
    } catch {
      /* Unavailable diff always takes the full lane. */
    }
    console.log(repositoryDocsOnly(paths) ? "documentation" : "full")
  } else {
    if (args.length && !(args.length === 3 && args[0] === "--overlay"))
      throw new Error(
        "Usage: repository-docs.ts [--classify BASE_SHA HEAD_SHA | --overlay SOURCE TARGET]"
      )
    const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
      .split("\0")
      .filter(isRepositoryDoc)
    const errors = paths.flatMap((path) =>
      checkRepositoryDocument(process.cwd(), path)
    )
    if (args[0] === "--overlay")
      errors.push(...checkRepositoryDocument(process.cwd(), args[1]!, args[2]!))
    if (errors.length) throw new Error(errors.join("\n"))
    console.log(
      `Repository documentation: ${paths.length} files checked (local Markdown targets, YAML parsing, merge conflicts).`
    )
  }
}
