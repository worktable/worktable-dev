#!/usr/bin/env bun

// Build the ZIP uploaded to OpenAI's plugin directory. OpenAI's skill scan
// rejects skills that download or run code outside the package, so the
// submission omits the setup skill along with the README and skill inventory
// that describe it. Other hosts install the full package from this repository.

import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import {
  WORKTABLE_PLUGIN_PUBLIC_FILES,
  assertPluginSourceCommitted,
  readPublicPluginFiles,
} from "./export-worktable-plugin.ts"

export const OPENAI_EXCLUDED_SKILLS = ["worktable-setup"] as const

export const WORKTABLE_OPENAI_SUBMISSION_FILES =
  WORKTABLE_PLUGIN_PUBLIC_FILES.filter(
    (path) =>
      path !== "README.md" &&
      path !== "skill-inventory.json" &&
      !OPENAI_EXCLUDED_SKILLS.some((name) => path.startsWith(`skills/${name}/`))
  )

async function main(): Promise<void> {
  const flag = (name: string) => {
    const index = process.argv.indexOf(name)
    return index >= 0 ? process.argv[index + 1] : undefined
  }
  const output = flag("--output")
  const demoRecordingUrl = flag("--demo-recording-url")
  if (!output?.endsWith(".zip")) {
    throw new Error(
      "Usage: bun scripts/package-openai-plugin.ts --output /path/to/worktable-openai.zip [--demo-recording-url https://...]"
    )
  }
  if (
    demoRecordingUrl !== undefined &&
    !/^https:\/\/\S+$/.test(demoRecordingUrl)
  ) {
    throw new Error("--demo-recording-url must be an https URL")
  }
  assertPluginSourceCommitted()
  const files = await readPublicPluginFiles(WORKTABLE_OPENAI_SUBMISSION_FILES)
  // The review recording is submission-only metadata, so it stays out of the
  // public repository and is added to the uploaded manifest here.
  if (demoRecordingUrl) {
    const manifest = JSON.parse(
      new TextDecoder().decode(files.get("plugin.json"))
    ) as { extensions: { "com.openai": { review: Record<string, unknown> } } }
    manifest.extensions["com.openai"].review.demo_recording_url =
      demoRecordingUrl
    files.set(
      "plugin.json",
      new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`)
    )
  }
  const zipPath = resolve(output)
  const staging = await mkdtemp(join(tmpdir(), "worktable-openai-"))
  try {
    for (const [path, contents] of files) {
      await mkdir(dirname(join(staging, path)), { recursive: true })
      await writeFile(join(staging, path), contents)
    }
    await rm(zipPath, { force: true })
    execFileSync(
      "zip",
      ["-q", "-X", zipPath, ...WORKTABLE_OPENAI_SUBMISSION_FILES],
      {
        cwd: staging,
      }
    )
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  console.log(
    `Packaged ${WORKTABLE_OPENAI_SUBMISSION_FILES.length} files for OpenAI: ${zipPath}`
  )
}

if (import.meta.main) {
  await main()
}
