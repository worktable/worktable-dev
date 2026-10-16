import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  classifyPreviewSandboxFailure,
  type PreviewSandboxFailure,
} from "@worktable/server/runtime"

/**
 * Host checks for the sandboxed browser that renders document previews.
 * Worktable never disables Chromium's sandbox, so these explain and fix the
 * host conditions that stop it: running as root, and Ubuntu's AppArmor
 * restriction on unprivileged user namespaces.
 */

export const APPARMOR_PROFILE_NAME = "worktable-chrome-headless-shell"
export const APPARMOR_PROFILE_PATH = `/etc/apparmor.d/${APPARMOR_PROFILE_NAME}`
const PROBE_MARKER = "worktable-preview-sandbox-ok"

/** The installed release's preview browser, or null for source runs. */
export function previewBrowserExecutable(releaseDir: string | null): string | null {
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
  const releases = dirname(releaseDir)
  const withinRelease = executable.slice(releaseDir.length + 1)
  const attachment = `${escapeAppArmorPath(releases)}/*/${escapeAppArmorPath(withinRelease)}`
  return `# Written by \`worktable preview setup\`: lets Worktable's preview browser use Chromium's sandbox.
abi <abi/4.0>,
include <tunables/global>

profile ${APPARMOR_PROFILE_NAME} "${attachment}" flags=(unconfined) {
  userns,

  include if exists <local/${APPARMOR_PROFILE_NAME}>
}
`
}

export type PreviewProbe =
  | { ok: true }
  | { ok: false; reason: PreviewSandboxFailure; detail: string }

/** Starts the preview browser once, with its sandbox, the way the server does. */
export function probePreviewBrowser(executable: string): PreviewProbe {
  const profile = mkdtempSync(join(tmpdir(), "worktable-preview-probe-"))
  try {
    const result = spawnSync(
      executable,
      [
        "--headless",
        "--no-first-run",
        "--disable-gpu",
        `--user-data-dir=${profile}`,
        "--dump-dom",
        `data:text/html,<p>${PROBE_MARKER}</p>`,
      ],
      {
        encoding: "utf8",
        timeout: 20_000,
        env: { HOME: profile, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      }
    )
    if (result.stdout?.includes(PROBE_MARKER)) return { ok: true }
    const detail = `${result.stderr ?? ""}${result.error ? String(result.error) : ""}`
    return { ok: false, reason: classifyPreviewSandboxFailure(detail), detail }
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
}

/** One line for `doctor` and `preview setup`, naming the fix. */
export function describePreviewProbe(probe: PreviewProbe): string {
  if (probe.ok) return "working"
  switch (probe.reason) {
    case "root":
      return "unavailable: Worktable is running as root. Run it as a regular user."
    case "apparmor":
      return "unavailable: AppArmor blocks the browser sandbox. Run `worktable preview setup`."
    case "sandbox":
      return "unavailable: this host can't start Chromium's sandbox."
    default: {
      const first = probe.detail.trim().split("\n").find(Boolean) ?? "unknown error"
      return `unavailable: the preview browser didn't start (${first})`
    }
  }
}
