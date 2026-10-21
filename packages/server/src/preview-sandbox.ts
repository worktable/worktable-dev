import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"

/**
 * Why the sandboxed preview browser couldn't start, from its startup output.
 * Worktable never disables Chromium's sandbox, so each sandbox cause names a
 * host change: run as a regular user, or let AppArmor allow user namespaces.
 * `libraries` means the host lacks system libraries the browser links.
 */
export type PreviewSandboxFailure =
  | "root"
  | "apparmor"
  | "sandbox"
  | "libraries"
  | "other"

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
  if (/error while loading shared libraries|symbol lookup error/.test(output))
    return "libraries"
  if (/Running as root without --no-sandbox/.test(output)) return "root"
  if (/No usable sandbox|Chromium sandboxing failed/.test(output))
    return restricted ? "apparmor" : "sandbox"
  return "other"
}

/**
 * The libraries the browser couldn't load: every one `ldd` reports missing,
 * plus the one the loader named, since the loader stops at the first.
 */
export function missingPreviewLibraries(
  output: string,
  executable?: string
): string[] {
  const missing = new Set<string>()
  if (executable && process.platform === "linux") {
    const ldd = spawnSync("ldd", [executable], {
      encoding: "utf8",
      timeout: 5_000,
    })
    for (const match of (ldd.stdout ?? "").matchAll(/^\s*(\S+) => not found/gm))
      missing.add(match[1]!)
  }
  const named = /error while loading shared libraries: ([^:\s]+)/.exec(output)
  if (named) missing.add(named[1]!)
  return [...missing]
}

/** The loader's complaint without the browser's path, for when no library is named. */
export function loaderError(output: string): string | null {
  return (
    /undefined symbol: [^\n]+/.exec(output)?.[0] ??
    /error while loading shared libraries: [^\n]+/.exec(output)?.[0] ??
    null
  )
}

/**
 * Debian and Ubuntu packages for the libraries Chrome's headless shell links,
 * following Playwright's `install-deps` list for Chromium.
 */
const DEBIAN_PACKAGES: Record<string, string> = {
  "libasound.so.2": "libasound2",
  "libatk-1.0.so.0": "libatk1.0-0",
  "libatk-bridge-2.0.so.0": "libatk-bridge2.0-0",
  "libatspi.so.0": "libatspi2.0-0",
  "libcairo.so.2": "libcairo2",
  "libcups.so.2": "libcups2",
  "libdbus-1.so.3": "libdbus-1-3",
  "libdrm.so.2": "libdrm2",
  "libexpat.so.1": "libexpat1",
  "libgbm.so.1": "libgbm1",
  "libgio-2.0.so.0": "libglib2.0-0",
  "libglib-2.0.so.0": "libglib2.0-0",
  "libgmodule-2.0.so.0": "libglib2.0-0",
  "libgobject-2.0.so.0": "libglib2.0-0",
  "libnspr4.so": "libnspr4",
  "libplc4.so": "libnspr4",
  "libplds4.so": "libnspr4",
  "libnss3.so": "libnss3",
  "libnssutil3.so": "libnss3",
  "libsmime3.so": "libnss3",
  "libpango-1.0.so.0": "libpango-1.0-0",
  "libwayland-client.so.0": "libwayland-client0",
  "libX11.so.6": "libx11-6",
  "libxcb.so.1": "libxcb1",
  "libXcomposite.so.1": "libxcomposite1",
  "libXdamage.so.1": "libxdamage1",
  "libXext.so.6": "libxext6",
  "libXfixes.so.3": "libxfixes3",
  "libxkbcommon.so.0": "libxkbcommon0",
  "libXrandr.so.2": "libxrandr2",
}

/** Renamed for the 64-bit time transition in Ubuntu 24.04 and Debian 13. */
const TIME64_PACKAGES = new Set([
  "libasound2",
  "libatk-bridge2.0-0",
  "libatk1.0-0",
  "libatspi2.0-0",
  "libcups2",
  "libglib2.0-0",
])

export type DebianRelease = { time64: boolean } | null

/** Debian or Ubuntu, from os-release; null for other systems. */
export function debianRelease(
  osRelease: string | null = readOsRelease()
): DebianRelease {
  if (!osRelease) return null
  const field = (name: string) =>
    new RegExp(`^${name}="?([^"\\n]*)"?$`, "m").exec(osRelease)?.[1] ?? ""
  const id = field("ID")
  const major = Number.parseInt(field("VERSION_ID"), 10)
  if (id === "ubuntu") return { time64: major >= 24 }
  // Debian testing and unstable carry no VERSION_ID.
  if (id === "debian") return { time64: !(major < 13) }
  return null
}

function readOsRelease(): string | null {
  try {
    return readFileSync("/etc/os-release", "utf8")
  } catch {
    return null
  }
}

/** Names the missing libraries and, on Debian or Ubuntu, the install command. */
export function describeMissingLibraries(
  missing: string[],
  release: DebianRelease,
  loader: string | null = null
): string {
  if (!missing.length)
    return loader
      ? `The preview browser can't load the system libraries it needs: ${loader}.`
      : "The preview browser can't load the system libraries it needs."
  // A bare server lacks about twenty; the install command covers them all.
  const named =
    missing.length > 3
      ? `${missing.slice(0, 3).join(", ")} and ${missing.length - 3} more`
      : missing.join(", ")
  let message = `The preview browser needs system libraries this host doesn't have: ${named}.`
  const packages = [
    ...new Set(
      missing.flatMap((library) => {
        const name = DEBIAN_PACKAGES[library]
        if (!name) return []
        return [
          release?.time64 && TIME64_PACKAGES.has(name) ? `${name}t64` : name,
        ]
      })
    ),
  ].sort()
  if (release && packages.length)
    message += ` Install them with \`sudo apt-get install ${packages.join(" ")}\`.`
  return message
}
