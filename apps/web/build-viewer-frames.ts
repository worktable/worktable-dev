// Writes the viewer frames to a folder, as the web build does under
// `viewers/`. The server runs this for a source checkout with no web build.
//
//   bun apps/web/build-viewer-frames.ts <out-dir>
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { buildPdfViewerFrame, viewerFrameOutput } from "./viewer-frames"

const out = process.argv[2]
if (!out) throw new Error("Usage: build-viewer-frames.ts <out-dir>")
for (const [path, bytes] of viewerFrameOutput(await buildPdfViewerFrame())) {
  const target = join(out, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, bytes)
}
