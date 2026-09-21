import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  checkRepositoryDocument,
  repositoryDocsOnly,
} from "./repository-docs.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "repository-docs-"))
  roots.push(root)
  return root
}

test("only reviewed repository prose and intake paths bypass product verification", () => {
  expect(
    repositoryDocsOnly([
      "README.md",
      "CONTRIBUTING.md",
      ".github/CODEOWNERS",
      ".github/ISSUE_TEMPLATE/bug.yml",
      "docs/images/example.png",
    ])
  ).toBe(true)
  for (const path of [
    "apps/docs/src/content/docs/start.md",
    "docs/open-source/files.json",
    "package.json",
    ".github/workflows/ci.yml",
    "scripts/repository-docs.ts",
    "docs/images/example.ts",
    "docs/unknown.md",
    "packages/server/src/removed.ts",
    "README.md/child.ts",
  ]) {
    expect(repositoryDocsOnly(["README.md", path])).toBe(false)
  }
  expect(repositoryDocsOnly([])).toBe(false)
})

test("checks rendered Markdown destinations without treating code examples as links", () => {
  const root = fixture()
  mkdirSync(join(root, "docs"))
  writeFileSync(join(root, "docs", "a file.md"), "# Present\n")
  writeFileSync(
    join(root, "README.md"),
    "[ok][ref]\n\n[ref]: docs/a%20file.md#heading\n\n`[sample](missing.md)`\n\n```md\n[example](missing.md)\n```\n\n[external](https://example.test/)\n"
  )
  expect(checkRepositoryDocument(root, "README.md")).toEqual([])
  writeFileSync(
    join(root, "README.md"),
    "![image](missing.png)\n[bad](../outside.md)\n"
  )
  expect(checkRepositoryDocument(root, "README.md")).toHaveLength(2)
  writeFileSync(join(root, "overlay.md"), "[guide](docs/a%20file.md)\n")
  expect(checkRepositoryDocument(root, "overlay.md", "README.md")).toEqual([])
})

test("rejects malformed intake YAML and unresolved conflicts", () => {
  const root = fixture()
  writeFileSync(join(root, "bug.yml"), "name: [unterminated\n")
  expect(checkRepositoryDocument(root, "bug.yml")).toHaveLength(1)
  writeFileSync(
    join(root, "README.md"),
    "<<<<<<< branch\ntext\n=======\nother\n>>>>>>> main\n"
  )
  expect(checkRepositoryDocument(root, "README.md")).toHaveLength(1)
})

test("Git classification retains the product side of a rename and falls back on unavailable history", () => {
  const root = fixture()
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root })
    if (result.exitCode) throw new Error(result.stderr.toString())
    return result.stdout.toString().trim()
  }
  git("init", "-b", "main")
  git("config", "user.name", "Synthetic")
  git("config", "user.email", "test@example.invalid")
  writeFileSync(join(root, "product.ts"), "original\n")
  git("add", ".")
  git("commit", "-m", "base")
  const base = git("rev-parse", "HEAD")
  git("mv", "product.ts", "README.md")
  git("commit", "-m", "rename")
  const head = git("rev-parse", "HEAD")
  const classify = (from: string, to: string) =>
    Bun.spawnSync(
      [
        "bun",
        resolve(import.meta.dir, "repository-docs.ts"),
        "--classify",
        from,
        to,
      ],
      { cwd: root }
    )
      .stdout.toString()
      .trim()
  expect(classify(base, head)).toBe("full")
  writeFileSync(join(root, "README.md"), "prose\n")
  git("add", ".")
  git("commit", "-m", "docs")
  expect(classify(head, git("rev-parse", "HEAD"))).toBe("documentation")
  expect(classify("0".repeat(40), head)).toBe("full")
})
