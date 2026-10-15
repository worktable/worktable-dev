import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { desktopBuildVersion } from "./desktop-version"
import { appRoot } from "./release-paths"

// Builds the signed release app and disk image. A beta build carries its dev
// version (WORKTABLE_VERSION) instead of tauri.conf.json's, so the app, its
// updater signature and its bundle all name the beta it was built from.

export function releaseBundleArguments(
  version: string,
  configVersion: string
): string[] {
  const args = [
    "build",
    "--bundles",
    "app,dmg",
    "--config",
    "src-tauri/tauri.release.conf.json",
  ]
  if (version !== configVersion) {
    args.push("--config", JSON.stringify({ version }))
  }
  return args
}

if (import.meta.main) {
  const config = (await Bun.file(
    new URL("../src-tauri/tauri.conf.json", import.meta.url)
  ).json()) as { version: string }
  const version = desktopBuildVersion()
  console.log(`Building Worktable Desktop ${version}`)
  // The workspace-installed CLI, the same one `tauri` in package scripts runs.
  let directory = appRoot
  while (!existsSync(join(directory, "node_modules", ".bin", "tauri"))) {
    const parent = dirname(directory)
    if (parent === directory) throw new Error("The Tauri CLI is not installed")
    directory = parent
  }
  const child = Bun.spawn(
    [
      join(directory, "node_modules", ".bin", "tauri"),
      ...releaseBundleArguments(version, config.version),
    ],
    {
      cwd: appRoot,
      stdout: "inherit",
      stderr: "inherit",
    }
  )
  process.exit(await child.exited)
}
