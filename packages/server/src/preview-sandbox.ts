import { readFileSync } from "node:fs"

/**
 * Why the sandboxed preview browser couldn't start, from its startup output.
 * Worktable never disables Chromium's sandbox, so each cause names a host
 * change: run as a regular user, or let AppArmor allow user namespaces.
 */
export type PreviewSandboxFailure = "root" | "apparmor" | "sandbox" | "other"

/** Ubuntu 23.10+ denies unprivileged user namespaces unless AppArmor allows the program. */
export function userNamespacesRestricted(): boolean {
  if (process.platform !== "linux") return false
  try {
    return (
      readFileSync(
        "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
        "utf8"
      ).trim() === "1"
    )
  } catch {
    return false
  }
}

export function classifyPreviewSandboxFailure(
  output: string,
  restricted: boolean = userNamespacesRestricted()
): PreviewSandboxFailure {
  if (/Running as root without --no-sandbox/.test(output)) return "root"
  if (/No usable sandbox|Chromium sandboxing failed/.test(output))
    return restricted ? "apparmor" : "sandbox"
  return "other"
}
