import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { verifyPackedArtifact } from "./verify-packed-artifact"

const root = join(import.meta.dir, "..")
const pkg = (await Bun.file(join(root, "package.json")).json()) as {
  name: string
  version: string
}
const artifactDir = join(root, "artifacts")
await mkdir(artifactDir, { recursive: true })

const build = Bun.spawn(["bun", "run", "build"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
})
if ((await build.exited) !== 0) process.exit(1)

const notices = Bun.spawn(
  ["bun", "run", "scripts/verify-third-party-notices.ts"],
  {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  }
)
if ((await notices.exited) !== 0) process.exit(1)

const filename = `${pkg.name.replace(/^@/, "").replaceAll("/", "-")}-${pkg.version}.tgz`
const path = join(artifactDir, filename)
const pack = Bun.spawn(["bun", "pm", "pack", "--filename", path, "--quiet"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
})
if ((await pack.exited) !== 0) process.exit(1)
verifyPackedArtifact(path)

const digest = createHash("sha256")
  .update(await readFile(path))
  .digest("hex")
const checksumPath = `${path}.sha256`
await writeFile(checksumPath, `${digest}  ${basename(path)}\n`, "utf8")

console.log(`Packed ${pkg.name}@${pkg.version}`)
console.log(path)
console.log(checksumPath)
