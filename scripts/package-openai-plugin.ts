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
  const outputFlag = process.argv.indexOf("--output")
  const output = outputFlag >= 0 ? process.argv[outputFlag + 1] : undefined
  if (!output?.endsWith(".zip")) {
    throw new Error(
      "Usage: bun scripts/package-openai-plugin.ts --output /path/to/worktable-openai.zip"
    )
  }
  assertPluginSourceCommitted()
  const files = await readPublicPluginFiles(WORKTABLE_OPENAI_SUBMISSION_FILES)
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
