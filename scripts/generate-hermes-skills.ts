// Hermes installs plugins straight from Git, so the Hermes plugin carries a
// checked-in copy of the agent plugin's skills. This keeps it identical to the
// canonical sources.
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { skillSourcePath, WORKTABLE_BUNDLED_SKILLS } from "./skill-inventory"

const check = process.argv.slice(2).includes("--check")
const repositoryRoot = join(import.meta.dir, "..")
const destination = join(repositoryRoot, "packages", "hermes-plugin", "skills")
// The OpenAI listing overlay has no meaning to Hermes.
const HERMES_SKILL_FILES = new Set(["SKILL.md", "LICENSE"])

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort()
}

const expected = new Map<string, string>()
for (const skill of WORKTABLE_BUNDLED_SKILLS) {
  for (const file of skill.files.filter((name) =>
    HERMES_SKILL_FILES.has(name)
  )) {
    expected.set(
      join(skill.name, file),
      await readFile(skillSourcePath(repositoryRoot, skill, file), "utf8")
    )
  }
}

if (check) {
  const actual = await listFiles(destination).catch(() => [])
  const stale = [...new Set([...actual, ...expected.keys()])].filter(
    (path) => !expected.has(path) || !actual.includes(path)
  )
  for (const [path, contents] of expected) {
    if (
      actual.includes(path) &&
      (await readFile(join(destination, path), "utf8")) !== contents
    ) {
      stale.push(path)
    }
  }
  if (stale.length > 0) {
    throw new Error(
      `Hermes plugin skills are stale: ${stale.sort().join(", ")}. Run 'bun run generate:hermes-skills' and commit the result.`
    )
  }
  console.log(`Verified ${WORKTABLE_BUNDLED_SKILLS.length} Hermes skills`)
} else {
  await rm(destination, { recursive: true, force: true })
  for (const [path, contents] of expected) {
    await mkdir(dirname(join(destination, path)), { recursive: true })
    await writeFile(join(destination, path), contents)
  }
  console.log(`Wrote ${WORKTABLE_BUNDLED_SKILLS.length} Hermes skills`)
}
