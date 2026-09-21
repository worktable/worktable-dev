import { afterEach, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  applySkillProjection,
  getSkillProjectionStatus,
  inspectSkillSource,
  previewSkillProjection,
  removeOwnedSkillProjectionsForUninstall,
  SkillProjectionError,
  SKILL_PROJECTION_OPERATIONS,
  type SkillProjectionEnvironment,
  type SkillProjectionOperation,
  type SkillProjectionRequest,
} from "./skill-projection.ts"
import type { SkillProjectionTargetId } from "@worktable/types"

const roots: string[] = []

function fixture(): {
  root: string
  env: SkillProjectionEnvironment
} {
  const root = mkdtempSync(join(tmpdir(), "worktable-skill-projection-"))
  roots.push(root)
  const sourceDir = join(root, "source")
  for (const [name, body] of [
    ["worktable-docs", "# Worktable docs\n"],
    ["worktable-records", "# Worktable records\n"],
  ]) {
    mkdirSync(join(sourceDir, name), { recursive: true })
    writeFileSync(join(sourceDir, name, "SKILL.md"), body)
  }
  const env = {
    homeDir: join(root, "home"),
    appDataDir: join(root, "app-data"),
    sourceDir,
    sourceVersion: "1.0.0",
  }
  mkdirSync(env.homeDir, { recursive: true })
  return { root, env }
}

function request(
  operation: SkillProjectionOperation,
  targetId: SkillProjectionTargetId = "agents"
): SkillProjectionRequest {
  return { operation, targetId }
}

function apply(
  operation: SkillProjectionOperation,
  env: SkillProjectionEnvironment,
  targetId: SkillProjectionTargetId = "agents"
) {
  const next = request(operation, targetId)
  const preview = previewSkillProjection(next, env)
  return applySkillProjection(next, preview.planId, env)
}

function targetRoot(
  env: SkillProjectionEnvironment,
  targetId: SkillProjectionTargetId
): string {
  return join(
    env.homeDir,
    targetId === "claude" ? ".claude" : ".agents",
    "skills"
  )
}

