import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  connectorLicenseBanner,
  connectorLicenseFiles,
  connectorBuildSource,
} from "../../../scripts/connector-distribution.ts"
import { connectorThirdPartyNotices } from "./mcpb-notices.ts"

const packageRoot = join(import.meta.dir, "..")
const repoRoot = join(packageRoot, "../..")
const files = connectorLicenseFiles(repoRoot, connectorBuildSource(repoRoot))
const build = await Bun.build({
  entrypoints: [join(packageRoot, "src/connector-main.ts")],
  target: "node",
  format: "esm",
  metafile: true,
})
if (!build.success || !build.outputs[0] || !build.metafile)
  throw new Error(
    `Could not bundle the agent connector: ${build.logs.join("\n")}`
  )
const thirdParty = connectorThirdPartyNotices(
  build.metafile,
  process.cwd(),
  "connector"
)
const bundle =
  connectorLicenseBanner(files) +
  connectorLicenseBanner({ "THIRD_PARTY_NOTICES.md": thirdParty }) +
  (await build.outputs[0].text())
if (process.argv.includes("--stdout")) {
  process.stdout.write(bundle)
} else {
  mkdirSync(join(packageRoot, "dist"), { recursive: true })
  writeFileSync(join(packageRoot, "dist/connect.mjs"), bundle)
}
