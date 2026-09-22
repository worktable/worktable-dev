import { readFileSync } from "node:fs"
import { join } from "node:path"

export type DocumentPreloads = Record<
  "rich-text" | "markdown" | "html",
  string[]
>
type Chunk = { file: string; name?: string; imports?: string[] }

// Vite's build manifest is the only source of hashed asset names. Follow static
// imports, not optional dynamic features such as Mermaid or the source editor.
export function readDocumentPreloads(staticDir: string): DocumentPreloads {
  const result: DocumentPreloads = { "rich-text": [], markdown: [], html: [] }
  try {
    const manifest = JSON.parse(
      readFileSync(join(staticDir, ".vite/manifest.json"), "utf8")
    ) as Record<string, Chunk>
    const visit = (key: string, files: Set<string>, seen: Set<string>) => {
      if (seen.has(key)) return
      seen.add(key)
      const chunk = manifest[key]
      if (!chunk) return
      for (const dependency of chunk.imports ?? [])
        visit(dependency, files, seen)
      if (
        /^assets\/[\w./-]+\.js$/.test(chunk.file) &&
        !chunk.file.includes("..")
      )
        files.add(`/${chunk.file}`)
    }
    for (const [kind, entries] of Object.entries({
      "rich-text": [
        "src/components/doc-document.tsx",
        "src/components/editor/editor.tsx",
      ],
      markdown: ["src/components/doc-document.tsx"],
      html: ["src/components/html-document.tsx"],
    })) {
      const files = new Set<string>()
      const seen = new Set<string>()
      for (const entry of entries) {
        // Rollup can promote a dynamically imported module into a shared
        // chunk. In that case Vite keys it by output name instead of source.
        const name = entry
          .split("/")
          .at(-1)!
          .replace(/\.tsx$/, "")
        const shared = Object.keys(manifest).filter(
          (key) => manifest[key].name === name
        )
        const key = manifest[entry]
          ? entry
          : shared.length === 1
            ? shared[0]
            : null
        if (key) visit(key, files, seen)
      }
      result[kind as keyof DocumentPreloads] = [...files]
    }
  } catch {
    // Older release assets and development builds have no manifest.
  }
  return result
}
