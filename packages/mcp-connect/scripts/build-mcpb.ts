import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import rootPackage from "../../../package.json" with { type: "json" }
import { writeMcpbNotices } from "./mcpb-notices.ts"
import {
  writeConnectorLicenseFiles,
  connectorBuildSource,
} from "../../../scripts/connector-distribution.ts"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = resolve(packageRoot, "../..")
const distDir = join(packageRoot, "dist")
const stageDir = join(distDir, "mcpb-stage")
const serverDir = join(stageDir, "server")
const output = join(distDir, "worktable-claude-desktop.mcpb")
const version = process.env["WORKTABLE_VERSION"]?.trim() || rootPackage.version
const source = connectorBuildSource(repoRoot)

function run(command: string[]): void {
  const result = Bun.spawnSync(command, {
    cwd: repoRoot,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, WORKTABLE_VERSION: version },
  })
  if (!result.success) {
    throw new Error(
      `${command.join(" ")} failed with exit code ${result.exitCode}`
    )
  }
}

rmSync(stageDir, { recursive: true, force: true })
rmSync(output, { force: true })
mkdirSync(serverDir, { recursive: true })

const build = await Bun.build({
  entrypoints: [join(packageRoot, "src", "bridge-main.ts")],
  target: "node",
  format: "cjs",
  minify: true,
  sourcemap: "none",
  metafile: true,
})
if (!build.success) {
  for (const log of build.logs) console.error(log)
  throw new Error("Could not bundle the Claude Desktop MCP bridge.")
}
const bundledServer = build.outputs[0]
if (!bundledServer)
  throw new Error("The Claude Desktop bridge build produced no output.")
await Bun.write(join(serverDir, "index.js"), bundledServer)
if (!build.metafile)
  throw new Error("The MCPB dependency inventory is missing.")
writeMcpbNotices(build.metafile, process.cwd(), stageDir)
writeConnectorLicenseFiles(repoRoot, stageDir, source)

copyFileSync(
  join(repoRoot, "apps", "web", "public", "pwa-512x512.png"),
  join(stageDir, "icon.png")
)

const manifest = {
  manifest_version: "0.3",
  name: "worktable",
  ...(rootPackage.license === "AGPL-3.0-only"
    ? { license: "AGPL-3.0-only" }
    : {}),
  display_name: "Worktable",
  version,
  description:
    "Connect Claude Desktop to a local or self-hosted Worktable workspace.",
  author: {
    name: "Worktable",
    url: "https://worktable.dev",
  },
  homepage: "https://worktable.dev",
  documentation: "https://docs.worktable.dev/start/connect-your-agent",
  icon: "icon.png",
  tools_generated: true,
  server: {
    type: "node",
    entry_point: "server/index.js",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/server/index.js"],
      env: {
        WORKTABLE_MCP_URL: "${user_config.endpoint}",
        WORKTABLE_MCP_TOKEN: "${user_config.access_token}",
        WORKTABLE_BRIDGE_CLIENT_NAME: "worktable-claude-desktop",
        WORKTABLE_BRIDGE_CLIENT_VERSION: version,
      },
    },
  },
  user_config: {
    endpoint: {
      type: "string",
      title: "Worktable MCP endpoint",
      description: "Copy this URL from Worktable Settings → Agents.",
      required: true,
    },
    access_token: {
      type: "string",
      title: "Access token",
      description:
        "Leave blank for a same-machine loopback Worktable. Otherwise copy the token from Settings → Agents.",
      sensitive: true,
      required: false,
    },
  },
  compatibility: {
    platforms: ["darwin"],
    runtimes: { node: ">=18.0.0" },
  },
}

const manifestPath = join(stageDir, "manifest.json")
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

const serverBundle = readFileSync(join(serverDir, "index.js"))
run(["bun", "x", "mcpb", "validate", manifestPath])
run(["bun", "x", "mcpb", "pack", stageDir, output])

const archive = readFileSync(output)
for (const forbidden of [
  repoRoot,
  "sourceMappingURL",
  "WORKTABLE_MCP_TOKEN=",
  "Bearer wt_",
]) {
  const needle = Buffer.from(forbidden)
  if (serverBundle.includes(needle) || archive.includes(needle)) {
    throw new Error(`MCPB contains forbidden build data: ${forbidden}`)
  }
}

console.log(`Wrote ${output}`)
