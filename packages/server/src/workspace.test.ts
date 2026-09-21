import { describe, it, expect, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import fc from "fast-check";
import {
  classifyWorkspaceTarget,
  ensureWorkspaceManifest,
  getSpacesDir,
  getVersionsDir,
  getWorkspaceManifestPath,
  getWorkspaceRoot,
  inspectWorkspaceTarget,
  isWorkspaceManifest,
  prepareWorkspaceTarget,
  setWorkspaceRootOverride,
  WorkspaceAdoptionError,
  WorkspacePreparationError,
  type WorkspaceManifest,
} from "./workspace.ts";

const ORIGINAL_ENV = process.env["WORKTABLE_WORKSPACE"];

afterEach(() => {
  setWorkspaceRootOverride(null);
  if (ORIGINAL_ENV === undefined) {
    delete process.env["WORKTABLE_WORKSPACE"];
  } else {
    process.env["WORKTABLE_WORKSPACE"] = ORIGINAL_ENV;
  }
});

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function validManifest(
  overrides: Partial<WorkspaceManifest> = {}
): WorkspaceManifest {
  return {
    type: "worktable.workspace",
    version: 1,
    id: "ws_existing-id",
    name: "My Workspace",
    createdAt: "2024-01-01T00:00:00.000Z",
    cloud: { status: "unlinked" },
    ...overrides,
  };
}

function writeManifest(dir: string, contents: string): string {
  const path = join(dir, "worktable.workspace.json");
  writeFileSync(path, contents);
  return path;
}

describe("workspace root resolution", () => {
  it("defaults to ~/Worktable", () => {
    delete process.env["WORKTABLE_WORKSPACE"];
    expect(getWorkspaceRoot()).toBe(join(homedir(), "Worktable"));
  });

  it("uses WORKTABLE_WORKSPACE when set", () => {
    process.env["WORKTABLE_WORKSPACE"] = "/tmp/my-workspace";
    expect(getWorkspaceRoot()).toBe("/tmp/my-workspace");
  });

  it("resolves a relative WORKTABLE_WORKSPACE against cwd", () => {
    process.env["WORKTABLE_WORKSPACE"] = "relative-workspace";
    expect(getWorkspaceRoot()).toBe(resolve("relative-workspace"));
  });

  it("ignores a blank WORKTABLE_WORKSPACE", () => {
    process.env["WORKTABLE_WORKSPACE"] = "   ";
    expect(getWorkspaceRoot()).toBe(join(homedir(), "Worktable"));
  });

  it("prefers the test override over env and default", () => {
    process.env["WORKTABLE_WORKSPACE"] = "/tmp/env-workspace";
    setWorkspaceRootOverride("/tmp/override-workspace");
    expect(getWorkspaceRoot()).toBe("/tmp/override-workspace");
  });

  it("derives spaces and versions dirs from the same root", () => {
    setWorkspaceRootOverride("/tmp/ws");
    expect(getSpacesDir()).toBe(join("/tmp/ws", "spaces"));
    expect(getVersionsDir()).toBe(join("/tmp/ws", "versions"));
  });

  it("creates a stable workspace manifest without requiring existing content", async () => {
    const root = tempDir("worktable-ws-manifest-");
    try {
      setWorkspaceRootOverride(root);
      const manifest = ensureWorkspaceManifest();
      expect(manifest).toMatchObject({
        type: "worktable.workspace",
        version: 1,
        name: "Local Workspace",
        cloud: { status: "unlinked" },
        onboarding: { version: 1, status: "pending" },
      });
      expect(manifest.id).toMatch(/^ws_/);
      expect(existsSync(getWorkspaceManifestPath())).toBe(true);

      const persisted = JSON.parse(
        await readFile(getWorkspaceManifestPath(), "utf8")
      );
      expect(persisted.id).toBe(manifest.id);
      expect(ensureWorkspaceManifest().id).toBe(manifest.id);
    } finally {
      setWorkspaceRootOverride(null);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("classifyWorkspaceTarget", () => {
  it("classifies a missing path as missing", () => {
    const base = tempDir("worktable-classify-");
    try {
      const target = join(base, "does-not-exist");
      expect(classifyWorkspaceTarget(target)).toEqual({ outcome: "missing" });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("classifies an empty directory as empty", () => {
    const dir = tempDir("worktable-classify-empty-");
    try {
      expect(classifyWorkspaceTarget(dir)).toEqual({ outcome: "empty" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a directory with only OS metadata files as empty", () => {
    const dir = tempDir("worktable-classify-dsstore-");
    try {
      writeFileSync(join(dir, ".DS_Store"), "");
      writeFileSync(join(dir, "Thumbs.db"), "");
      writeFileSync(join(dir, ".localized"), "");
      expect(classifyWorkspaceTarget(dir)).toEqual({ outcome: "empty" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adopts every supported workspace version and surfaces its name", () => {
    for (const version of [1, 2] as const) {
      const dir = tempDir("worktable-classify-valid-");
      try {
        writeManifest(
          dir,
          JSON.stringify(validManifest({ version, name: "Acme" }))
        );
        const result = classifyWorkspaceTarget(dir);
        expect(result.outcome).toBe("valid");
        if (result.outcome === "valid") {
          expect(result.name).toBe("Acme");
          expect(result.manifest.id).toBe("ws_existing-id");
          expect(result.manifest.version).toBe(version);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("rejects a non-empty foreign directory without a manifest", () => {
    const dir = tempDir("worktable-classify-foreign-");
    try {
      writeFileSync(join(dir, "notes.txt"), "hello");
      const result = classifyWorkspaceTarget(dir);
      expect(result.outcome).toBe("reject");
      if (result.outcome === "reject") {
        expect(result.reason).toBe("non-empty-non-workspace");
        expect(result.message).toContain(dir);
        expect(result.message).toContain("No changes were made.");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still rejects a folder whose only entry is a dotfolder like .git", () => {
    const dir = tempDir("worktable-classify-dotgit-");
    try {
      writeFileSync(join(dir, ".git"), "");
      const result = classifyWorkspaceTarget(dir);
      expect(result.outcome).toBe("reject");
      if (result.outcome === "reject") {
        expect(result.reason).toBe("non-empty-non-workspace");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a corrupt (unparseable) manifest", () => {
    const dir = tempDir("worktable-classify-corrupt-");
    try {
      writeManifest(dir, "{nope");
      const result = classifyWorkspaceTarget(dir);
      expect(result.outcome).toBe("reject");
      if (result.outcome === "reject") {
        expect(result.reason).toBe("corrupt-manifest");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unsupported manifest versions and malformed manifests", () => {
    for (const contents of [
      JSON.stringify(validManifest({ version: 0 as unknown as 1 })),
      JSON.stringify(validManifest({ version: 3 as unknown as 1 })),
      JSON.stringify(validManifest({ version: 2, id: "" })),
      JSON.stringify(
        validManifest({ version: 2, createdAt: "not-a-timestamp" })
      ),
      JSON.stringify(
        validManifest({
          onboarding: {
            version: 1,
            status: "broken",
          } as unknown as NonNullable<WorkspaceManifest["onboarding"]>,
        })
      ),
      JSON.stringify(
        validManifest({
          onboarding: {
            version: 1,
            status: "complete",
            completedAt: 123,
          } as unknown as NonNullable<WorkspaceManifest["onboarding"]>,
        })
      ),
      JSON.stringify({ type: "worktable.workspace", version: 1 }),
      "[]",
      "42",
    ]) {
      const dir = tempDir("worktable-classify-version-");
      try {
        writeManifest(dir, contents);
        const result = classifyWorkspaceTarget(dir);
        expect(result.outcome).toBe("reject");
        if (result.outcome === "reject") {
          expect(result.reason).toBe("unsupported-version");
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("rejects a regular file at the path", () => {
    const base = tempDir("worktable-classify-file-");
    try {
      const filePath = join(base, "afile");
      writeFileSync(filePath, "data");
      const result = classifyWorkspaceTarget(filePath);
      expect(result.outcome).toBe("reject");
      if (result.outcome === "reject") {
        expect(result.reason).toBe("not-a-directory");
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("rejects a symlink at the workspace root", () => {
    const base = tempDir("worktable-classify-symlink-");
    try {
      const realDir = join(base, "real");
      mkdirSync(realDir, { recursive: true });
      const link = join(base, "link");
      symlinkSync(realDir, link);
      const result = classifyWorkspaceTarget(link);
      expect(result.outcome).toBe("reject");
      if (result.outcome === "reject") {
        expect(result.reason).toBe("symlink");
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("inspectWorkspaceTarget and prepareWorkspaceTarget", () => {
  it("projects the canonical path and portable identity without the full manifest", () => {
    const dir = tempDir("worktable-inspect-valid-");
    try {
      writeManifest(dir, JSON.stringify(validManifest({ name: "Inspected" })));
      expect(inspectWorkspaceTarget(`${dir}/.`)).toEqual({
        outcome: "valid",
        path: resolve(dir),
        workspace: {
          id: "ws_existing-id",
          name: "Inspected",
          createdAt: "2024-01-01T00:00:00.000Z",
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the workspace provider when inspection omits a path", () => {
    const dir = tempDir("worktable-inspect-default-");
    try {
      setWorkspaceRootOverride(dir);
      expect(inspectWorkspaceTarget()).toEqual({ outcome: "empty", path: dir });
    } finally {
      setWorkspaceRootOverride(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates missing and empty workspace targets only for create intent", () => {
    const base = tempDir("worktable-prepare-create-");
    try {
      for (const target of [join(base, "missing"), join(base, "empty")]) {
        if (target.endsWith("empty")) mkdirSync(target);
        const prepared = prepareWorkspaceTarget(target, "create");
        expect(prepared.created).toBe(true);
        expect(prepared.path).toBe(resolve(target));
        expect(prepared.manifest.id).toMatch(/^ws_/);
        expect(
          JSON.parse(
            readFileSync(join(target, "worktable.workspace.json"), "utf8")
          ).id
        ).toBe(prepared.manifest.id);
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("opens a valid workspace without changing its manifest bytes", () => {
    const dir = tempDir("worktable-prepare-open-");
    try {
      const path = writeManifest(
        dir,
        `${JSON.stringify(validManifest({ name: "Keep me" }), null, 4)}\n`
      );
      const before = readFileSync(path);
      const prepared = prepareWorkspaceTarget(dir, "open");
      expect(prepared).toMatchObject({
        path: dir,
        created: false,
        manifest: { id: "ws_existing-id", name: "Keep me" },
      });
      expect(readFileSync(path).equals(before)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses create intent for a valid workspace without rewriting it", () => {
    const dir = tempDir("worktable-prepare-create-existing-");
    try {
      const path = writeManifest(dir, JSON.stringify(validManifest()));
      const before = readFileSync(path);
      expect(() => prepareWorkspaceTarget(dir, "create")).toThrow(
        WorkspacePreparationError
      );
      try {
        prepareWorkspaceTarget(dir, "create");
      } catch (error) {
        expect((error as WorkspacePreparationError).code).toBe(
          "EXPECTED_EMPTY_WORKSPACE"
        );
      }
      expect(readFileSync(path).equals(before)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses open intent for missing and empty targets without creating them", () => {
    const base = tempDir("worktable-prepare-open-absent-");
    try {
      const targets = [join(base, "missing"), join(base, "empty")];
      mkdirSync(targets[1]!);
      for (const target of targets) {
        try {
          prepareWorkspaceTarget(target, "open");
          throw new Error("expected preparation to fail");
        } catch (error) {
          expect(error).toBeInstanceOf(WorkspacePreparationError);
          expect((error as WorkspacePreparationError).code).toBe(
            "EXPECTED_EXISTING_WORKSPACE"
          );
        }
        expect(existsSync(join(target, "worktable.workspace.json"))).toBe(
          false
        );
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("keeps classifier rejection reasons authoritative for every intent", () => {
    const dir = tempDir("worktable-prepare-reject-");
    try {
      writeFileSync(join(dir, "foreign.txt"), "mine");
      for (const intent of ["create", "open", "create-or-open"] as const) {
        try {
          prepareWorkspaceTarget(dir, intent);
          throw new Error("expected preparation to fail");
        } catch (error) {
          expect(error).toBeInstanceOf(WorkspaceAdoptionError);
          expect((error as WorkspaceAdoptionError).reason).toBe(
            "non-empty-non-workspace"
          );
        }
      }
      expect(existsSync(join(dir, "worktable.workspace.json"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ensureWorkspaceManifest adoption + reject", () => {
  it("preserves an existing workspace id across calls", () => {
    const dir = tempDir("worktable-ensure-adopt-");
    try {
      setWorkspaceRootOverride(dir);
      const first = ensureWorkspaceManifest();
      const second = ensureWorkspaceManifest();
      expect(second.id).toBe(first.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adopts every supported manifest without changing its identity", () => {
    for (const version of [1, 2] as const) {
      const dir = tempDir("worktable-ensure-existing-");
      try {
        writeManifest(
          dir,
          JSON.stringify(
            validManifest({ version, name: "Pre-existing" })
          )
        );
        setWorkspaceRootOverride(dir);
        const manifest = ensureWorkspaceManifest();
        expect(manifest.id).toBe("ws_existing-id");
        expect(manifest.name).toBe("Pre-existing");
        expect(manifest.version).toBe(version);
      } finally {
        setWorkspaceRootOverride(null);
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("throws WorkspaceAdoptionError on a corrupt manifest WITHOUT overwriting it", () => {
    const dir = tempDir("worktable-ensure-corrupt-");
    try {
      const path = writeManifest(dir, "{nope");
      const before = readFileSync(path);
      setWorkspaceRootOverride(dir);
      let thrown: unknown;
      try {
        ensureWorkspaceManifest();
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(WorkspaceAdoptionError);
      expect((thrown as WorkspaceAdoptionError).reason).toBe(
        "corrupt-manifest"
      );
      const after = readFileSync(path);
      expect(after.equals(before)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws on an unsupported-version manifest and leaves the file untouched", () => {
    const dir = tempDir("worktable-ensure-version-");
    try {
      const path = writeManifest(
        dir,
        JSON.stringify(validManifest({ version: 3 as unknown as 1 }))
      );
      const before = readFileSync(path);
      setWorkspaceRootOverride(dir);
      expect(() => ensureWorkspaceManifest()).toThrow(WorkspaceAdoptionError);
      const after = readFileSync(path);
      expect(after.equals(before)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws on a foreign non-empty folder and writes nothing", () => {
    const dir = tempDir("worktable-ensure-foreign-");
    try {
      writeFileSync(join(dir, "notes.txt"), "data");
      setWorkspaceRootOverride(dir);
      expect(() => ensureWorkspaceManifest()).toThrow(WorkspaceAdoptionError);
      expect(existsSync(join(dir, "worktable.workspace.json"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("classifier security property", () => {
  it("never classifies arbitrary manifest bytes as valid unless they are a supported manifest, and never mutates them on reject", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (raw) => {
        const dir = tempDir("worktable-prop-");
        try {
          const path = writeManifest(dir, raw);
          const before = readFileSync(path);
          const result = classifyWorkspaceTarget(dir);

          if (result.outcome === "valid") {
            // Only a genuine supported manifest may classify valid.
            expect(isWorkspaceManifest(JSON.parse(raw))).toBe(true);
          } else {
            expect(result.outcome).toBe("reject");
            setWorkspaceRootOverride(dir);
            expect(() => ensureWorkspaceManifest()).toThrow(
              WorkspaceAdoptionError
            );
            const after = readFileSync(path);
            expect(after.equals(before)).toBe(true);
            setWorkspaceRootOverride(null);
          }
        } finally {
          setWorkspaceRootOverride(null);
          rmSync(dir, { recursive: true, force: true });
        }
      }),
      { numRuns: 200 }
    );
  });
});
