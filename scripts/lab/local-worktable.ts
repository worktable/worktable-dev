import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import type { SandboxSystem } from "./microsandbox.ts"
import type { LocalSource } from "./types.ts"
import { GUEST_WORKSPACE, stageWorkspace } from "./workspace-seed.ts"
import { releaseOutputNames } from "../release-targets.ts"
import { LAB_EVIDENCE_SCRIPT } from "./evidence-script.ts"

const REPO_ROOT = resolve(import.meta.dirname, "..", "..")
const INSTALLER = join(REPO_ROOT, "scripts", "install.sh")
const LAB_RELEASE_DIRECTORY = releaseOutputNames("lab").artifacts
export const CHECKOUT_ARTIFACT_INPUTS = [
  "apps/cli",
  "apps/web",
  "packages",
  "scripts/build-release.ts",
  "scripts/release-archive.py",
  "scripts/release-source.ts",
  "scripts/release-targets.ts",
  "scripts/release-licenses.ts",
  "scripts/compiled-js-notices.ts",
  "scripts/bun-runtime-notices.ts",
  "scripts/dependency-notices.ts",
  "scripts/browser-notices.ts",
  "scripts/licenses",
  "plugins/worktable/LICENSE",
  "plugins/worktable/skills",
  "plugins/worktable/skill-inventory.json",
  "scripts/install.sh",
  "LICENSE",
  "NOTICE",
  "SOURCE-MATERIALS.json",
  "package.json",
  "bun.lock",
  "tsconfig.json",
] as const
const DIRTY_BUILD_MARKER_SUFFIX = ".worktable-lab-dirty"

export function artifactNameForArch(arch: string): string {
  switch (arch) {
    case "x64":
    case "x86_64":
      return "worktable-linux-x64.tar.gz"
    case "arm64":
    case "aarch64":
      return "worktable-linux-arm64.tar.gz"
    default:
      throw new Error(`Unsupported local lab architecture: ${arch}`)
  }
}

export function prepareCheckoutArtifacts(options: {
  rebuild: boolean
  system: SandboxSystem
}): string[] {
  const artifacts = [
    join(
      REPO_ROOT,
      "dist",
      LAB_RELEASE_DIRECTORY,
      artifactNameForArch(process.arch)
    ),
  ]
  const sourceDirty = checkoutInputsAreDirty()
  if (
    options.rebuild ||
    sourceDirty ||
    artifacts.some(
      (artifact) =>
        !existsSync(artifact) || !checkoutArtifactIsCurrent(artifact)
    )
  ) {
    mkdirSync(join(REPO_ROOT, "dist", LAB_RELEASE_DIRECTORY), {
      recursive: true,
    })
    for (const artifact of artifacts)
      writeFileSync(
        dirtyBuildMarker(artifact),
        "Artifact must not be reused until a clean checkout build succeeds.\n"
      )
    console.log("[lab] building checkout release artifacts")
    options.system.run("bun", ["run", "release:lab"], { inherit: true })
    if (!sourceDirty)
      for (const artifact of artifacts)
        rmSync(dirtyBuildMarker(artifact), { force: true })
  }
  const missing = artifacts.filter((artifact) => !existsSync(artifact))
  if (missing.length > 0)
    throw new Error(
      `Checkout release build did not produce: ${missing.join(", ")}`
    )
  return artifacts
}

export function checkoutArtifactIsCurrent(artifact: string): boolean {
  try {
    const sourceDirty = checkoutInputsAreDirty()
    const dirtyBuildMarkerExists = existsSync(dirtyBuildMarker(artifact))
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim()
    const manifest = JSON.parse(
      execFileSync("tar", ["-xOf", artifact, "./manifest.json"], {
        encoding: "utf8",
      })
    ) as { sourceCommit?: string }
    return artifactMayBeReused({
      sourceDirty,
      dirtyBuildMarkerExists,
      sourceCommitMatches: manifest.sourceCommit === head,
    })
  } catch {
    return false
  }
}

export function checkoutInputsAreDirty(): boolean {
  return (
    execFileSync(
      "git",
      ["status", "--porcelain", "--", ...CHECKOUT_ARTIFACT_INPUTS],
      { cwd: REPO_ROOT, encoding: "utf8" }
    ).trim().length > 0
  )
}

export function dirtyBuildMarker(artifact: string): string {
  return join(
    dirname(dirname(artifact)),
    `.${basename(artifact)}${DIRTY_BUILD_MARKER_SUFFIX}`
  )
}

