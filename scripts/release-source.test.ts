import { expect, test } from "bun:test"
import fc from "fast-check"
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  resolveSourceMetadata,
  verifyPublicSourceMetadata,
  verifyReleaseSourceMetadata,
} from "./release-source.ts"
import {
  copyReleaseLicenses,
  verifyReleaseLicenses,
} from "./release-licenses.ts"
import {
  connectorLicenseFiles,
  connectorLicenseBanner,
  verifyConnectorDistribution,
} from "./connector-distribution.ts"
import { expectedConnectorThirdPartyNotices } from "../packages/mcp-connect/scripts/mcpb-notices.ts"

test("detached public connectors carry source-bound licenses without private build metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "worktable-detached-license-"))
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ license: "AGPL-3.0-only" })
    )
    writeFileSync(
      join(root, "LICENSE"),
      "Synthetic license text */ remains inert"
    )
    const source = {
      version: "1.2.3",
      sourceVisibility: "public" as const,
      sourceRepo: "https://github.com/example/synthetic",
      sourceCommit: "a".repeat(40),
      sourceTag: "",
      workflowRunUrl: "",
      sourceUrl: `https://github.com/example/synthetic/tree/${"a".repeat(40)}`,
    }
    const files = {
      ...connectorLicenseFiles(root, source),
      "THIRD_PARTY_NOTICES.md": expectedConnectorThirdPartyNotices("connector"),
    }
    expect(files.LICENSE).toBe(readFileSync(join(root, "LICENSE"), "utf8"))
    expect(JSON.parse(files["SOURCE.json"]!)).toEqual(source)
    expect(files.NOTICE).toContain(source.sourceUrl)
    const artifact = join(root, "connector.mjs")
    const banner = connectorLicenseBanner(files)
    writeFileSync(artifact, banner + "export const synthetic = true;\n")
    verifyConnectorDistribution(root, artifact, source)
    fc.assert(
      fc.property(
        fc.constantFrom(
          "LICENSE",
          "NOTICE",
          "SOURCE.json",
          "THIRD_PARTY_NOTICES.md"
        ),
        fc.string({ maxLength: 50 }),
        (name, replacement) => {
          if (replacement === files[name]) return
          writeFileSync(
            artifact,
            connectorLicenseBanner({ ...files, [name]: replacement })
          )
          expect(() =>
            verifyConnectorDistribution(root, artifact, source)
          ).toThrow()
        }
      )
    )
    expect(() =>
      connectorLicenseFiles(root, {
        ...source,
        workflowRunUrl: "https://example.com/private-run",
      })
    ).toThrow()
    expect(() =>
      connectorLicenseFiles(root, { ...source, sourceVisibility: undefined })
    ).toThrow()
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ license: "UNLICENSED" })
    )
    expect(() => connectorLicenseFiles(root, source)).toThrow()
    expect(
      connectorLicenseFiles(root, {
        ...source,
        sourceVisibility: undefined,
        sourceRepo: "private",
        workflowRunUrl: "private",
      })
    ).toEqual({})
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("AGPL package notices accompany even the minimal standalone installer", () => {
  const root = mkdtempSync(join(tmpdir(), "worktable-release-license-"))
  try {
    mkdirSync(join(root, "plugins/worktable"), { recursive: true })
    writeFileSync(
      join(root, "plugins/worktable/LICENSE"),
      "Scoped integration fixture"
    )
    writeFileSync(join(root, "LICENSE"), "Application license fixture")
    writeFileSync(join(root, "NOTICE"), "Application notice fixture")
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ license: "AGPL-3.0-only" })
    )
    const materials = {
      schemaVersion: 1,
      runtime: {
        name: "Bun",
        version: "1.3.14",
        sourceCommit: "0d9b296af33f2b851fcbf4df3e9ec89751734ba4",
      },
      sourceArchive: {
        url: "https://example.com/runtime-source.tar.gz",
        sha256: "a".repeat(64),
        bytes: 123,
      },
    }
    const materialsPath = join(root, "SOURCE-MATERIALS.json")
    const destination = join(root, "public-output")
    expect(() => copyReleaseLicenses(root, destination, "skills")).toThrow()
    writeFileSync(materialsPath, JSON.stringify(materials))
    copyReleaseLicenses(root, destination, "skills")
    for (const path of [
      "LICENSE",
      "NOTICE",
      "SOURCE-MATERIALS.json",
      "plugins/worktable/LICENSE",
    ])
      expect(readFileSync(join(destination, "licenses", path))).toEqual(
        readFileSync(join(root, path))
      )
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 20 }), (suffix) => {
        for (const mutation of [
          {
            ...materials,
            runtime: { ...materials.runtime, version: `unreviewed-${suffix}` },
          },
          {
            ...materials,
            runtime: {
              ...materials.runtime,
              sourceCommit: `unreviewed-${suffix}`,
            },
          },
          {
            ...materials,
            sourceArchive: { ...materials.sourceArchive, sha256: suffix },
          },
          {
            ...materials,
            sourceArchive: { ...materials.sourceArchive, bytes: -1 },
          },
          {
            ...materials,
            sourceArchive: {
              ...materials.sourceArchive,
              url: "https://user:secret@example.com/source.tar.gz",
            },
          },
          {
            ...materials,
            sourceArchive: {
              ...materials.sourceArchive,
              url: "https://example.com/source.tar.gz?token=secret",
            },
          },
          {
            ...materials,
            sourceArchive: {
              ...materials.sourceArchive,
              url: "file:///private/source.tar.gz",
            },
          },
          { ...materials, privateBuildPath: `${root}/${suffix}` },
          null,
        ]) {
          writeFileSync(materialsPath, JSON.stringify(mutation))
          expect(() =>
            copyReleaseLicenses(root, destination, "skills")
          ).toThrow()
        }
        writeFileSync(materialsPath, JSON.stringify(materials))
        writeFileSync(
          join(destination, "licenses/SOURCE-MATERIALS.json"),
          `${JSON.stringify(materials)}${suffix}`
        )
        expect(() =>
          verifyReleaseLicenses(root, destination, "skills")
        ).toThrow(
          "Release notice differs from its source: SOURCE-MATERIALS.json"
        )
        copyReleaseLicenses(root, destination, "skills")
      }),
      { numRuns: 6 }
    )
    rmSync(join(root, "NOTICE"))
    expect(() =>
      copyReleaseLicenses(root, join(root, "incomplete-output"), "skills")
    ).toThrow()
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ license: "UNLICENSED" })
    )
    const privateDestination = join(root, "private-output")
    copyReleaseLicenses(root, privateDestination, "skills")
    expect(existsSync(join(privateDestination, "licenses/LICENSE"))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function withPublicSource(
  run: (fixture: {
    root: string
    git: (...args: string[]) => string
    packageFile: string
    repository: string
    writePackage: (license: string) => void
    commit: string
    env: Record<string, string>
    publicMetadata: ReturnType<typeof resolveSourceMetadata>
  }) => void
): void {
  const root = mkdtempSync(join(tmpdir(), "worktable-source-identity-"))
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(
      ["git", "-c", "core.hooksPath=/dev/null", ...args],
      { cwd: root }
    )
    if (!result.success) throw new Error(result.stderr.toString())
    return result.stdout.toString().trim()
  }
  const packageFile = join(root, "package.json")
  const repository = "https://github.com/example/public-source"
  const writePackage = (license: string) =>
    writeFileSync(packageFile, JSON.stringify({ license, version: "1.2.3" }))
  try {
    git("init", "--initial-branch=main")
    git("config", "user.name", "Source identity fixture")
    git("config", "user.email", "fixture@example.invalid")
    git("remote", "add", "origin", repository + ".git")
    writePackage("AGPL-3.0-only")
    writeFileSync(join(root, ".gitignore"), "nested/\n.env\n.env.*\n*.pem\n")
    git("add", "package.json", ".gitignore")
    git("commit", "-m", "Public source fixture")
    const commit = git("rev-parse", "HEAD")
    const env = {
      WORKTABLE_PUBLIC_SOURCE_REPOSITORY: repository,
      WORKTABLE_PUBLIC_SOURCE_COMMIT: commit,
      GITHUB_REPOSITORY: "private-owner/private-repository",
      GITHUB_SHA: "a".repeat(40),
      GITHUB_REF_NAME: "private-branch",
      GITHUB_RUN_ID: "1234",
      WORKTABLE_RELEASE_TAG: "private-tag",
    }
    const publicMetadata = resolveSourceMetadata(root, env)
    run({
      root,
      git,
      packageFile,
      repository,
      writePackage,
      commit,
      env,
      publicMetadata,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test("public source identity excludes ambient runner tags and version overrides", () => {
  withPublicSource(({ git, root, repository, commit, env, publicMetadata }) => {
    expect(publicMetadata.sourceUrl).toBe(`${repository}/tree/${commit}`)
    expect(publicMetadata.sourceTag).toBe("")
    expect(publicMetadata.workflowRunUrl).toBe("")
    expect(JSON.stringify(publicMetadata)).not.toContain("private-")
    verifyPublicSourceMetadata(publicMetadata)
    // A matching local tag is still private ambient state unless explicitly
    // captured for this public release. Both missing and mismatched tags fail.
    git("tag", "private-runner-only-tag")
    expect(resolveSourceMetadata(root, env)).toEqual(publicMetadata)
    expect(() =>
      resolveSourceMetadata(root, {
        ...env,
        WORKTABLE_PUBLIC_SOURCE_TAG: "v1.2.3",
      })
    ).toThrow()
    git("tag", "v1.2.3")
    expect(resolveSourceMetadata(root, env)).toEqual(publicMetadata)
    expect(
      resolveSourceMetadata(root, {
        ...env,
        WORKTABLE_PUBLIC_SOURCE_TAG: "v1.2.3",
      }).sourceTag
    ).toBe("v1.2.3")
    expect(() =>
      resolveSourceMetadata(root, {
        ...env,
        WORKTABLE_PUBLIC_SOURCE_TAG: "private-runner-only-tag",
      })
    ).toThrow()
    expect(() =>
      verifyPublicSourceMetadata({
        ...publicMetadata,
        sourceTag: "private-runner-only-tag",
      })
    ).toThrow()

    expect(() =>
      resolveSourceMetadata(root, { ...env, WORKTABLE_VERSION: "9.9.9" })
    ).toThrow("version")
    expect(
      resolveSourceMetadata(root, { ...env, WORKTABLE_VERSION: "1.2.3" })
    ).toEqual(publicMetadata)
    for (const key of ["VITE_API_URL", "VITE_WS_URL"])
      expect(() =>
        resolveSourceMetadata(root, {
          ...env,
          [key]: "https://private.invalid",
        })
      ).toThrow("VITE_")
  })
})

test("public builds reject ignored environment and packaged asset inputs", () => {
  withPublicSource(({ root, git, env }) => {
    for (const directory of [
      "",
      "apps/web",
      "packages/mcp-connect",
      "packages/openclaw-plugin",
    ]) {
      mkdirSync(join(root, directory), { recursive: true })
      for (const name of [
        ".env",
        ".env.local",
        ".env.production",
        ".env.production.local",
      ]) {
        const path = join(root, directory, name)
        writeFileSync(path, "VITE_API_URL=https://private.invalid\n")
        expect(git("status", "--porcelain")).toBe("")
        expect(() => resolveSourceMetadata(root, env)).toThrow(
          "environment files"
        )
        rmSync(path)
      }
    }
    for (const directory of [
      "apps/web/public",
      "packages/openclaw-plugin/skills",
    ]) {
      mkdirSync(join(root, directory), { recursive: true })
      const ignoredAsset = join(root, directory, "private.pem")
      writeFileSync(ignoredAsset, "synthetic ignored asset")
      expect(git("status", "--porcelain")).toBe("")
      expect(() => resolveSourceMetadata(root, env)).toThrow("ignored files")
      rmSync(ignoredAsset)
    }
  })
})

test("public source identity recovers after each rejected repository state", () => {
  withPublicSource(
    ({
      root,
      git,
      packageFile,
      repository,
      writePackage,
      env,
      publicMetadata,
    }) => {
      // Each mutation breaks the same publication boundary; randomize their
      // order to prove a rejected state cannot contaminate the next valid build.
      const mutations = [
        "commit",
        "origin",
        "tracked",
        "untracked",
        "license",
        "missing",
        "nested",
      ] as const
      fc.assert(
        fc.property(
          fc.shuffledSubarray([...mutations], {
            minLength: mutations.length,
            maxLength: mutations.length,
          }),
          (order) => {
            for (const mutation of order) {
              const candidateEnv = { ...env }
              let candidateRoot = root
              if (mutation === "commit")
                candidateEnv.WORKTABLE_PUBLIC_SOURCE_COMMIT = "b".repeat(40)
              if (mutation === "origin")
                git(
                  "remote",
                  "set-url",
                  "origin",
                  "https://github.com/example/wrong-source"
                )
              if (mutation === "tracked")
                writeFileSync(
                  packageFile,
                  JSON.stringify({ license: "AGPL-3.0-only", name: "changed" })
                )
              if (mutation === "untracked")
                writeFileSync(join(root, "private.txt"), "fixture")
              if (mutation === "license") writePackage("UNLICENSED")
              if (mutation === "missing")
                candidateEnv.WORKTABLE_PUBLIC_SOURCE_COMMIT = ""
              if (mutation === "nested") {
                candidateRoot = join(root, "nested")
                mkdirSync(candidateRoot)
                writeFileSync(
                  join(candidateRoot, "package.json"),
                  JSON.stringify({ license: "AGPL-3.0-only" })
                )
              }
              expect(() =>
                resolveSourceMetadata(candidateRoot, candidateEnv)
              ).toThrow()
              if (mutation === "tracked" || mutation === "license")
                writePackage("AGPL-3.0-only")
              if (mutation === "origin")
                git("remote", "set-url", "origin", repository + ".git")
              if (mutation === "untracked") rmSync(join(root, "private.txt"))
              if (mutation === "nested")
                rmSync(join(root, "nested"), { recursive: true })
              expect(resolveSourceMetadata(root, env)).toEqual(publicMetadata)
            }
          }
        ),
        { numRuns: 3 }
      )
    }
  )
})

test("release metadata must match independently captured public identity", () => {
  withPublicSource(
    ({ root, repository, commit, env, publicMetadata, writePackage }) => {
      for (const sourceRepo of [
        "https://user:secret@github.com/example/public-source",
        repository + "?secret=value",
        repository + "/../private",
        "https://example.invalid/repo",
      ]) {
        expect(() =>
          resolveSourceMetadata(root, {
            ...env,
            WORKTABLE_PUBLIC_SOURCE_REPOSITORY: sourceRepo,
          })
        ).toThrow()
      }
      expect(() =>
        verifyPublicSourceMetadata({
          ...publicMetadata,
          workflowRunUrl: "https://github.com/private/repo/actions/runs/1234",
        })
      ).toThrow()
      expect(() =>
        verifyPublicSourceMetadata({
          ...publicMetadata,
          sourceUrl: repository + "/tree/main",
        })
      ).toThrow()

      expect(() =>
        verifyReleaseSourceMetadata(publicMetadata, "public", publicMetadata)
      ).toThrow("independently captured")
      for (const stale of [
        {
          ...publicMetadata,
          sourceCommit: "b".repeat(40),
          sourceUrl: `${repository}/tree/${"b".repeat(40)}`,
        },
        {
          ...publicMetadata,
          sourceRepo: "https://github.com/example/other-public",
          sourceUrl: `https://github.com/example/other-public/tree/${commit}`,
        },
        { ...publicMetadata, sourceTag: "v1.2.3" },
        { ...publicMetadata, version: "9.9.9" },
      ]) {
        // A coherent manifest/index pair is insufficient: both must match the
        // independently captured checkout, including the explicit tag decision.
        expect(() =>
          verifyReleaseSourceMetadata(stale, "public", stale, publicMetadata)
        ).toThrow("captured checkout")
      }

      // Existing private rehearsals retain their runner provenance contract.
      writePackage("UNLICENSED")
      const privateMetadata = resolveSourceMetadata(root, {
        GITHUB_REPOSITORY: "private-owner/private-repository",
        GITHUB_RUN_ID: "1234",
        GITHUB_REF_NAME: "main",
      })
      expect(privateMetadata.sourceCommit).toBe(commit)
      expect(privateMetadata.workflowRunUrl).toBe(
        "https://github.com/private-owner/private-repository/actions/runs/1234"
      )
      expect(privateMetadata.sourceUrl).toBeUndefined()
      expect(() =>
        verifyReleaseSourceMetadata(
          privateMetadata,
          "public",
          publicMetadata,
          publicMetadata
        )
      ).toThrow()
      expect(() =>
        verifyReleaseSourceMetadata(
          publicMetadata,
          "public",
          privateMetadata,
          publicMetadata
        )
      ).toThrow()
      expect(() =>
        verifyReleaseSourceMetadata(
          {
            ...publicMetadata,
            sourceCommit: "b".repeat(40),
            sourceUrl: `${repository}/tree/${"b".repeat(40)}`,
          },
          "public",
          publicMetadata,
          publicMetadata
        )
      ).toThrow()
      expect(() =>
        verifyReleaseSourceMetadata(
          privateMetadata,
          "public",
          privateMetadata,
          publicMetadata
        )
      ).toThrow()
      fc.assert(
        fc.property(
          fc.subarray(["sourceVisibility", "sourceUrl"] as const, {
            minLength: 1,
          }),
          (removed) => {
            const stripped = { ...publicMetadata }
            for (const key of removed) delete stripped[key]
            expect(() =>
              verifyReleaseSourceMetadata(
                stripped,
                "public",
                stripped,
                publicMetadata
              )
            ).toThrow()
          }
        ),
        { numRuns: 6 }
      )
      expect(
        verifyReleaseSourceMetadata(privateMetadata, "private", privateMetadata)
      ).toBe("private")
      expect(() =>
        verifyReleaseSourceMetadata(publicMetadata, "private", publicMetadata)
      ).toThrow()
      expect(
        verifyReleaseSourceMetadata(
          publicMetadata,
          "public",
          publicMetadata,
          publicMetadata
        )
      ).toBe("public")
    }
  )
})
