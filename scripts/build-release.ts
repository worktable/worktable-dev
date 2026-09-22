import {
  copyFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createHash } from "node:crypto"
import { dirname, join } from "node:path"
import { jsdomBundlePlugin } from "./jsdom-bundle.ts"
import rootPackage from "../package.json" with { type: "json" }
import { resolveSourceMetadata } from "./release-source.ts"
import skillInventory from "../plugins/worktable/skill-inventory.json" with { type: "json" }
import { copyReleaseLicenses } from "./release-licenses.ts"
import { writeCompiledJsNotices } from "./compiled-js-notices.ts"
import {
  assertReviewedBunRuntime,
  writeBunRuntimeNotices,
} from "./bun-runtime-notices.ts"
import {
  parseReleaseProfile,
  releaseOutputNames,
  selectReleaseTargets,
  skillInstallerArtifact,
  type ReleaseTarget,
} from "./release-targets.ts"

// Build standalone server artifacts alongside the local-install CLI. Hosted
// runtimes start the server entry point directly with PORT/HOST and
// WORKTABLE_HOSTED; they do not use the CLI's local-host launch flow.
const root = new URL("..", import.meta.url).pathname
const version = process.env["WORKTABLE_VERSION"] || rootPackage.version
const profile = parseReleaseProfile(process.argv.slice(2))
const selectedTargets = selectReleaseTargets({
  profile,
  platform: process.platform,
  arch: process.arch,
})
// A lab build must not erase or masquerade as the complete public release
// matrix. Keep its one host artifact in a separate disposable output tree.
const outputNames = releaseOutputNames(profile)
const outDir = join(root, "dist", outputNames.artifacts)
const workDir = join(root, "dist", outputNames.work)
const webDist = join(root, "apps", "web", "dist", "client")

function run(cmd: string[], cwd = root): void {
  const result = Bun.spawnSync(cmd, {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, WORKTABLE_VERSION: version },
  })
  if (!result.success) {
    throw new Error(`${cmd.join(" ")} failed with exit code ${result.exitCode}`)
  }
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function copySkillPackage(destination: string): void {
  for (const skill of skillInventory.skills) {
    for (const file of skill.files) {
      const target = join(destination, skill.name, file)
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(join(worktableSkills, skill.name, file), target)
    }
  }
}

const sourceMetadata = resolveSourceMetadata(root)
assertReviewedBunRuntime(Bun)

const compiledMetafiles = new Map<string, Bun.BuildMetafile[]>()

async function buildExecutable(
  target: ReleaseTarget,
  outfile: string,
  entrypoint = join(root, "apps", "cli", "src", "index.ts"),
  label = target.artifact
): Promise<void> {
  console.log(`[release] compiling ${label}`)
  const heartbeat = setInterval(
    () => console.log(`[release] still compiling ${label}`),
    30_000
  )
  let result: Awaited<ReturnType<typeof Bun.build>>
  try {
    result = await Bun.build({
      entrypoints: [entrypoint],
      // The cross-compile platform belongs in compile.target; the top-level
      // `target` only accepts runtime kinds (browser/bun/node/...). Passing the
      // platform at the top level is rejected by Bun 1.2.x.
      compile: { target: target.bunTarget as Bun.Build.CompileTarget, outfile },
      metafile: true,
      define: {
        __WORKTABLE_BUILD_VERSION__: JSON.stringify(version),
        __WORKTABLE_SOURCE_URL__: JSON.stringify(
          sourceMetadata.sourceVisibility === "public"
            ? sourceMetadata.sourceUrl
            : ""
        ),
      },
      plugins: [jsdomBundlePlugin],
    })
  } finally {
    clearInterval(heartbeat)
  }
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error(`bun build --compile failed for ${target.bunTarget}`)
  }
  const destination = dirname(dirname(outfile))
  const metafiles = [
    ...(compiledMetafiles.get(destination) ?? []),
    result.metafile!,
  ]
  compiledMetafiles.set(destination, metafiles)
  writeCompiledJsNotices(metafiles, process.cwd(), destination)
  writeBunRuntimeNotices(Bun, target.bunTarget, dirname(dirname(outfile)))
}

