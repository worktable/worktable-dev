import type { Rollup } from "vite"

/**
 * The dynamic icon picker gives every Lucide icon a dynamic import. Without an
 * explicit shared chunk, Rollup also turns ordinary named icon imports into
 * dozens of tiny startup requests. Group only icons explicitly imported by
 * application/library code; leave the rest of the picker catalog on demand.
 */
export function sharedIconChunk(): Rollup.GetManualChunk {
  let shared: Set<string> | undefined
  return (id, graph) => {
    // Keep the icon factory's React dependency independent of the app/editor.
    // Otherwise grouping icons can create a cycle that pulls the editor into
    // every route, including HTML and Markdown.
    if (
      /\/node_modules\/(?:react|react-dom|scheduler)\//.test(id) ||
      id.includes("commonjsHelpers.js")
    )
      return "react-runtime"
    if (!id.includes("/lucide-react/dist/esm/")) return
    const relative = id.split("/lucide-react/dist/esm/")[1]
    if (
      /^(?:Icon\.js|createLucideIcon\.js|defaultAttributes\.js|shared\/)/.test(
        relative
      )
    )
      return "shared-icons"
    if (!shared) {
      shared = new Set<string>()
      const names = new Set<string>()
      const barrels: string[] = []
      for (const moduleId of graph.getModuleIds()) {
        if (moduleId.endsWith("/lucide-react/dist/esm/lucide-react.js")) {
          barrels.push(moduleId)
          continue
        }
        if (moduleId.includes("/lucide-react/")) continue
        for (const node of graph.getModuleInfo(moduleId)?.ast?.body ?? []) {
          if (
            node.type !== "ImportDeclaration" ||
            node.source.value !== "lucide-react"
          )
            continue
          for (const specifier of node.specifiers) {
            if (specifier.type !== "ImportSpecifier") continue
            names.add(
              specifier.imported.type === "Identifier"
                ? specifier.imported.name
                : String(specifier.imported.value)
            )
          }
        }
      }
      for (const barrel of barrels) {
        for (const node of graph.getModuleInfo(barrel)?.ast?.body ?? []) {
          if (
            node.type !== "ExportNamedDeclaration" ||
            !node.source ||
            typeof node.source.value !== "string"
          )
            continue
          if (!node.source.value.startsWith("./icons/")) continue
          if (
            node.specifiers.some((specifier) =>
              names.has(
                specifier.exported.type === "Identifier"
                  ? specifier.exported.name
                  : String(specifier.exported.value)
              )
            )
          ) {
            shared.add(
              barrel.slice(0, barrel.lastIndexOf("/") + 1) +
                node.source.value.slice(2)
            )
          }
        }
      }
    }
    if (shared.has(id)) return "shared-icons"
  }
}