export function artifactMayBeReused(options: {
  sourceDirty: boolean
  dirtyBuildMarkerExists: boolean
  sourceCommitMatches: boolean
}): boolean {
  return (
    !options.sourceDirty &&
    !options.dirtyBuildMarkerExists &&
    options.sourceCommitMatches
  )
}

export function stageLocalWorktable(options: {
  sandbox: string
  source: LocalSource
  fixture?: string
  checkoutArtifacts?: string[]
  system: SandboxSystem
}): void {
  if (options.source === "checkout") {
    if (!options.checkoutArtifacts || options.checkoutArtifacts.length === 0)
      throw new Error("Checkout source requires prepared release artifacts")
    const artifactNames = options.checkoutArtifacts.map(
      (artifact) => artifact.split("/").at(-1)!
    )
    options.system.run("msb", [
      "copy",
      "--quiet",
      INSTALLER,
      `${options.sandbox}:/tmp/worktable-install.sh`,
    ])
    for (const [index, artifact] of options.checkoutArtifacts.entries()) {
      options.system.run("msb", [
        "copy",
        "--quiet",
        artifact,
        `${options.sandbox}:/tmp/${artifactNames[index]}`,
      ])
    }
    options.system.run(
      "msb",
      ["exec", options.sandbox, "--", "sh", "-s", "--", ...artifactNames],
      { input: STAGE_CHECKOUT }
    )
  }

  stageWorkspace(options.sandbox, options.fixture, options.system)
  options.system.run(
    "msb",
    ["exec", options.sandbox, "--", "sh", "-s", "--", options.source],
    { input: WRITE_HELPERS }
  )
}

const STAGE_CHECKOUT = String.raw`set -eu
install -d -o tester -g tester -m 700 /home/tester/.worktable-lab
install -d -o tester -g tester -m 700 /home/tester/.worktable-lab/releases
install -o tester -g tester -m 700 /tmp/worktable-install.sh /home/tester/.worktable-lab/install.sh
for artifact in "$@"; do
  install -o tester -g tester -m 600 "/tmp/$artifact" "/home/tester/.worktable-lab/releases/$artifact"
  rm -f "/tmp/$artifact"
done
rm -f /tmp/worktable-install.sh
`

const WRITE_HELPERS = String.raw`set -eu
source_kind=$1

install -d -o tester -g tester -m 700 /home/tester/.worktable-lab
install -d -o tester -g tester -m 700 /home/tester/.worktable-lab/evidence

cat >> /home/tester/.worktable-lab-env <<EOF
export PATH="\$HOME/.local/bin:\$PATH"
EOF

if [ "$source_kind" = "release" ]; then
  cat > /home/tester/install-worktable.sh <<EOF
#!/bin/sh
set -eu
curl -fsSL https://worktable.dev/install | sh -s -- \\
  --foreground \\
  --host 0.0.0.0 \\
  --port 7432 \\
  --workspace ${GUEST_WORKSPACE} \\
  "\$@"
EOF
else
  cat > /home/tester/install-worktable.sh <<EOF
#!/bin/sh
set -eu
sh "\$HOME/.worktable-lab/install.sh" \\
  --foreground \\
  --host 0.0.0.0 \\
  --port 7432 \\
  --workspace ${GUEST_WORKSPACE} \\
  --release-base-url "file://\$HOME/.worktable-lab" \\
  --version releases \\
  "\$@"
EOF
fi

cat > /home/tester/launch-worktable.sh <<EOF
#!/bin/sh
set -eu
export PATH="\$HOME/.local/bin:\$PATH"
exec worktable launch --foreground --no-browser --host 0.0.0.0 --port 7432 "\$@"
EOF

cat > /home/tester/bin/lab-evidence <<'WORKTABLE_LAB_EVIDENCE'
${LAB_EVIDENCE_SCRIPT}
WORKTABLE_LAB_EVIDENCE

chown tester:tester /home/tester/.worktable-lab-env /home/tester/install-worktable.sh /home/tester/launch-worktable.sh
chown tester:tester /home/tester/bin/lab-evidence
chmod 600 /home/tester/.worktable-lab-env
chmod 700 /home/tester/install-worktable.sh /home/tester/launch-worktable.sh
chmod 700 /home/tester/bin/lab-evidence
su tester -s /bin/sh -c 'HOME=/home/tester WORKTABLE_LAB_WORKSPACE=${GUEST_WORKSPACE} /home/tester/bin/lab-evidence baseline'
`