function skillFile(
  env: SkillProjectionEnvironment,
  targetId: SkillProjectionTargetId,
  skill: string
): string {
  return join(targetRoot(env, targetId), skill, "SKILL.md")
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe("skill source inventory", () => {
  it("hashes bytes and executable bits but ignores timestamps", () => {
    const { env } = fixture()
    const before = inspectSkillSource(env)
    const skill = join(env.sourceDir, "worktable-docs", "SKILL.md")

    utimesSync(skill, new Date(0), new Date())
    expect(inspectSkillSource(env).packageDigest).toBe(before.packageDigest)

    chmodSync(skill, 0o755)
    expect(inspectSkillSource(env).packageDigest).not.toBe(before.packageDigest)
  })

  it("rejects symbolic links anywhere in the packaged tree", () => {
    const { env } = fixture()
    symlinkSync(
      join(env.sourceDir, "worktable-docs", "SKILL.md"),
      join(env.sourceDir, "worktable-records", "linked.md")
    )

    expect(() => inspectSkillSource(env)).toThrow(SkillProjectionError)
  })

  it("rejects case-conflicting paths when the host filesystem can represent them", () => {
    const { env } = fixture()
    const skill = join(env.sourceDir, "worktable-docs")
    mkdirSync(join(skill, "References"), { recursive: true })
    mkdirSync(join(skill, "references"), { recursive: true })
    writeFileSync(join(skill, "References", "one.md"), "one\n")
    writeFileSync(join(skill, "references", "two.md"), "two\n")

    const distinct = readdirSync(skill).filter(
      (name) => name.toLowerCase() === "references"
    )
    if (distinct.length < 2) return

    expect(() => inspectSkillSource(env)).toThrow(/case-conflicting paths/i)
  })
})

describe("target-based projection lifecycle", () => {
  it("installs the same package into two isolated user targets", () => {
    const { env } = fixture()

    apply("install", env, "agents")
    apply("install", env, "claude")

    expect(
      readFileSync(skillFile(env, "agents", "worktable-docs"), "utf8")
    ).toBe("# Worktable docs\n")
    expect(
      readFileSync(skillFile(env, "claude", "worktable-records"), "utf8")
    ).toBe("# Worktable records\n")
    expect(
      getSkillProjectionStatus({ targetId: "agents" }, env).allowedOperations
    ).toEqual(["remove"])
    expect(getSkillProjectionStatus({ targetId: "claude" }, env).state).toBe(
      "current"
    )
  })

  it("refuses unmanaged same-name directories", () => {
    const { env } = fixture()
    const unmanaged = skillFile(env, "agents", "worktable-docs")
    mkdirSync(join(unmanaged, ".."), { recursive: true })
    writeFileSync(unmanaged, "# Mine\n")

    const status = getSkillProjectionStatus({ targetId: "agents" }, env)
    expect(status.state).toBe("conflict")
    expect(status.allowedOperations).toEqual([])
    expect(previewSkillProjection(request("install"), env).allowed).toBe(false)
    expect(readFileSync(unmanaged, "utf8")).toBe("# Mine\n")
  })

  it("updates only an intact old package", () => {
    const { env } = fixture()
    apply("install", env)
    writeFileSync(
      join(env.sourceDir, "worktable-docs", "SKILL.md"),
      "# Worktable docs v2\n"
    )
    env.sourceVersion = "2.0.0"

    const status = getSkillProjectionStatus({ targetId: "agents" }, env)
    expect(status.state).toBe("outdated")
    expect(status.allowedOperations).toEqual(["update", "remove"])

    apply("update", env)
    expect(
      readFileSync(skillFile(env, "agents", "worktable-docs"), "utf8")
    ).toBe("# Worktable docs v2\n")
    expect(getSkillProjectionStatus({ targetId: "agents" }, env).state).toBe(
      "current"
    )
  })

  it("repairs a missing path only from the matching package", () => {
    const { env } = fixture()
    apply("install", env)
    rmSync(join(targetRoot(env, "agents"), "worktable-docs"), {
      recursive: true,
    })

    const repairable = getSkillProjectionStatus({ targetId: "agents" }, env)
    expect(repairable.state).toBe("missing")
    expect(repairable.allowedOperations).toEqual(["repair", "remove"])
    apply("repair", env)
    expect(existsSync(skillFile(env, "agents", "worktable-docs"))).toBe(true)

    rmSync(join(targetRoot(env, "agents"), "worktable-docs"), {
      recursive: true,
    })
    writeFileSync(
      join(env.sourceDir, "worktable-records", "SKILL.md"),
      "# Worktable records v2\n"
    )
    env.sourceVersion = "2.0.0"

    const mismatched = getSkillProjectionStatus({ targetId: "agents" }, env)
    expect(mismatched.state).toBe("missing")
    expect(mismatched.allowedOperations).toEqual(["remove"])
    expect(previewSkillProjection(request("repair"), env).allowed).toBe(false)
    expect(previewSkillProjection(request("update"), env).allowed).toBe(false)
  })

  it("preserves local edits during remove and drops only exact ownership", () => {
    const { env } = fixture()
    apply("install", env)
    const edited = skillFile(env, "agents", "worktable-docs")
    writeFileSync(edited, "# My local edit\n")

    const status = getSkillProjectionStatus({ targetId: "agents" }, env)
    expect(status.state).toBe("locally-modified")
    expect(status.allowedOperations).toEqual(["remove"])

    apply("remove", env)
    expect(readFileSync(edited, "utf8")).toBe("# My local edit\n")
    expect(
      existsSync(join(targetRoot(env, "agents"), "worktable-records"))
    ).toBe(false)
    expect(getSkillProjectionStatus({ targetId: "agents" }, env).state).toBe(
      "conflict"
    )
  })

  it("removes an exact projection even when the packaged source is unavailable", () => {
    const { env } = fixture()
    apply("install", env)
    rmSync(env.sourceDir, { recursive: true })

    const status = getSkillProjectionStatus({ targetId: "agents" }, env)
    expect(status.state).toBe("current")
    expect(status.allowedOperations).toEqual(["remove"])
    apply("remove", env)
    expect(existsSync(targetRoot(env, "agents"))).toBe(true)
    expect(readdirSync(targetRoot(env, "agents"))).toEqual([])
  })

  it("publishes exactly the operations authorized by the core planner", () => {
    const { env } = fixture()
    const assertParity = () => {
      const status = getSkillProjectionStatus({ targetId: "agents" }, env)
      const allowed = SKILL_PROJECTION_OPERATIONS.filter(
        (operation) => previewSkillProjection(request(operation), env).allowed
      )
      expect(status.allowedOperations).toEqual(allowed)
    }

    assertParity()
    apply("install", env)
    assertParity()
    rmSync(join(targetRoot(env, "agents"), "worktable-docs"), {
      recursive: true,
    })
    assertParity()
  })
})

describe("stale plans, races, and interruption recovery", () => {
  it("rejects a plan when the source or unmanaged target changes", () => {
    const { env } = fixture()
    const sourcePlan = previewSkillProjection(request("install"), env)
    writeFileSync(
      join(env.sourceDir, "worktable-docs", "SKILL.md"),
      "# Changed source\n"
    )
    expect(() =>
      applySkillProjection(request("install"), sourcePlan.planId, env)
    ).toThrow(/changed after preview/i)

    const targetPlan = previewSkillProjection(request("install"), env)
    const unmanaged = skillFile(env, "agents", "worktable-docs")
    mkdirSync(join(unmanaged, ".."), { recursive: true })
    writeFileSync(unmanaged, "# Mine\n")
    expect(() =>
      applySkillProjection(request("install"), targetPlan.planId, env)
    ).toThrow(/changed after preview|unmanaged/i)
    expect(readFileSync(unmanaged, "utf8")).toBe("# Mine\n")
  })

  it("revalidates after staging and preserves a racing local edit", () => {
    const { env } = fixture()
    apply("install", env)
    writeFileSync(
      join(env.sourceDir, "worktable-docs", "SKILL.md"),
      "# Worktable docs v2\n"
    )
    env.sourceVersion = "2.0.0"
    const edited = skillFile(env, "agents", "worktable-docs")
    env.beforeMutationCheck = () => {
      writeFileSync(edited, "# Racing local edit\n")
      env.beforeMutationCheck = undefined
    }

    expect(() => apply("update", env)).toThrow(
      /changed while repair|changed after preview/i
    )
    expect(readFileSync(edited, "utf8")).toBe("# Racing local edit\n")
  })

  it("recovers an interrupted update from transaction-local backup", () => {
    const { env } = fixture()
    apply("install", env)
    writeFileSync(
      join(env.sourceDir, "worktable-docs", "SKILL.md"),
      "# Worktable docs v2\n"
    )
    env.sourceVersion = "2.0.0"
    env.interruptAfter = "backup"

    expect(() => apply("update", env)).toThrow(/interruption/i)
    env.interruptAfter = undefined

    const interrupted = getSkillProjectionStatus({ targetId: "agents" }, env)
    expect(interrupted.state).toBe("incomplete")
    expect(interrupted.allowedOperations).toEqual(["repair", "remove"])

    const recovered = apply("repair", env)
    expect(recovered.recoveredInterruptedTransaction).toBe(true)
    expect(
      readFileSync(skillFile(env, "agents", "worktable-docs"), "utf8")
    ).toBe("# Worktable docs\n")
    expect(recovered.statusAfter.state).toBe("outdated")

    apply("update", env)
    expect(
      readFileSync(skillFile(env, "agents", "worktable-docs"), "utf8")
    ).toBe("# Worktable docs v2\n")
  })

  it("recovers an interrupted update before removing its exact-owned files", () => {
    const { env } = fixture()
    apply("install", env)
    writeFileSync(
      join(env.sourceDir, "worktable-docs", "SKILL.md"),
      "# Worktable docs v2\n"
    )
    env.sourceVersion = "2.0.0"
    env.interruptAfter = "backup"

    expect(() => apply("update", env)).toThrow(/interruption/i)
    env.interruptAfter = undefined

    const removed = apply("remove", env)
    expect(removed.recoveredInterruptedTransaction).toBe(true)
    expect(removed.statusAfter.state).toBe("not-installed")
    expect(existsSync(skillFile(env, "agents", "worktable-docs"))).toBe(false)
  })

  it("can clear an interrupted fresh install after its target root disappears", () => {
    const { env } = fixture()
    env.interruptAfter = "journal"

    expect(() => apply("install", env)).toThrow(/interruption/i)
    env.interruptAfter = undefined
    rmSync(join(env.homeDir, ".agents", "skills"), {
      recursive: true,
      force: true,
    })

    const interrupted = getSkillProjectionStatus({ targetId: "agents" }, env)
    expect(interrupted.state).toBe("incomplete")
    expect(interrupted.allowedOperations).toEqual(["repair", "remove"])
    expect(apply("repair", env).statusAfter.state).toBe("not-installed")
    expect(apply("install", env).statusAfter.state).toBe("current")
  })

  it("serializes mutations under the lifecycle and target locks", () => {
    const { env } = fixture()
    let checked = false
    env.afterLockAcquired = () => {
      if (checked) return
      checked = true
      expect(() => apply("install", env)).toThrow(/already in progress/i)
    }

    apply("install", env)
    expect(checked).toBe(true)
    expect(getSkillProjectionStatus({ targetId: "agents" }, env).state).toBe(
      "current"
    )
  })
})

describe("uninstall and legacy-state safety", () => {
  it("removes exact-owned paths and preserves changed or missing paths", () => {
    const { env } = fixture()
    apply("install", env, "agents")
    apply("install", env, "claude")
    const edited = skillFile(env, "agents", "worktable-docs")
    writeFileSync(edited, "# Keep me\n")
    rmSync(join(targetRoot(env, "agents"), "worktable-records"), {
      recursive: true,
    })

    const result = removeOwnedSkillProjectionsForUninstall(env)

    expect(readFileSync(edited, "utf8")).toBe("# Keep me\n")
    expect(existsSync(targetRoot(env, "claude"))).toBe(true)
    expect(readdirSync(targetRoot(env, "claude"))).toEqual([])
    expect(result.preserved).toEqual([
      expect.objectContaining({
        targetId: "agents",
        modifiedSkillPaths: [join(targetRoot(env, "agents"), "worktable-docs")],
        missingSkillPaths: [
          join(targetRoot(env, "agents"), "worktable-records"),
        ],
      }),
    ])
    expect(result.removed.some((entry) => entry.targetId === "claude")).toBe(
      true
    )
  })

  it("rejects ownership state redirected outside the two allowlisted targets", () => {
    const { root, env } = fixture()
    apply("install", env, "agents")
    const outside = join(root, "outside-skills")
    renameSync(targetRoot(env, "agents"), outside)

    const manifestDir = join(
      env.appDataDir,
      "agent-skills",
      "projections",
      "v2"
    )
    const originalPath = join(manifestDir, readdirSync(manifestDir)[0]!)
    const manifest = JSON.parse(readFileSync(originalPath, "utf8")) as {
      targetId: string
      logicalTargetRoot: string
      resolvedTargetRoot: string
    }
    manifest.logicalTargetRoot = outside
    manifest.resolvedTargetRoot = outside
    const redirectedKey = createHash("sha256")
      .update(`agents\0${outside}`)
      .digest("hex")
      .slice(0, 32)
    writeFileSync(
      join(manifestDir, `${redirectedKey}.json`),
      `${JSON.stringify(manifest)}\n`
    )
    rmSync(originalPath)

    expect(() => removeOwnedSkillProjectionsForUninstall(env)).toThrow(
      /cannot safely resolve a recorded skill projection/i
    )
    expect(existsSync(join(outside, "worktable-docs", "SKILL.md"))).toBe(true)
  })

  it("rejects a symlinked app-data root before uninstall can follow it", () => {
    const { root, env } = fixture()
    apply("install", env, "agents")
    const linkedAppData = join(root, "linked-app-data")
    renameSync(env.appDataDir, linkedAppData)
    writeFileSync(join(linkedAppData, "keep.txt"), "keep\n")
    symlinkSync(linkedAppData, env.appDataDir)

    expect(() => removeOwnedSkillProjectionsForUninstall(env)).toThrow(
      /cannot safely remove a linked or non-directory app-data root/i
    )
    expect(readFileSync(join(linkedAppData, "keep.txt"), "utf8")).toBe("keep\n")
    expect(
      readFileSync(skillFile(env, "agents", "worktable-docs"), "utf8")
    ).toBe("# Worktable docs\n")
  })

  it("treats legacy development state as unowned and never deletes its files", () => {
    const { env } = fixture()
    const legacy = skillFile(env, "agents", "worktable-docs")
    mkdirSync(join(legacy, ".."), { recursive: true })
    writeFileSync(legacy, "# Legacy local bytes\n")
    const legacyState = join(
      env.appDataDir,
      "agent-skills",
      "projections",
      "v1"
    )
    mkdirSync(legacyState, { recursive: true })
    writeFileSync(
      join(legacyState, "development.json"),
      JSON.stringify({ schemaVersion: 1 })
    )

    expect(getSkillProjectionStatus({ targetId: "agents" }, env).state).toBe(
      "conflict"
    )
    const result = removeOwnedSkillProjectionsForUninstall(env)
    expect(result).toEqual({ removed: [], preserved: [] })
    expect(readFileSync(legacy, "utf8")).toBe("# Legacy local bytes\n")
  })
})
