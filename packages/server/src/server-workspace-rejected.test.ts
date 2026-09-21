import { describe, it, expect, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpaceFile } from "@worktable/types";
import {
  SimulatedDocumentLifecycleCrash,
  setDocumentLifecycleStepHookForTests,
} from "./document-lifecycle-journal.ts";
import {
  mintDocumentId,
  updateDocumentInventory,
} from "./document-inventory.ts";
import { renameDocAndSync } from "./doc-rename.ts";
import {
  setStarterSeedScheduleHookForTests,
  setWorkspaceReplacementRecoveryHookForTests,
  startServer,
} from "./index.ts";
import {
  getDocProvenance,
  listDocVersions,
  readDoc,
  writeDoc,
  writeSpace,
} from "./store.ts";
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts";
import { setAppDirOverride } from "./app-storage.ts";
import {
  resetWorkspaceSafetyForTests,
  WorkspaceUnavailableError,
} from "./workspace-safety.ts"

function makeSpace(id: string): SpaceFile {
  const now = new Date().toISOString();
  return {
    type: "worktable.space",
    version: 1,
    id,
    name: id,
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: { docOrder: ["old"] },
  };
}

// Integration: when boot rejects the configured workspace folder, the running
// server must leave that folder byte-for-byte untouched. The 503 guard lives in
// the Bun.serve wrapper (around the Hono app + WS upgrades), so this exercises a
// real listening socket rather than app.fetch().
describe("startServer with a rejected workspace folder", () => {
  let server: ReturnType<typeof startServer> | null = null;
  let root = "";
  let appDir = "";

  afterEach(async () => {
    await server?.stop(true);
    server = null;
    setStarterSeedScheduleHookForTests(null);
    setWorkspaceReplacementRecoveryHookForTests(null);
    setDocumentLifecycleStepHookForTests(null);
    setWorkspaceRootOverride(null);
    setAppDirOverride(null);
    resetWorkspaceSafetyForTests()
    if (root) rmSync(root, { recursive: true, force: true });
    if (appDir) rmSync(appDir, { recursive: true, force: true });
    root = "";
    appDir = "";
  });

  it("serves /health, 503s workspace routes, and never writes into the foreign folder", async () => {
    root = mkdtempSync(join(tmpdir(), "worktable-foreign-boot-"));
    writeFileSync(join(root, "notes.txt"), "not a workspace");
    appDir = mkdtempSync(join(tmpdir(), "worktable-appdir-"));
    setWorkspaceRootOverride(root);
    setAppDirOverride(appDir);

    server = startServer(0, "127.0.0.1");
    const base = `http://127.0.0.1:${server.port}`;

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);

    const api = await fetch(`${base}/api/spaces`);
    expect(api.status).toBe(503);

    // The foreign folder is untouched: no spaces/ dir, no manifest, only the
    // original file remains.
    expect(existsSync(join(root, "spaces"))).toBe(false);
    expect(existsSync(join(root, "worktable.workspace.json"))).toBe(false);
  });

  it("fails closed when interrupted-replacement recovery throws", async () => {
    root = mkdtempSync(join(tmpdir(), "worktable-recovery-boot-"));
    appDir = mkdtempSync(join(tmpdir(), "worktable-appdir-"));
    setWorkspaceRootOverride(root);
    setAppDirOverride(appDir);
    let seedSchedules = 0;
    setStarterSeedScheduleHookForTests(() => {
      seedSchedules += 1;
    });
    setWorkspaceReplacementRecoveryHookForTests(() => {
      throw new Error("recovery storage unavailable");
    });

    server = startServer(0, "127.0.0.1");
    const base = `http://127.0.0.1:${server.port}`;

    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/api/spaces`)).status).toBe(503);
    expect(seedSchedules).toBe(0);
    expect(existsSync(join(root, "spaces"))).toBe(false);
    expect(existsSync(join(root, "worktable.workspace.json"))).toBe(false);
  });

  it("rejects an interrupted document journal that belongs to a replaced workspace", async () => {
    root = mkdtempSync(join(tmpdir(), "worktable-document-replacement-"));
    appDir = mkdtempSync(join(tmpdir(), "worktable-appdir-"));
    setWorkspaceRootOverride(root);
    setAppDirOverride(appDir);

    const originalManifest = ensureWorkspaceManifest();
    await writeSpace(makeSpace("space"));
    await writeDoc("space", "old", "# Original\n");
    await updateDocumentInventory("space", {
      upsert: [
        {
          documentId: mintDocumentId(),
          path: "old",
          format: { id: "worktable.markdown", sourceVersion: 1 },
          source: { kind: "file", relativePath: "docs/old.md" },
        },
      ],
    });
    setDocumentLifecycleStepHookForTests((step) => {
      if (step === "source") {
        throw new SimulatedDocumentLifecycleCrash("source");
      }
    });
    await expect(renameDocAndSync("space", "old", "new")).rejects.toThrow(
      "source"
    );
    setDocumentLifecycleStepHookForTests(null);

    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    const replacementManifest = ensureWorkspaceManifest();
    expect(replacementManifest.id).not.toBe(originalManifest.id);
    const marker = join(root, "replacement.txt");
    writeFileSync(marker, "replacement data\n");
    const replacementManifestBytes = readFileSync(
      join(root, "worktable.workspace.json"),
      "utf8"
    );

    server = startServer(0, "127.0.0.1");
    const base = `http://127.0.0.1:${server.port}`;

    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/api/spaces`)).status).toBe(503);
    expect(readFileSync(marker, "utf8")).toBe("replacement data\n");
    expect(
      readFileSync(join(root, "worktable.workspace.json"), "utf8")
    ).toBe(replacementManifestBytes);
    expect(existsSync(join(root, "spaces"))).toBe(false);
  });

  it("reconciles content edited during a crash recovery before serving workspace requests", async () => {
    root = mkdtempSync(join(tmpdir(), "worktable-document-edit-recovery-"));
    appDir = mkdtempSync(join(tmpdir(), "worktable-appdir-"));
    setWorkspaceRootOverride(root);
    setAppDirOverride(appDir);
    ensureWorkspaceManifest();
    await writeSpace(makeSpace("space"));
    await writeDoc("space", "old", "# Original\n");
    await updateDocumentInventory("space", {
      upsert: [
        {
          documentId: mintDocumentId(),
          path: "old",
          format: { id: "worktable.markdown", sourceVersion: 1 },
          source: { kind: "file", relativePath: "docs/old.md" },
        },
      ],
    });
    const originalProvenance = await getDocProvenance("space", "old");
    const originalVersions = await listDocVersions("space", "old");

    setDocumentLifecycleStepHookForTests((step) => {
      if (step !== "source") return;
      writeFileSync(
        join(root, "spaces", "space", "docs", "new.md"),
        "# Edited while moving\n"
      );
      throw new SimulatedDocumentLifecycleCrash("source");
    });
    await expect(renameDocAndSync("space", "old", "new")).rejects.toThrow(
      "source"
    );
    setDocumentLifecycleStepHookForTests(null);

    server = startServer(0, "127.0.0.1");
    const base = `http://127.0.0.1:${server.port}`;
    expect((await fetch(`${base}/api/spaces`)).status).toBe(200);

    expect((await readDoc("space", "old")).data).toBe(
      "# Edited while moving\n"
    );
    const recoveredProvenance = await getDocProvenance("space", "old");
    expect(recoveredProvenance).toMatchObject({
      source: "filesystem",
      updatedBy: "external",
    });
    expect(recoveredProvenance?.contentHash).not.toBe(
      originalProvenance?.contentHash
    );
    expect(await listDocVersions("space", "old")).toHaveLength(
      originalVersions.length + 1
    );
  });

  it("serves only health after a live rename cannot compensate safely", async () => {
    root = mkdtempSync(join(tmpdir(), "worktable-document-fail-stop-"));
    appDir = mkdtempSync(join(tmpdir(), "worktable-appdir-"));
    setWorkspaceRootOverride(root);
    setAppDirOverride(appDir);
    ensureWorkspaceManifest();
    await writeSpace(makeSpace("space"));
    await writeDoc("space", "old", "# Original\n");
    await updateDocumentInventory("space", {
      upsert: [
        {
          documentId: mintDocumentId(),
          path: "old",
          format: { id: "worktable.markdown", sourceVersion: 1 },
          source: { kind: "file", relativePath: "docs/old.md" },
        },
      ],
    });
    server = startServer(0, "127.0.0.1");
    const base = `http://127.0.0.1:${server.port}`;

    let queuedWrite:
      | Promise<{ value?: unknown; error?: unknown }>
      | undefined;
    setDocumentLifecycleStepHookForTests((step) => {
      if (step !== "source") return;
      // The destination already owns the move. Recreating the source makes
      // automatic compensation ambiguous and must quarantine this process.
      writeFileSync(
        join(root, "spaces", "space", "docs", "old.md"),
        "# Conflicting source\n"
      );
      queuedWrite = writeDoc("space", "queued", "# Must not land\n").then(
        (value) => ({ value }),
        (error) => ({ error })
      );
      throw new Error("unsettled live rename");
    });

    await expect(renameDocAndSync("space", "old", "new")).rejects.toThrow(
      "requires startup recovery"
    );
    setDocumentLifecycleStepHookForTests(null);
    const queued = await queuedWrite;
    expect(queued?.error).toBeInstanceOf(WorkspaceUnavailableError);
    expect(existsSync(join(root, "spaces", "space", "docs", "queued.md"))).toBe(
      false
    );

    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await fetch(`${base}/api/spaces`)).status).toBe(503);
    expect(
      (
        await fetch(`${base}/api/spaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Blocked" }),
        })
      ).status
    ).toBe(503);
  });
});
