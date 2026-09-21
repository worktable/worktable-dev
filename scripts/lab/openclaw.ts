import { spawnSync } from "node:child_process"
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { verifiedOpenClawVersion } from "./agents.ts"

export interface OpenClawArtifacts {
  version: string
  pluginArtifact: string
  runtimeArtifact?: string
  runtimeSource: "verified-package" | "source-checkout"
  cleanup(): void
}

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(
      result.stderr ||
        result.stdout ||
        `${command} exited with status ${result.status ?? "unknown"}`
    )
  return `${result.stdout ?? ""}${result.stderr ?? ""}`
}

function packageVersion(path: string): string {
  const pkg = JSON.parse(readFileSync(path, "utf8")) as {
    name?: unknown
    version?: unknown
  }
  if (pkg.name !== "openclaw" || typeof pkg.version !== "string")
    throw new Error(`OpenClaw source package is invalid: ${path}`)
  return pkg.version
}

function newestTarball(directory: string): string {
  const entries = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tgz"))
    .map((entry) => join(directory, entry.name))
    .sort()
  const path = entries.at(-1)
  if (!path) throw new Error(`No package tarball was produced in ${directory}`)
  return path
}

export function artifactFromPackOutput(
  output: string,
  directory: string
): string {
  const artifactDirectory = realpathSync(directory)
  for (const line of output.split(/\r?\n/).reverse()) {
    const candidate = line.trim()
    if (!candidate.endsWith(".tgz")) continue
    try {
      const artifact = realpathSync(candidate)
      if (dirname(artifact) === artifactDirectory) return artifact
    } catch {
      // Ignore log lines and paths that no longer identify the emitted file.
    }
  }
  throw new Error(
    `The OpenClaw plugin pack command did not report a usable artifact in ${directory}`
  )
}

export function prepareOpenClawArtifacts(
  options: { sourceDirectory?: string } = {}
): OpenClawArtifacts {
  const version = verifiedOpenClawVersion()
  const pluginRoot = resolve(import.meta.dir, "../../packages/openclaw-plugin")
  const artifactDirectory = join(pluginRoot, "artifacts")
  const packOutput = run("bun", ["run", "pack:dogfood"], pluginRoot)
  const pluginArtifact = artifactFromPackOutput(
    packOutput,
    artifactDirectory
  )

  if (!options.sourceDirectory)
    return {
      version,
      pluginArtifact,
      runtimeSource: "verified-package",
      cleanup() {},
    }

  const sourceDirectory = realpathSync(resolve(options.sourceDirectory))
  const sourceVersion = packageVersion(join(sourceDirectory, "package.json"))
  if (sourceVersion !== version)
    throw new Error(
      `OpenClaw source ${basename(sourceDirectory)} is ${sourceVersion}, but the Worktable plugin is verified against ${version}. Update the plugin compatibility pin and verify it before using this source checkout.`
    )
  const temporary = mkdtempSync(join(tmpdir(), "worktable-openclaw-source-"))
  try {
    run("pnpm", ["pack", "--pack-destination", temporary], sourceDirectory)
    const runtimeArtifact = newestTarball(temporary)
    return {
      version,
      pluginArtifact,
      runtimeArtifact,
      runtimeSource: "source-checkout",
      cleanup() {
        rmSync(temporary, { recursive: true, force: true })
      },
    }
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true })
    throw error
  }
}
