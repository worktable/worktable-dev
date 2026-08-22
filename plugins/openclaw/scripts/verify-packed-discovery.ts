import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"

const packageRoot = resolve(import.meta.dir, "..")
const repositoryRoot = resolve(packageRoot, "../..")
const pkg = (await Bun.file(join(packageRoot, "package.json")).json()) as {
  name: string
  version: string
}
const artifact = resolve(
  process.argv[2] ??
    join(
      packageRoot,
      "artifacts",
      `${pkg.name.replace(/^@/, "").replaceAll("/", "-")}-${pkg.version}.tgz`
    )
)
const openClawEntrypoint = [
  join(repositoryRoot, "node_modules", "openclaw", "openclaw.mjs"),
  join(packageRoot, "node_modules", "openclaw", "openclaw.mjs"),
].find((candidate) => Bun.file(candidate).size > 0)
if (!openClawEntrypoint) {
  throw new Error("OpenClaw is not installed; run bun install first")
}

const entries = execFileSync("tar", ["-tzf", artifact], {
  encoding: "utf8",
})
  .split(/\r?\n/)
  .filter(Boolean)
const expectedNames = entries
  .map((entry) => /^package\/skills\/([^/]+)\/SKILL\.md$/.exec(entry)?.[1])
  .filter((value): value is string => Boolean(value))
  .sort((left, right) => left.localeCompare(right, "en"))
if (
  expectedNames.length === 0 ||
  new Set(expectedNames).size !== expectedNames.length
) {
  throw new Error(
    `Expected distinct Worktable skills in ${basename(artifact)}, found ${expectedNames.length}`
  )
}

const temporary = await mkdtemp(join(tmpdir(), "worktable-openclaw-skills-"))
try {
  const home = join(temporary, "home")
  const state = join(temporary, "state")
  const env = {
    ...process.env,
    HOME: home,
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: join(state, "openclaw.json"),
  }
  const node = process.env["WORKTABLE_OPENCLAW_NODE"]?.trim() || "node"
  const run = (args: string[], capture = false): string =>
    execFileSync(node, [openClawEntrypoint, ...args], {
      cwd: temporary,
      env,
      encoding: "utf8",
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    }) as string

  run(["plugins", "install", artifact, "--pin"])
  run(["plugins", "enable", "worktable"])
  const payload = JSON.parse(run(["skills", "list", "--json"], true)) as {
    skills?: Array<{
      name?: string
      eligible?: boolean
      disabled?: boolean
    }>
  }
  const byName = new Map(
    (payload.skills ?? []).map((skill) => [skill.name, skill] as const)
  )
  for (const name of expectedNames) {
    const skill = byName.get(name)
    if (!skill) throw new Error(`Enabled plugin did not expose ${name}`)
    if (skill.disabled || skill.eligible !== true) {
      throw new Error(`Enabled plugin exposed ${name}, but it is not eligible`)
    }
  }
  console.log(
    `OpenClaw discovered all ${expectedNames.length} Worktable skills from ${basename(artifact)}`
  )
} finally {
  await rm(temporary, { recursive: true, force: true })
}
