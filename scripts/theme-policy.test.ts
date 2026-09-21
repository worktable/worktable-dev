import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

const SOURCE_GLOB = new Bun.Glob("{apps,packages}/**/*.{css,ts,tsx,astro,mjs}")
const GENERATED_OR_CANONICAL =
  /(?:\.generated\.(?:css|ts)|packages\/ui\/src\/theme\/theme-config\.ts)$/
const SEMANTIC_DEFINITION =
  /--(?:background|foreground|card|popover|secondary|muted|accent|surface-(?:tint|selected)|code-accent-(?:foreground|background)|illustration-accent|border(?:-chrome)?|input|ring|sidebar(?:-[\w-]+)?|well-bg|grid-(?:line|wash))\s*:\s*(?:oklch\(|#[\da-f]{3,8}\b|rgba?\()/i

async function sourceFiles(): Promise<Array<{ path: string; source: string }>> {
  const paths: string[] = []
  for await (const path of SOURCE_GLOB.scan({
    cwd: import.meta.dir + "/..",
    onlyFiles: true,
  })) {
    if (
      path.includes("/node_modules/") ||
      path.includes("/dist/") ||
      path.includes("/.output/") ||
      path.startsWith("apps/desktop/ui/") ||
      path.startsWith("apps/desktop/src-tauri/generated/") ||
      path.startsWith("apps/desktop/src-tauri/target/")
    )
      continue
    paths.push(path)
  }
  return Promise.all(
    paths.map(async (path) => ({
      path,
      source: await readFile(import.meta.dir + "/../" + path, "utf8"),
    }))
  )
}

describe("theme source policy", () => {
  test("structural semantic variables are only hardcoded canonically or generated", async () => {
    const violations: string[] = []
    for (const file of await sourceFiles()) {
      if (GENERATED_OR_CANONICAL.test(file.path)) continue
      file.source.split("\n").forEach((line, index) => {
        if (SEMANTIC_DEFINITION.test(line))
          violations.push(`${file.path}:${index + 1}`)
      })
    }
    expect(violations).toEqual([])
  })
})
