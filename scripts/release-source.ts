import { readFileSync, readdirSync, existsSync, realpathSync } from "node:fs"
import { join } from "node:path"

export interface SourceMetadata {
  version?: string
  sourceRepo: string
  sourceCommit: string
  sourceTag: string
  workflowRunUrl: string
  sourceVisibility?: "public"
  sourceUrl?: string
}

function publicRepository(value: string): string {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
      value
    )
  if (!match || match[2] === "." || match[2] === "..")
    throw new Error(
      "Public source repository must be a GitHub repository without credentials or query parameters"
    )
  return `https://github.com/${match[1]}/${match[2]}`
}

/** Validate outgoing public identity independently of the private build runner. */
export function verifyPublicSourceMetadata(value: SourceMetadata): void {
  if (
    value.sourceVisibility !== "public" ||
    typeof value.version !== "string" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(value.version) ||
    publicRepository(value.sourceRepo) !== value.sourceRepo ||
    !/^[0-9a-f]{40}$/.test(value.sourceCommit) ||
    value.sourceUrl !== `${value.sourceRepo}/tree/${value.sourceCommit}` ||
    value.workflowRunUrl !== "" ||
    typeof value.sourceTag !== "string" ||
    (value.sourceTag !== "" && value.sourceTag !== `v${value.version}`)
  )
    throw new Error(
      "Public release metadata must identify its exact public source without a workflow link"
    )
}

export function verifyReleaseSourceMetadata(
  value: SourceMetadata,
  expectedVisibility: "public" | "private",
  index?: SourceMetadata,
  expectedPublicSource?: SourceMetadata
): "public" | "private" {
  if (expectedVisibility === "public") {
    if (!expectedPublicSource)
      throw new Error(
        "Public verification requires the independently captured source identity"
      )
    verifyPublicSourceMetadata(expectedPublicSource)
    for (const candidate of index ? [value, index] : [value]) {
      verifyPublicSourceMetadata(candidate)
      for (const key of [
        "version",
        "sourceRepo",
        "sourceCommit",
        "sourceTag",
        "sourceUrl",
      ] as const)
        if (candidate[key] !== expectedPublicSource[key])
          throw new Error(
            "Public artifact source identity differs from the captured checkout"
          )
    }
    return "public"
  }
  if (
    value.sourceVisibility !== undefined ||
    value.sourceUrl !== undefined ||
    index?.sourceVisibility !== undefined ||
    index?.sourceUrl !== undefined
  )
    throw new Error(
      "Public artifacts require verification from the AGPL checkout"
    )
  return "private"
}

