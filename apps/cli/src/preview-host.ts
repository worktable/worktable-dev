import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { PreviewSandboxFailure } from "@worktable/server/runtime"

/**
 * Host checks for the sandboxed browser that renders document previews.
 * Worktable never disables Chromium's sandbox, so these explain and fix the
 * host conditions that stop it: running as root, and Ubuntu's AppArmor
 * restriction on unprivileged user namespaces.
 */

/** Installed releases carry their own preview runtime; source runs don't. */
export function isPackagedInstall(): boolean {
  return (
    Boolean(process.env["WORKTABLE_RELEASE_DIR"]?.trim()) ||
    /\/worktable(-server)?$/.test(process.execPath)
  )
}

/** The installed release's preview browser, or null when it's missing. */
export function previewBrowserExecutable(
  releaseDir: string | null
): string | null {
  if (!releaseDir) return null
  const runtime = join(releaseDir, "preview-runtime")
  try {
    const manifest = JSON.parse(
      readFileSync(join(runtime, "manifest.json"), "utf8")
    ) as { executable?: unknown }
    if (typeof manifest.executable !== "string") return null
    const executable = join(runtime, manifest.executable)
    return existsSync(executable) ? executable : null
  } catch {
    return null
  }
}

/** One profile per install, so setting up a second install keeps the first. */
export function appArmorProfileName(releaseDir: string): string {
  const releases = dirname(releaseDir)
  const id = createHash("sha256").update(releases).digest("hex").slice(0, 12)
  return `worktable-preview-${id}`
}

function escapeAppArmorPath(path: string): string {
  return path.replace(/[\\"*?[\]{}^]/g, (character) => `\\${character}`)
}

/**
 * An unconfined profile that only adds `userns` for this install's preview
 * browser, across every release version so updates keep working.
 */
export function renderAppArmorProfile(
  releaseDir: string,
  executable: string
): string {
  const name = appArmorProfileName(releaseDir)
  const releases = dirname(releaseDir)
  const withinRelease = executable.slice(releaseDir.length + 1)
  const attachment = `${escapeAppArmorPath(releases)}/*/${escapeAppArmorPath(withinRelease)}`
  return `# Written by \`worktable preview setup\`: lets this Worktable's preview browser use Chromium's sandbox.
abi <abi/4.0>,
include <tunables/global>

profile ${name} "${attachment}" flags=(unconfined) {
  userns,

  include if exists <local/${name}>
}
`
}

export type PreviewCheck =
  | { ok: true }
  | { ok: false; failure: PreviewSandboxFailure; reason: string }

/**
 * Starts the preview browser once through the server's own launcher, so the
 * answer matches what rendering will do. Null for source runs.
 */
export async function checkInstalledPreviews(): Promise<PreviewCheck | null> {
  if (!isPackagedInstall()) return null
  const { checkPreviewBrowser, closePreviewBrowsers } = await import(
    "@worktable/server/preview"
  )
  try {
    const availability = await checkPreviewBrowser()
    if (availability.available && availability.launchStatus === "ready")
      return { ok: true }
    return {
      ok: false,
      failure: availability.failure ?? "other",
      reason:
        availability.reason ?? "The preview browser didn't start in time.",
    }
  } finally {
    await closePreviewBrowsers()
  }
}
