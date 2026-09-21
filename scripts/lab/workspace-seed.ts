import { execFileSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { buildProvenanceManifest } from "./manifest-provenance.ts"
import type { SandboxSystem } from "./microsandbox.ts"

export const FIXTURE_SLUGS = [
  "basic-docs",
  "engineer",
  "founder",
  "product-manager",
  "wiki-links",
] as const

export type FixtureSlug = (typeof FIXTURE_SLUGS)[number]

const REPO_ROOT = resolve(import.meta.dirname, "..", "..")
const FIXTURE_ROOT = join(REPO_ROOT, "fixtures", "workspaces")
export const GUEST_WORKSPACE = "/home/tester/Worktable"

export function fixturePath(slug: string): string {
  if (!FIXTURE_SLUGS.includes(slug as (typeof FIXTURE_SLUGS)[number])) {
    throw new Error(
      `Unknown fixture ${slug}; choose one of: ${FIXTURE_SLUGS.join(", ")}`
    )
  }
  const path = join(FIXTURE_ROOT, slug)
  if (!existsSync(join(path, "worktable.workspace.json"))) {
    throw new Error(`Fixture is incomplete or missing: ${path}`)
  }
  return path
}

/**
 * Copy a committed fixture into a host-owned lab target. The source is never
 * mounted or changed, and the copied workspace receives a fresh portable id.
 */
export function stageHostWorkspace(
  target: string,
  fixture: string
): "empty" | "fixture" {
  if (existsSync(target))
    throw new Error(`Refusing to replace an existing lab workspace: ${target}`)
  if (fixture === "empty") {
    mkdirSync(target, { recursive: false, mode: 0o700 })
    return "empty"
  }

  const source = fixturePath(fixture)
  const pending = [source]
  while (pending.length > 0) {
    const directory = pending.pop()!
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry)
      const info = lstatSync(path)
      if (info.isSymbolicLink())
        throw new Error(`Fixture contains an unsupported symlink: ${path}`)
      if (info.isDirectory()) pending.push(path)
    }
  }
  try {
    cpSync(source, target, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
    })
    writeFileSync(
      join(target, "worktable.workspace.json"),
      `${JSON.stringify(
        buildProvenanceManifest(source, {
          mode: "fixture",
          label: fixture,
          fixtureName: fixture,
        }),
        null,
        2
      )}\n`,
      { mode: 0o600 }
    )
    return "fixture"
  } catch (error) {
    rmSync(target, { recursive: true, force: true })
    throw error
  }
}

export function stageWorkspace(
  sandbox: string,
  fixture: string | undefined,
  system: SandboxSystem
): void {
  if (fixture === undefined) return
  if (fixture === "empty") {
    system.run("msb", [
      "exec",
      sandbox,
      "--",
      "install",
      "-d",
      "-o",
      "tester",
      "-g",
      "tester",
      GUEST_WORKSPACE,
    ])
    return
  }

  const source = fixturePath(fixture)
  const temp = mkdtempSync(join(tmpdir(), "worktable-lab-seed-"))
  const archive = join(temp, "workspace.tar")
  const manifest = join(temp, "worktable.workspace.json")
  try {
    execFileSync("tar", ["-C", source, "-cf", archive, "."])
    writeFileSync(
      manifest,
      `${JSON.stringify(
        buildProvenanceManifest(source, {
          mode: "fixture",
          label: fixture,
          fixtureName: fixture,
        }),
        null,
        2
      )}\n`
    )
    system.run("msb", [
      "copy",
      "--quiet",
      archive,
      `${sandbox}:/tmp/worktable-seed.tar`,
    ])
    system.run("msb", [
      "copy",
      "--quiet",
      manifest,
      `${sandbox}:/tmp/worktable-seed-manifest.json`,
    ])
    system.run(
      "msb",
      ["exec", sandbox, "--", "sh", "-s", "--", GUEST_WORKSPACE],
      {
        input: EXTRACT_WORKSPACE,
      }
    )
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

const EXTRACT_WORKSPACE = String.raw`set -eu
workspace=$1
case "$workspace" in
  /home/tester/*) ;;
  *) echo "Refusing unsafe guest workspace: $workspace" >&2; exit 1 ;;
esac
test ! -e "$workspace"
install -d -o tester -g tester "$workspace"
tar -C "$workspace" -xf /tmp/worktable-seed.tar
mv /tmp/worktable-seed-manifest.json "$workspace/worktable.workspace.json"
chown -R tester:tester "$workspace"
rm -f /tmp/worktable-seed.tar
`
