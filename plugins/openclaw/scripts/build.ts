import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const outdir = join(root, "dist")
const artifactDir = join(root, "artifacts")
await rm(outdir, { recursive: true, force: true })
await mkdir(outdir, { recursive: true })
await mkdir(artifactDir, { recursive: true })

const result = await Bun.build({
  entrypoints: ["./index.ts", "./setup-entry.ts"],
  root,
  outdir,
  target: "node",
  format: "esm",
  splitting: false,
  minify: true,
  metafile: true,
  external: ["openclaw", "openclaw/*"],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

await writeFile(
  join(artifactDir, "bundle-metafile.json"),
  `${JSON.stringify(result.metafile, null, 2)}\n`,
  "utf8"
)
