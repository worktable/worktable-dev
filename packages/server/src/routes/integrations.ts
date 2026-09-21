import { Hono } from "hono"
import { getClaudeDesktopExtensionBundle } from "../claude-extension-assets.ts"
import { isHosted } from "../hosted.ts"

export const integrationsRouter = new Hono()

integrationsRouter.get("/integrations/claude-desktop.mcpb", (c) => {
  if (isHosted()) {
    return c.json(
      {
        error:
          "The Claude Desktop extension is not available on Worktable Cloud; connect with OAuth.",
        code: "HOSTED_DISABLED",
      },
      403
    )
  }

  const bundle = getClaudeDesktopExtensionBundle()
  if (!bundle) {
    return c.json(
      {
        error: "The Claude Desktop extension is unavailable in this install.",
        code: "EXTENSION_UNAVAILABLE",
      },
      404
    )
  }
  const body = bundle.buffer.slice(
    bundle.byteOffset,
    bundle.byteOffset + bundle.byteLength
  ) as ArrayBuffer
  return new Response(body, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Disposition":
        'attachment; filename="worktable-claude-desktop.mcpb"',
      "Content-Length": String(bundle.byteLength),
      "Content-Type": "application/octet-stream",
    },
  })
})