function assertPortableExecutable(path: string): void {
  const bytes = readFileSync(path)
  const forbidden = [root, "xhr-sync-worker.js", "mermaid.core.mjs?instance="]
  for (const pattern of forbidden) {
    if (bytes.includes(Buffer.from(pattern))) {
      throw new Error(
        `Packaged executable contains non-portable reference: ${pattern}`
      )
    }
  }
}

rmSync(outDir, { recursive: true, force: true })
rmSync(workDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
mkdirSync(workDir, { recursive: true })

console.log(`[release] profile=${profile}; building web application`)
run(["bun", "run", "--cwd", "apps/web", "build"])

// The remote-agent connector bundle is platform-neutral JS (runs under Node
// or Bun on the agent machine): build once, copy into every release so the
// server can serve it at /connect.mjs.
run(["bun", "run", "--cwd", "packages/mcp-connect", "build"])
const connectorBundle = join(
  root,
  "packages",
  "mcp-connect",
  "dist",
  "connect.mjs"
)
run(["bun", "run", "--cwd", "packages/mcp-connect", "build:mcpb"])
const claudeDesktopBundle = join(
  root,
  "packages",
  "mcp-connect",
  "dist",
  "worktable-claude-desktop.mcpb"
)
const worktableSkills = join(root, "plugins", "worktable", "skills")

const checksums: string[] = []
const publicConnectorName = "worktable-connect.mjs"
copyFileSync(connectorBundle, join(outDir, publicConnectorName))
checksums.push(
  `${sha256(join(outDir, publicConnectorName))}  ${publicConnectorName}`
)

run(["bun", "run", "--cwd", "packages/openclaw-plugin", "pack:dogfood"])
const openClawPackage = JSON.parse(
  readFileSync(
    join(root, "packages", "openclaw-plugin", "package.json"),
    "utf8"
  )
) as { version: string }
const packedOpenClaw = join(
  root,
  "packages",
  "openclaw-plugin",
  "artifacts",
  `worktable-openclaw-${openClawPackage.version}.tgz`
)
const publicOpenClawName = "worktable-openclaw.tgz"
copyFileSync(packedOpenClaw, join(outDir, publicOpenClawName))
checksums.push(
  `${sha256(join(outDir, publicOpenClawName))}  ${publicOpenClawName}`
)

for (const target of selectedTargets.cli) {
  const releaseName = target.artifact.replace(/\.tar\.gz$/, "")
  const releaseDir = join(workDir, releaseName)
  const binDir = join(releaseDir, "bin")
  const webDir = join(releaseDir, "web")
  mkdirSync(binDir, { recursive: true })

  const executable = join(binDir, "worktable")
  await buildExecutable(target, executable)
  assertPortableExecutable(executable)

  cpSync(webDist, webDir, { recursive: true })
  mkdirSync(join(releaseDir, "connector"), { recursive: true })
  copyFileSync(connectorBundle, join(releaseDir, "connector", "connect.mjs"))
  mkdirSync(join(releaseDir, "integrations"), { recursive: true })
  copyFileSync(
    claudeDesktopBundle,
    join(releaseDir, "integrations", "worktable-claude-desktop.mcpb")
  )
  copySkillPackage(join(releaseDir, "integrations", "worktable-skills"))
  copyReleaseLicenses(root, releaseDir, "cli")
  copyFileSync(
    join(root, "scripts", "install.sh"),
    join(releaseDir, "install.sh")
  )
  writeFileSync(
    join(releaseDir, "manifest.json"),
    JSON.stringify(
      {
        type: "worktable.release",
        version,
        platform: target.platform,
        arch: target.arch,
        bunTarget: target.bunTarget,
        builtAt: new Date().toISOString(),
        staticDirRelative: "web",
        ...sourceMetadata,
      },
      null,
      2
    ) + "\n"
  )

  run([
    "python3",
    "scripts/release-archive.py",
    "create",
    releaseDir,
    join(outDir, target.artifact),
  ])
  checksums.push(`${sha256(join(outDir, target.artifact))}  ${target.artifact}`)
}

// Standalone skill installation is intentionally a separate, minimal release:
// one executable using the shared projection engine, the canonical skill
// package, and metadata. It leaves no Worktable server, app, MCP connection,
// service, launcher, or credential behind.
for (const target of selectedTargets.cli) {
  const artifact = skillInstallerArtifact(target)
  const releaseName = artifact.replace(/\.tar\.gz$/, "")
  const releaseDir = join(workDir, releaseName)
  const binDir = join(releaseDir, "bin")
  mkdirSync(binDir, { recursive: true })

  const executable = join(binDir, "worktable-skill-installer")
  await buildExecutable(
    target,
    executable,
    join(root, "apps", "skill-installer", "src", "index.ts"),
    artifact
  )
  assertPortableExecutable(executable)
  copySkillPackage(join(releaseDir, "skills"))
  copyReleaseLicenses(root, releaseDir, "skills")
  writeFileSync(
    join(releaseDir, "manifest.json"),
    JSON.stringify(
      {
        type: "worktable.skill-installer",
        version,
        platform: target.platform,
        arch: target.arch,
        bunTarget: target.bunTarget,
        builtAt: new Date().toISOString(),
        ...sourceMetadata,
      },
      null,
      2
    ) + "\n"
  )

  run([
    "python3",
    "scripts/release-archive.py",
    "create",
    releaseDir,
    join(outDir, artifact),
  ])
  checksums.push(`${sha256(join(outDir, artifact))}  ${artifact}`)
}

// Hosted tenant server artifacts (see serverTargets). Same shape as a CLI
// release — bin/ + web/ + manifest.json — so the provisioner extracts it the
// same way, but the binary is the server itself and the static dir sits
// beside it (WORKTABLE_STATIC_DIR=<extract>/web).
for (const target of selectedTargets.server) {
  const releaseName = target.artifact.replace(/\.tar\.gz$/, "")
  const releaseDir = join(workDir, releaseName)
  const binDir = join(releaseDir, "bin")
  const webDir = join(releaseDir, "web")
  mkdirSync(binDir, { recursive: true })

  const executable = join(binDir, "worktable-server")
  await buildExecutable(
    target,
    executable,
    join(root, "packages", "server", "src", "index.ts")
  )
  assertPortableExecutable(executable)
  const backupWorker = join(binDir, "worktable-backup")
  await buildExecutable(
    target,
    backupWorker,
    join(root, "packages", "server", "src", "workspace-backup-worker.ts")
  )
  assertPortableExecutable(backupWorker)

  cpSync(webDist, webDir, { recursive: true })
  // Hosted tenants serve /connect.sh + /connect.mjs like any install (the
  // remote-agent pairing flow); the compiled server has no source tree to
  // dev-build from, so the bundle must ship in the artifact. The server
  // resolves it executable-relative: <extract>/connector/connect.mjs.
  mkdirSync(join(releaseDir, "connector"), { recursive: true })
  copyFileSync(connectorBundle, join(releaseDir, "connector", "connect.mjs"))
  mkdirSync(join(releaseDir, "integrations"), { recursive: true })
  copyFileSync(
    claudeDesktopBundle,
    join(releaseDir, "integrations", "worktable-claude-desktop.mcpb")
  )
  copyReleaseLicenses(root, releaseDir, "server")
  writeFileSync(
    join(releaseDir, "manifest.json"),
    JSON.stringify(
      {
        type: "worktable.server-release",
        version,
        platform: target.platform,
        arch: target.arch,
        bunTarget: target.bunTarget,
        builtAt: new Date().toISOString(),
        staticDirRelative: "web",
        binRelative: "bin/worktable-server",
        ...sourceMetadata,
      },
      null,
      2
    ) + "\n"
  )

  run([
    "python3",
    "scripts/release-archive.py",
    "create",
    releaseDir,
    join(outDir, target.artifact),
  ])
  checksums.push(`${sha256(join(outDir, target.artifact))}  ${target.artifact}`)
}

writeFileSync(join(outDir, "checksums.txt"), checksums.join("\n") + "\n")

// Platform-neutral release metadata published as a standalone asset next to
// the tarballs. Installed builds poll <releases>/latest/manifest.json to learn
// the newest published version (packages/server/src/update-check.ts) without
// downloading an artifact. Distinct `type` from the per-platform manifest
// inside each tarball, but the same `version`.
writeFileSync(
  join(outDir, "manifest.json"),
  JSON.stringify(
    {
      type: "worktable.release-index",
      version,
      builtAt: new Date().toISOString(),
      ...sourceMetadata,
    },
    null,
    2
  ) + "\n"
)
console.log(`Wrote local release artifacts to ${outDir}`)