/** This binds build inputs; it does not approve or perform publication. */
export function resolveSourceMetadata(
  root: string,
  env: NodeJS.ProcessEnv = process.env
): SourceMetadata {
  const git = (args: string[]): string | null => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: root,
      stdout: "pipe",
      stderr: "ignore",
    })
    return result.success ? result.stdout.toString().trim() : null
  }
  const packageJson = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8")
  )
  const license = packageJson.license
  const repository = env["WORKTABLE_PUBLIC_SOURCE_REPOSITORY"]
  const expectedCommit = env["WORKTABLE_PUBLIC_SOURCE_COMMIT"]
  const capturedTag = env["WORKTABLE_PUBLIC_SOURCE_TAG"]
  if (
    license === "AGPL-3.0-only" ||
    repository !== undefined ||
    expectedCommit !== undefined ||
    capturedTag !== undefined
  ) {
    if (license !== "AGPL-3.0-only" || !repository || !expectedCommit)
      throw new Error(
        "Public builds require the AGPL source checkout and explicit public repository and commit"
      )
    if (
      env["WORKTABLE_VERSION"] &&
      env["WORKTABLE_VERSION"] !== packageJson.version
    )
      throw new Error("Public version must match the captured package version")
    if (
      Object.keys(env).some(
        (key) => key.startsWith("VITE_") && env[key] !== undefined
      )
    )
      throw new Error("Public builds cannot consume ambient VITE_ overrides")
    // Bun and Vite load ignored environment files in these build working
    // directories. A clean Git status alone cannot exclude their private data.
    for (const path of [
      "",
      "apps/web",
      "packages/mcp-connect",
      "packages/openclaw-plugin",
    ]) {
      const directory = join(root, path)
      if (
        existsSync(directory) &&
        readdirSync(directory).some(
          (name) =>
            name === ".env" ||
            (name.startsWith(".env.") && name !== ".env.example")
        )
      )
        throw new Error("Public builds cannot consume local environment files")
    }
    // Vite copies public/ verbatim; OpenClaw also accepts an existing skills/
    // staging directory. Neither may absorb ignored local files.
    if (
      git([
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--",
        "apps/web/public",
        "packages/openclaw-plugin/skills",
      ]) !== ""
    )
      throw new Error(
        "Packaged inputs contain ignored files outside the captured source"
      )
    const sourceRepo = publicRepository(repository)
    const sourceCommit = git(["rev-parse", "HEAD"])
    const origin = git(["config", "--get", "remote.origin.url"])
    if (
      !/^[0-9a-f]{40}$/.test(expectedCommit) ||
      sourceCommit !== expectedCommit ||
      !origin ||
      publicRepository(origin) !== sourceRepo ||
      git(["rev-parse", "--show-toplevel"]) !== realpathSync(root) ||
      git(["status", "--porcelain", "--untracked-files=normal"]) !== ""
    )
      throw new Error(
        "Build public artifacts from the clean, captured public commit with its matching origin"
      )
    // Local tags can belong to the private runner. Only the cutover's explicit
    // captured release tag may enter public metadata; absence means no tag.
    const sourceTag = capturedTag || ""
    if (
      sourceTag &&
      (sourceTag !== `v${packageJson.version}` ||
        git(["rev-parse", "--verify", `refs/tags/${sourceTag}^{commit}`]) !==
          sourceCommit)
    )
      throw new Error(
        "Public source tag must be the captured version tag on the exact source commit"
      )
    const metadata: SourceMetadata = {
      version: packageJson.version,
      sourceRepo,
      sourceCommit,
      sourceTag,
      workflowRunUrl: "",
      sourceVisibility: "public",
      sourceUrl: `${sourceRepo}/tree/${sourceCommit}`,
    }
    verifyPublicSourceMetadata(metadata)
    return metadata
  }

  const repo =
    env["GITHUB_REPOSITORY"] ||
    git(["config", "--get", "remote.origin.url"]) ||
    ""
  const runId = env["GITHUB_RUN_ID"]
  return {
    sourceRepo: repo,
    sourceCommit: git(["rev-parse", "HEAD"]) || env["GITHUB_SHA"] || "",
    sourceTag:
      env["WORKTABLE_RELEASE_TAG"] ||
      env["GITHUB_REF_NAME"] ||
      git(["describe", "--tags", "--exact-match"]) ||
      "",
    workflowRunUrl:
      runId && env["GITHUB_REPOSITORY"]
        ? `${env["GITHUB_SERVER_URL"] ?? "https://github.com"}/${env["GITHUB_REPOSITORY"]}/actions/runs/${runId}`
        : "",
  }
}

if (import.meta.main) {
  const manifest = JSON.parse(readFileSync(process.argv[2]!, "utf8"))
  const index = process.argv[3]
    ? JSON.parse(readFileSync(process.argv[3], "utf8"))
    : undefined
  // The checkout is the independent authority. Never let missing or forged
  // outgoing fields downgrade a public release to private verification.
  const license = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")
  ).license
  const expectedVisibility = license === "AGPL-3.0-only" ? "public" : "private"
  const expectedSource =
    expectedVisibility === "public"
      ? resolveSourceMetadata(join(import.meta.dir, ".."))
      : undefined
  console.log(
    verifyReleaseSourceMetadata(
      manifest,
      expectedVisibility,
      index,
      expectedSource
    )
  )
}
