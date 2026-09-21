import { createHash } from "node:crypto"
import { cp, lstat, mkdir, readFile, readdir, rm } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"

const packageRoot = resolve(import.meta.dir, "..")
const repositoryRoot = resolve(packageRoot, "../..")
const canonicalRoot = join(repositoryRoot, "plugins", "worktable")
const canonicalInventory = join(canonicalRoot, "skill-inventory.json")
const canonicalSkills = join(canonicalRoot, "skills")

interface SkillInventory {
  schemaVersion: 1
  skills: Array<{ name: string; files: string[] }>
}

export interface SkillPackageFile {
  path: string
  sha256: string
}

export interface PreparedSkillPackage {
  root: string
  files: SkillPackageFile[]
  generated: boolean
}

function digest(contents: Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex")
}

function portable(path: string): string {
  return path.split(sep).join("/")
}

function assertPortableRelativePath(path: string, label: string): void {
  const segments = path.split("/")
  if (
    path.length === 0 ||
    path.includes("\\") ||
    path.startsWith("/") ||
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === ".."
    )
  ) {
    throw new Error(`${label} must be a portable relative path: ${path}`)
  }
}

function validateInventory(value: unknown): SkillInventory {
  if (
    typeof value !== "object" ||
    value === null ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("skills" in value) ||
    !Array.isArray(value.skills) ||
    value.skills.length === 0
  ) {
    throw new Error("The canonical Worktable skill inventory is invalid")
  }

  const seen = new Set<string>()
  for (const skill of value.skills) {
    if (
      typeof skill !== "object" ||
      skill === null ||
      !("name" in skill) ||
      typeof skill.name !== "string" ||
      !("files" in skill) ||
      !Array.isArray(skill.files) ||
      skill.files.length === 0
    ) {
      throw new Error("The canonical Worktable skill inventory is invalid")
    }
    assertPortableRelativePath(skill.name, "Skill name")
    if (skill.name.includes("/")) {
      throw new Error(`Skill name must be one directory: ${skill.name}`)
    }
    for (const file of skill.files) {
      if (typeof file !== "string") {
        throw new Error("The canonical Worktable skill inventory is invalid")
      }
      assertPortableRelativePath(file, "Skill file")
      const path = `${skill.name}/${file}`
      if (seen.has(path)) {
        throw new Error(`Duplicate canonical skill file: ${path}`)
      }
      seen.add(path)
    }
  }
  return value as SkillInventory
}

export async function inspectSkillPackage(
  root: string
): Promise<SkillPackageFile[]> {
  const resolved = resolve(root)
  const result: SkillPackageFile[] = []

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Error(`Skill packages cannot contain symlinks: ${path}`)
      }
      if (entry.isDirectory()) {
        await visit(path)
        continue
      }
      if (!entry.isFile()) {
        throw new Error(
          `Skill packages may contain only regular files: ${path}`
        )
      }
      const contents = await readFile(path)
      result.push({
        path: portable(relative(resolved, path)),
        sha256: digest(contents),
      })
    }
  }

  await visit(resolved)
  result.sort((left, right) => left.path.localeCompare(right.path, "en"))
  if (result.length === 0)
    throw new Error("The OpenClaw skill package is empty")
  return result
}

export async function prepareSkillPackage(): Promise<PreparedSkillPackage> {
  const destination = join(packageRoot, "skills")
  let destinationInfo: Awaited<ReturnType<typeof lstat>> | null
  try {
    destinationInfo = await lstat(destination)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    destinationInfo = null
  }
  if (destinationInfo) {
    if (!destinationInfo.isDirectory() || destinationInfo.isSymbolicLink()) {
      throw new Error("The OpenClaw skill package must be a directory")
    }
    return {
      root: destination,
      files: await inspectSkillPackage(destination),
      generated: false,
    }
  }

  let inventoryInfo: Awaited<ReturnType<typeof lstat>> | null
  try {
    inventoryInfo = await lstat(canonicalInventory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    inventoryInfo = null
  }
  if (!inventoryInfo) {
    return {
      root: destination,
      files: await inspectSkillPackage(destination),
      generated: false,
    }
  }
  if (!inventoryInfo.isFile() || inventoryInfo.isSymbolicLink()) {
    throw new Error(
      "The canonical Worktable skill inventory must be a regular file"
    )
  }

  const inventory = validateInventory(
    JSON.parse(await readFile(canonicalInventory, "utf8"))
  )

  await rm(destination, { recursive: true, force: true })
  try {
    await mkdir(destination, { recursive: true })
    for (const skill of inventory.skills) {
      for (const file of skill.files) {
        const source = join(canonicalSkills, skill.name, file)
        const sourceInfo = await lstat(source)
        if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
          throw new Error(`Canonical skill file must be regular: ${source}`)
        }
        const target = join(destination, skill.name, file)
        await mkdir(dirname(target), { recursive: true })
        await cp(source, target, { force: true })
      }
    }
    return {
      root: destination,
      files: await inspectSkillPackage(destination),
      generated: true,
    }
  } catch (error) {
    await rm(destination, { recursive: true, force: true })
    throw error
  }
}

export async function cleanPreparedSkillPackage(
  prepared: PreparedSkillPackage
): Promise<void> {
  if (prepared.generated) {
    await rm(prepared.root, { recursive: true, force: true })
  }
}
