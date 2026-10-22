import { createToolBroker, type ToolHostConfig } from "./broker.ts"
import { startIsolatedTool } from "./controller.ts"

// The asset generator embeds only its own worker build here. Document content
// never supplies browser-executable source, a worker URL, or an asset URL.
declare const __WORKTABLE_TOOL_WORKER_SOURCE__: string

const root = document.querySelector<HTMLElement>("#worktable-tool")!
const notice = document.querySelector<HTMLElement>("#worktable-tool-notice")!
const configuration = JSON.parse(
  document.querySelector("#worktable-tool-config")!.textContent!
) as ToolHostConfig & { source: string }
if (!["member", "share", "preview"].includes(configuration.mode))
  throw new Error("The tool configuration is invalid.")

const diagnostics: {
  id: string
  level: string
  code: string
  message: string
  timestamp: string
}[] = []
let diagnosticSequence = 0
function diagnostic(code: string, message: string): void {
  const value = {
    id: `tool-${++diagnosticSequence}`,
    timestamp: new Date().toISOString(),
    level: code === "widget_notice" ? "info" : "warning",
    code: code.slice(0, 128),
    message: message.slice(0, 1000),
  }
  if (diagnostics.length < 40) diagnostics.push(value)
  // Notices are text in a trusted sibling; guest view replacements cannot
  // hide errors or replace the host's status control.
  notice.textContent = value.message
  parent.postMessage(
    {
      type: "worktable.widget.diagnostic",
      spaceId: configuration.spaceId,
      widgetId: configuration.widgetId,
      diagnostic: value,
    },
    "*"
  )
}

const media = matchMedia("(prefers-color-scheme: dark)")
function environment() {
  const theme =
    configuration.mode === "share"
      ? media.matches
        ? "dark"
        : "light"
      : document.documentElement.getAttribute("data-theme") === "dark"
        ? "dark"
        : "light"
  document.documentElement.setAttribute("data-theme", theme)
  return {
    theme,
    viewport: {
      width: Math.min(32768, innerWidth),
      height: Math.min(32768, innerHeight),
    },
  } as const
}
let failed = false
const broker = createToolBroker(configuration, diagnostic)
const host = startIsolatedTool({
  root,
  source: configuration.source,
  workerSource: __WORKTABLE_TOOL_WORKER_SOURCE__,
  initialEnvironment: environment(),
  broker,
  fault: () => {
    failed = true
    broker.close()
    const heading = document.createElement("h1")
    heading.textContent = "This tool stopped"
    root.replaceChildren(heading)
    diagnostic("tool_stopped", "Reload the page to try again.")
  },
})
function updateEnvironment(): void {
  if (!failed) host.environment(environment())
}
function close(): void {
  host.close()
  broker.close()
  removeEventListener("resize", updateEnvironment)
  media.removeEventListener("change", updateEnvironment)
}
addEventListener("resize", updateEnvironment)
media.addEventListener("change", updateEnvironment)
addEventListener("pagehide", close, { once: true })
// Read only by the trusted image-preview driver. The VM has no Window object.
Object.defineProperty(window, "__worktableToolStatus", {
  value: () => ({
    rendered: root.childNodes.length > 0,
    idle: host.idle(),
    failed,
    diagnostics: diagnostics.slice(),
  }),
})
broker.ready()
