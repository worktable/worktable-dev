import {
  getWorktableMermaidConfig,
  type WorktableMermaidThemeMode,
} from "@worktable/types"

let renderQueue: Promise<void> = Promise.resolve()
let configuredTheme: WorktableMermaidThemeMode | null = null

interface MermaidRenderRequest {
  id: string
  source: string
  themeMode: WorktableMermaidThemeMode
}

/**
 * Mermaid keeps its configuration in module-global state. Serialize configure,
 * parse, and render so two diagrams using different themes cannot race and
 * render with each other's configuration.
 */
export function renderWorktableMermaid({
  id,
  source,
  themeMode,
}: MermaidRenderRequest): Promise<string> {
  const render = renderQueue.then(async () => {
    const { default: mermaid } = await import("mermaid")

    if (configuredTheme !== themeMode) {
      mermaid.initialize(getWorktableMermaidConfig(themeMode))
      configuredTheme = themeMode
    }

    const parsed = await mermaid.parse(source, {
      suppressErrors: true,
    } as never)
    if (!parsed) throw new Error("Invalid Mermaid syntax")

    const result = await mermaid.render(id, source)
    return result.svg
  })

  renderQueue = render.then(
    () => undefined,
    () => undefined
  )
  return render
}
