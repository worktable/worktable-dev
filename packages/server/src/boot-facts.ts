import { Hono } from "hono"
import { BOOT_FACTS_ID, inlineScriptJson } from "@worktable/ui/lib/page-json"
import { trustedLocalIdentity } from "./auth.ts"
import { storageUpgradeStatus, workspaceSummary } from "./routes/workspace.ts"

export const BOOT_FACTS_MARKER = `<script id="${BOOT_FACTS_ID}" type="application/json">null</script>`

// What the app would otherwise read before it renders anything: the storage
// upgrade state and, once storage is ready, the workspace summary. These come
// from the REST handlers under the REST identity, checked against the
// navigation request itself. A request without that identity gets the plain
// shell, as it always has. Gateway admission has already run on the outer
// navigation request.
const boot = new Hono()
boot.use("*", trustedLocalIdentity())
boot.get("*", async (c) => {
  const storageUpgrade = storageUpgradeStatus(c)
  return c.json({
    storageUpgrade,
    // The workspace is not read while its storage is being upgraded.
    ...(storageUpgrade.state === "ready"
      ? { workspace: await workspaceSummary(c) }
      : {}),
  })
})
boot.onError(() => new Response(null, { status: 204 }))

type BootFacts = { build: string | null } & Record<string, unknown>

// The facts are optional: without them the app reads them itself. A slow read
// must not hold up the shell and the discovery of its assets.
const BOOT_FACTS_BUDGET_MS = 250

/**
 * The facts this navigation's shell should carry, or null when it gets the
 * plain shell. They are per person and per moment: a page carrying them must
 * never be stored or shared.
 */
export async function readBootFacts(
  request: Request,
  shell: string,
  build: string | null
): Promise<BootFacts | null> {
  if (request.method !== "GET" || !shell.includes(BOOT_FACTS_MARKER))
    return null
  const read = (async () => {
    const response = await boot.fetch(request)
    if (response.status !== 200) return null
    return { build, ...((await response.json()) as Record<string, unknown>) }
  })().catch(() => null)
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), BOOT_FACTS_BUDGET_MS)
  })
  try {
    return await Promise.race([read, late])
  } finally {
    clearTimeout(timer)
  }
}

export function withBootFacts(shell: string, facts: BootFacts): string {
  return shell.replace(
    BOOT_FACTS_MARKER,
    () =>
      `<script id="${BOOT_FACTS_ID}" type="application/json">${inlineScriptJson(facts)}</script>`
  )
}
