import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { deleteDoc, docExists, getDocPath, getDocProvenance, readDoc, renameDoc, writeDoc, writeSpace } from "./store.ts";
import { getServerEditor } from "./blocknote.ts";
import { getDocFreshness } from "./freshness.ts";
import { MermaidDocumentValidationError } from "./mermaid-document.ts";
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts";
import { YjsDocManager, yjsManager } from "./yjs-manager.ts";
import type { SpaceFile } from "@worktable/types"
import {
  mintDocumentId,
  updateDocumentInventory,
} from "./document-inventory.ts"
import { setDocumentLifecycleStepHookForTests } from "./document-lifecycle-journal.ts"
import {
  requireWorkspaceRecovery,
  resetWorkspaceSafetyForTests,
} from "./workspace-safety.ts"
import { recordDocAlias } from "./doc-aliases.ts"
import { moveDocumentFolder } from "./document-folder-move.ts"
import { buildDocumentCatalog } from "./document-catalog.ts"
import { listDocumentGenerationsV2 } from "./document-version-store-v2.ts"
import { buildWidgetFile } from "./widget-authoring.ts"
import { readWidgetHtml, writeWidget } from "./widget-store.ts"

const MESSAGE_SYNC = 0;
const MESSAGE_INTENT = 43;

const para = (text: string) => ({
  type: "paragraph",
  content: [{ type: "text", text, styles: {} }],
});

function intentMessage(): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_INTENT);
  return encoding.toUint8Array(encoder);
}

function isIntentFrame(frame: unknown): boolean {
  return frame instanceof Uint8Array && frame.length === 1 && frame[0] === MESSAGE_INTENT;
}

/**
 * Mutate a loaded doc's fragment the way a connected editor would: a Yjs
 * transaction whose origin is neither file-watcher nor initial-load, so it
 * schedules a persist. replaceContent is NOT a stand-in for this — it applies
 * already-on-disk content and resets the guard bookkeeping.
 */
async function simulateClientEdit(spaceId: string, docPath: string, blocks: unknown[]): Promise<void> {
  await simulateManagerClientEdit(yjsManager, spaceId, docPath, blocks);
}

async function simulateManagerClientEdit(
  manager: YjsDocManager,
  spaceId: string,
  docPath: string,
  blocks: unknown[]
): Promise<void> {
  const ydoc = await manager.getOrCreateDoc(spaceId, docPath);
  const editor = await getServerEditor();
  ydoc.transact(() => {
    const fragment = ydoc.getXmlFragment("document-store");
    fragment.delete(0, fragment.length);
    editor.blocksToYXmlFragment(blocks, fragment);
  }, "test-client");
}

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
    settings: {},
  };
}

function syncStep1Message(doc = new Y.Doc()): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}

function applyServerSyncFrames(clientDoc: Y.Doc, frames: unknown[]): number[] {
  const syncTypes: number[] = [];
  for (const frame of frames) {
    if (!(frame instanceof Uint8Array)) continue;
    const decoder = decoding.createDecoder(frame);
    if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) continue;
    const reply = encoding.createEncoder();
    encoding.writeVarUint(reply, MESSAGE_SYNC);
    syncTypes.push(
      syncProtocol.readSyncMessage(
        decoder,
        reply,
        clientDoc,
        "test-server"
      )
    );
  }
  return syncTypes;
}

async function syncUpdateMessage(
  serverDoc: Y.Doc,
  blocks: unknown[]
): Promise<Uint8Array> {
  const editor = await getServerEditor();
  const clientDoc = new Y.Doc();
  Y.applyUpdate(clientDoc, Y.encodeStateAsUpdate(serverDoc));
  const serverState = Y.encodeStateVector(serverDoc);
  clientDoc.transact(() => {
    const fragment = clientDoc.getXmlFragment("document-store");
    fragment.delete(0, fragment.length);
    editor.blocksToYXmlFragment(
      blocks as Parameters<typeof editor.blocksToYXmlFragment>[0],
      fragment
    );
  }, "test-client");
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(clientDoc, serverState));
  clientDoc.destroy();
  return encoding.toUint8Array(encoder);
}

class FakeWs {
  sent: unknown[] = [];
  closed = false;

  send(data: string | ArrayBuffer | Uint8Array) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
  }
}

const testDir = join(tmpdir(), `worktable-yjs-manager-test-${Date.now()}`);
const spacesDir = join(testDir, "spaces");
const appDir = join(testDir, "app");
const originalAppDir = process.env["WORKTABLE_APP_DIR"];

function yjsStatePath(docPath: string): string {
  const workspaceKey = createHash("sha256").update(testDir).digest("hex").slice(0, 16);
  return join(appDir, "yjs", workspaceKey, "test-space", `${docPath}.bin`);
}

function readYjsStateHeader(docPath: string): Record<string, unknown> {
  const data = readFileSync(yjsStatePath(docPath));
  const magic = Buffer.from("WTYJS1\n");
  expect(data.subarray(0, magic.length).toString("utf8")).toBe("WTYJS1\n");
  const lengthEnd = data.indexOf(10, magic.length);
  const headerLength = Number(data.subarray(magic.length, lengthEnd).toString("utf8"));
  return JSON.parse(
    data.subarray(lengthEnd + 1, lengthEnd + 1 + headerLength).toString("utf8")
  );
}

describe("YjsDocManager sync persistence", () => {
  beforeEach(async () => {
    setWorkspaceRootOverride(testDir);
    process.env["WORKTABLE_APP_DIR"] = appDir
    ensureWorkspaceManifest()
    mkdirSync(spacesDir, { recursive: true })
    await writeSpace(makeSpace("test-space"));
  });

  afterEach(() => {
    setDocumentLifecycleStepHookForTests(null)
    setWorkspaceRootOverride(null);
    if (originalAppDir === undefined) {
      delete process.env["WORKTABLE_APP_DIR"];
    } else {
      process.env["WORKTABLE_APP_DIR"] = originalAppDir;
    }
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("allows an older browser base to sync when the server has current doc state", async () => {
    await writeDoc("test-space", "doc", [para("first")], {
      updatedBy: "user",
      source: "browser-yjs",
    });
    const firstProvenance = await getDocProvenance("test-space", "doc");
    expect(firstProvenance?.versionId).toBeTruthy();

    await writeDoc("test-space", "doc", [para("second")], {
      updatedBy: "user",
      source: "browser-yjs",
    });

    const ws = new FakeWs();
    await yjsManager.handleConnection(ws, "test-space", "doc", {
      baseVersionId: firstProvenance!.versionId,
      baseContentHash: firstProvenance!.contentHash,
    });

    yjsManager.handleMessage(ws, "test-space", "doc", syncStep1Message());

    expect(ws.closed).toBe(false);
  });

  it("replays an initial sync frame that arrives while the room is loading", async () => {
    await writeDoc("test-space", "cold-sync", [para("loaded on first open")], {
      updatedBy: "user",
      source: "rest-api",
    });
    const manager = new YjsDocManager();
    const ws = new FakeWs();
    const clientDoc = new Y.Doc();

    try {
      const connecting = manager.handleConnection(ws, "test-space", "cold-sync");
      manager.handleMessage(
        ws,
        "test-space",
        "cold-sync",
        syncStep1Message(clientDoc)
      );
      await connecting;

      const syncTypes = applyServerSyncFrames(clientDoc, ws.sent);
      expect(syncTypes).toContain(syncProtocol.messageYjsSyncStep2);
      const editor = await getServerEditor();
      expect(
        JSON.stringify(editor.yDocToBlocks(clientDoc, "document-store"))
      ).toContain("loaded on first open");
    } finally {
      clientDoc.destroy();
      await manager.shutdown();
    }
  });

  it("queues accepted Yjs edits outside a portable snapshot barrier", async () => {
    await writeDoc("test-space", "snapshot", [para("before snapshot")], {
      updatedBy: "user",
      source: "rest-api",
    });
    const manager = new YjsDocManager();
    const ws = new FakeWs();
    try {
      await manager.handleConnection(ws, "test-space", "snapshot");
      const serverDoc = await manager.getOrCreateDoc("test-space", "snapshot");
      const update = await syncUpdateMessage(serverDoc, [
        para("after snapshot"),
      ]);
      const resume = manager.pauseWorkspaceMutations();

      manager.handleMessage(ws, "test-space", "snapshot", update);
      await manager.flushPersist("test-space", "snapshot");
      expect((await readDoc("test-space", "snapshot")).data).toEqual([
        expect.objectContaining({
          content: [expect.objectContaining({ text: "before snapshot" })],
        }),
      ]);

      resume();
      await manager.flushPersist("test-space", "snapshot");
      expect((await readDoc("test-space", "snapshot")).data).toEqual([
        expect.objectContaining({
          content: [expect.objectContaining({ text: "after snapshot" })],
        }),
      ]);
    } finally {
      await manager.shutdown();
    }
  });

  it("persists accepted edits and reloads portable content after a format transition", async () => {
    await writeDoc("test-space", "format-transition", [para("before")], {
      updatedBy: "user",
      source: "rest-api",
    });
    const cacheBuilder = new YjsDocManager();
    const cachedDoc = await cacheBuilder.getOrCreateDoc(
      "test-space",
      "format-transition"
    );
    const update = await syncUpdateMessage(cachedDoc, [para("latest edit")]);
    await cacheBuilder.shutdown();

    let failNextPersist = false;
    const manager = new YjsDocManager({
      beforePersistWrite: async () => {
        if (!failNextPersist) return;
        failNextPersist = false;
        throw new Error("persist unavailable");
      },
    });
    const ws = new FakeWs();

    try {
      const connecting = manager.handleConnection(
        ws,
        "test-space",
        "format-transition"
      );
      manager.handleMessage(ws, "test-space", "format-transition", update);

      failNextPersist = true;
      let transitionRan = false;
      await expect(
        manager.withDocFormatTransition(
          "test-space",
          "format-transition",
          async () => {
            transitionRan = true;
          }
        )
      ).rejects.toThrow("persist unavailable");
      expect(transitionRan).toBe(false);

      let contentDuringTransition: unknown = null;
      await manager.withDocFormatTransition(
        "test-space",
        "format-transition",
        async () => {
          contentDuringTransition = (
            await readDoc("test-space", "format-transition")
          ).data;
          await writeDoc("test-space", "format-transition", [
            para("portable transition target"),
          ]);
        }
      );
      await connecting;

      const reopened = await manager.getOrCreateDoc(
        "test-space",
        "format-transition"
      );
      const editor = await getServerEditor();
      const reopenedBlocks = editor.yDocToBlocks(
        reopened,
        "document-store"
      );

      expect(ws.closed).toBe(true);
      expect(JSON.stringify(contentDuringTransition)).toContain("latest edit");
      expect(JSON.stringify(reopenedBlocks)).toContain(
        "portable transition target"
      );
    } finally {
      await manager.shutdown();
    }
  });

  it("includes pre-barrier frames accepted while a cold room is loading", async () => {
    await writeDoc("test-space", "cold-snapshot", [para("before snapshot")], {
      updatedBy: "user",
      source: "rest-api",
    });
    const cacheBuilder = new YjsDocManager();
    const cachedDoc = await cacheBuilder.getOrCreateDoc(
      "test-space",
      "cold-snapshot"
    );
    const update = await syncUpdateMessage(cachedDoc, [
      para("inside snapshot"),
    ]);
    await cacheBuilder.shutdown();

    const manager = new YjsDocManager();
    const ws = new FakeWs();
    try {
      const connecting = manager.handleConnection(
        ws,
        "test-space",
        "cold-snapshot"
      );
      manager.handleMessage(ws, "test-space", "cold-snapshot", update);
      const resume = manager.pauseWorkspaceMutations();

      await manager.flushAllPersists();
      await connecting;
      expect((await readDoc("test-space", "cold-snapshot")).data).toEqual([
        expect.objectContaining({
          content: [expect.objectContaining({ text: "inside snapshot" })],
        }),
      ]);
      resume();
    } finally {
      await manager.shutdown();
    }
  });

  it("replays queued edit intent before later collaborative content", async () => {
    await writeDoc("test-space", "queued-intent", [para("original")], {
      updatedBy: "user",
      source: "rest-api",
    });
    const cacheBuilder = new YjsDocManager();
    const cachedDoc = await cacheBuilder.getOrCreateDoc(
      "test-space",
      "queued-intent"
    );
    const queuedUpdate = await syncUpdateMessage(cachedDoc, [
      para("edited by queued update"),
    ]);
    await cacheBuilder.shutdown();

    const manager = new YjsDocManager();
    const ws = new FakeWs();

    try {
      const connecting = manager.handleConnection(
        ws,
        "test-space",
        "queued-intent"
      );
      manager.handleMessage(
        ws,
        "test-space",
        "queued-intent",
        intentMessage()
      );
      manager.handleMessage(
        ws,
        "test-space",
        "queued-intent",
        queuedUpdate
      );
      await connecting;

      await manager.flushPersist("test-space", "queued-intent");
      expect(
        (await getDocProvenance("test-space", "queued-intent"))?.source
      ).toBe("browser-yjs");
      expect(JSON.stringify((await readDoc("test-space", "queued-intent")).data)).toContain(
        "edited by queued update"
      );
    } finally {
      await manager.shutdown();
    }
  });

  it("does not attach a client that disconnects while its room is loading", async () => {
    await writeDoc("test-space", "disconnecting", [para("content")], {
      updatedBy: "user",
      source: "rest-api",
    });
    const manager = new YjsDocManager();
    const ws = new FakeWs();

    const connecting = manager.handleConnection(
      ws,
      "test-space",
      "disconnecting"
    );
    manager.handleMessage(
      ws,
      "test-space",
      "disconnecting",
      syncStep1Message()
    );
    manager.handleDisconnect(ws, "test-space", "disconnecting");
    await connecting;

    expect(ws.sent).toHaveLength(0);
    manager.handleMessage(
      ws,
      "test-space",
      "disconnecting",
      syncStep1Message()
    );
    expect(ws.sent).toHaveLength(0);
    await manager.shutdown();
    expect(manager.isLoaded("test-space", "disconnecting")).toBe(false);
  });

  it("closes connections that exceed pending frame-count or byte bounds", async () => {
    await writeDoc("test-space", "overflow", [para("content")], {
      updatedBy: "user",
      source: "rest-api",
    });
    const manager = new YjsDocManager();
    const frameCountWs = new FakeWs();
    const byteCountWs = new FakeWs();

    try {
      const frameCountConnection = manager.handleConnection(
        frameCountWs,
        "test-space",
        "overflow"
      );
      const byteCountConnection = manager.handleConnection(
        byteCountWs,
        "test-space",
        "overflow"
      );
      for (let index = 0; index < 65; index += 1) {
        manager.handleMessage(
          frameCountWs,
          "test-space",
          "overflow",
          intentMessage()
        );
      }
      manager.handleMessage(
        byteCountWs,
        "test-space",
        "overflow",
        new Uint8Array(8 * 1024 * 1024 + 1)
      );
      await Promise.all([frameCountConnection, byteCountConnection]);

      expect(frameCountWs.closed).toBe(true);
      expect(frameCountWs.sent).toHaveLength(0);
      expect(byteCountWs.closed).toBe(true);
      expect(byteCountWs.sent).toHaveLength(0);
    } finally {
      await manager.shutdown();
    }
  });

  it("single-flights concurrent cold room initialization", async () => {
    await writeDoc("test-space", "single-flight", [para("shared")], {
      updatedBy: "user",
      source: "rest-api",
    });
    const manager = new YjsDocManager();

    try {
      const first = manager.getOrCreateDoc("test-space", "single-flight");
      const second = manager.getOrCreateDoc("test-space", "single-flight");
      const [firstDoc, secondDoc] = await Promise.all([first, second]);
      expect(firstDoc).toBe(secondDoc);

      const firstWs = new FakeWs();
      const secondWs = new FakeWs();
      const firstConnection = manager.handleConnection(
        firstWs,
        "test-space",
        "single-flight"
      );
      const secondConnection = manager.handleConnection(
        secondWs,
        "test-space",
        "single-flight"
      );
      manager.handleMessage(
        firstWs,
        "test-space",
        "single-flight",
        syncStep1Message()
      );
      manager.handleMessage(
        secondWs,
        "test-space",
        "single-flight",
        syncStep1Message()
      );
      await Promise.all([firstConnection, secondConnection]);
      expect(firstWs.sent.length).toBeGreaterThan(1);
      expect(secondWs.sent.length).toBeGreaterThan(1);
    } finally {
      await manager.shutdown();
    }
  });

  it("clears queued frames when room initialization fails", async () => {
    const manager = new YjsDocManager();
    const ws = new FakeWs();

    try {
      const failed = manager.handleConnection(ws, "test-space", "missing-room");
      manager.handleMessage(
        ws,
        "test-space",
        "missing-room",
        syncStep1Message()
      );
      await expect(failed).rejects.toThrow(/does not exist/);
      expect(ws.sent).toHaveLength(0);

      await writeDoc("test-space", "missing-room", [para("created later")], {
        updatedBy: "user",
        source: "rest-api",
      });
      await manager.handleConnection(ws, "test-space", "missing-room");
      // Only the server-initiated step 1 is present. The failed connection's
      // queued client step 1 was discarded rather than replayed here.
      expect(ws.sent).toHaveLength(1);
    } finally {
      await manager.shutdown();
    }
  });

  it("drains an initializing connection before shutdown completes", async () => {
    await writeDoc("test-space", "shutdown-loading", [para("content")], {
      updatedBy: "user",
      source: "rest-api",
    });
    const manager = new YjsDocManager();
    const ws = new FakeWs();

    const connecting = manager.handleConnection(
      ws,
      "test-space",
      "shutdown-loading"
    );
    manager.handleMessage(
      ws,
      "test-space",
      "shutdown-loading",
      syncStep1Message()
    );
    const stopping = manager.shutdown();
    await Promise.all([connecting, stopping]);

    expect(ws.closed).toBe(true);
    expect(ws.sent).toHaveLength(0);
    expect(manager.isLoaded("test-space", "shutdown-loading")).toBe(false);
  });

  it("moves and removes persisted Yjs state alongside document lifecycle", async () => {
    await writeDoc("test-space", "folder/doc", [para("first")], {
      updatedBy: "user",
      source: "browser-yjs",
    });

    await yjsManager.getOrCreateDoc("test-space", "folder/doc");
    const originalStatePath = yjsStatePath("folder/doc");
    expect(existsSync(originalStatePath)).toBe(true);
    const originalBytes = readFileSync(originalStatePath);
    const originalSize = statSync(originalStatePath).size;
    expect(originalSize).toBeGreaterThan(0);
    expect(existsSync(join(spacesDir, "test-space", ".yjs", "folder", "doc.bin"))).toBe(false);
    const provenance = await getDocProvenance("test-space", "folder/doc");
    expect(readYjsStateHeader("folder/doc")).toMatchObject({
      type: "worktable.yjs-state",
      version: 1,
      docContentHash: provenance?.contentHash,
      docVersionId: provenance?.versionId,
    });

    const renamedStatePath = yjsStatePath("folder/renamed");
    mkdirSync(dirname(renamedStatePath), { recursive: true });
    writeFileSync(renamedStatePath, "stale destination state");

    await yjsManager.renameState("test-space", "folder/doc", "folder/renamed");
    expect(existsSync(originalStatePath)).toBe(false);
    expect(existsSync(renamedStatePath)).toBe(true);
    expect(readFileSync(renamedStatePath)).toEqual(originalBytes);

    await yjsManager.deleteState("test-space", "folder/renamed");
    expect(existsSync(renamedStatePath)).toBe(false);
    expect(await docExists("test-space", "folder/doc")).toBe(true);

    await yjsManager.getOrCreateDoc("test-space", "folder/doc")
    expect(existsSync(originalStatePath)).toBe(true)
    await expect(
      yjsManager.withDocGenerationTransition(
        "test-space",
        "folder/doc",
        async () => {
          throw new Error("generation publication became uncertain")
        },
        () => false
      )
    ).rejects.toThrow("generation publication became uncertain")
    expect(existsSync(originalStatePath)).toBe(false)
    expect(yjsManager.isLoaded("test-space", "folder/doc")).toBe(false)
  });

  it("rejects machine-local Yjs state when provenance lags portable content", async () => {
    await writeDoc("test-space", "stale/doc", [para("old")], {
      updatedBy: "user",
      source: "browser-yjs",
    });

    const firstManager = new YjsDocManager();
    await firstManager.getOrCreateDoc("test-space", "stale/doc");
    const statePath = yjsStatePath("stale/doc");
    expect(existsSync(statePath)).toBe(true);
    const oldHeader = readYjsStateHeader("stale/doc");
    const oldProvenance = await getDocProvenance("test-space", "stale/doc")

    // Model a portable write that landed before its provenance transaction
    // failed. The old cache header still agrees with the old provenance, so
    // cache admission must independently compare both with current content.
    writeFileSync(
      getDocPath("test-space", "stale/doc"),
      JSON.stringify([para("newer")])
    )
    const recentDate = new Date();
    utimesSync(statePath, recentDate, recentDate);

    const secondManager = new YjsDocManager();
    const loaded = await secondManager.getOrCreateDoc(
      "test-space",
      "stale/doc"
    )
    const editor = await getServerEditor()
    const loadedBlocks = editor.yDocToBlocks(loaded, "document-store")

    expect(oldHeader["docContentHash"]).toBe(oldProvenance?.contentHash)
    expect(JSON.stringify(loadedBlocks)).toContain("newer")
    expect(existsSync(statePath)).toBe(false)
  });

  it("opening an agent doc records no version and does not flip provenance to human", async () => {
    // The repro from the freshness bug: an agent writes a doc, a human merely
    // opens it (initial editor sync), and it must NOT read as human-reviewed.
    await writeDoc("test-space", "agent-doc", [para("agent wrote this")], {
      updatedBy: "worktable-agent",
      source: "mcp",
    });
    const before = await getDocProvenance("test-space", "agent-doc");

    await yjsManager.getOrCreateDoc("test-space", "agent-doc");
    // A pure open with no genuine edit: flushing persist must be a no-op.
    await yjsManager.flushPersist("test-space", "agent-doc");

    const after = await getDocProvenance("test-space", "agent-doc");
    expect(after?.versionId).toBe(before!.versionId);
    expect(after?.source).toBe("mcp");
    const freshness = await getDocFreshness("test-space", "agent-doc");
    expect(freshness.humanReviewed).toBe(false);
  });

  it("no-op persist over a browser doc records no new version", async () => {
    // A browser-sourced doc is not protected, so this exercises the semantic
    // no-op guard directly rather than the stale-cache guard.
    await writeDoc("test-space", "browser-doc", [para("hello")], {
      updatedBy: "user",
      source: "browser-yjs",
    });
    const before = await getDocProvenance("test-space", "browser-doc");

    await yjsManager.getOrCreateDoc("test-space", "browser-doc");
    await yjsManager.flushPersist("test-space", "browser-doc");

    const after = await getDocProvenance("test-space", "browser-doc");
    expect(after?.versionId).toBe(before!.versionId);
  });

  it("admits a provisional V2 document before persisting a collaborative edit", async () => {
    const manifestPath = join(testDir, "worktable.workspace.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    writeFileSync(
      manifestPath,
      `${JSON.stringify({ ...manifest, version: 2 }, null, 2)}\n`
    );
    await writeDoc("test-space", "provisional-edit", [para("before")]);

    await simulateClientEdit("test-space", "provisional-edit", [
      para("after collaborative edit"),
    ]);
    await yjsManager.flushPersist("test-space", "provisional-edit");

    const catalog = await buildDocumentCatalog({
      workspaceRoot: testDir,
      spaceId: "test-space",
    });
    const entry = catalog.entries.find(
      (candidate) =>
        candidate.kind === "document" &&
        candidate.descriptor.path === "provisional-edit"
    );
    expect(entry?.kind).toBe("document");
    if (!entry || entry.kind !== "document") throw new Error("missing document");
    expect(entry.handle.identity).toBe("durable");
    expect(
      await listDocumentGenerationsV2({
        workspaceRoot: testDir,
        spaceId: "test-space",
        documentId: entry.handle.documentId,
      })
    ).toHaveLength(2);
  });

  it("flushes a pending collaborative edit before shutdown resolves", async () => {
    const manager = new YjsDocManager();
    await writeDoc("test-space", "shutdown-doc", [para("before")], {
      updatedBy: "user",
      source: "browser-yjs",
    });
    const ydoc = await manager.getOrCreateDoc("test-space", "shutdown-doc");
    const editor = await getServerEditor();
    ydoc.transact(() => {
      const fragment = ydoc.getXmlFragment("document-store");
      fragment.delete(0, fragment.length);
      editor.blocksToYXmlFragment([para("saved at shutdown")], fragment);
    }, "test-client");

    await manager.shutdown();

    const persisted = await readDoc("test-space", "shutdown-doc");
    expect(JSON.stringify(persisted.data)).toContain("saved at shutdown");
  });

  it("keeps an in-flight persist owned until recovery shutdown settles", async () => {
    let release!: () => void;
    let entered!: () => void;
    let loadedWhenPersistResumed = false;
    const held = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new YjsDocManager({
      beforePersistWrite: async () => {
        entered();
        await resume;
        loadedWhenPersistResumed = manager.isLoaded(
          "test-space",
          "recovery-shutdown"
        );
      },
    });
    try {
      await writeDoc("test-space", "recovery-shutdown", [para("before")], {
        updatedBy: "user",
        source: "browser-yjs",
      });
      await simulateManagerClientEdit(
        manager,
        "test-space",
        "recovery-shutdown",
        [para("pending edit")]
      );

      const flushing = manager.flushPersist(
        "test-space",
        "recovery-shutdown"
      );
      const flushingResult = flushing.then(
        () => null,
        (error: unknown) => error
      );
      await held;
      requireWorkspaceRecovery("test recovery boundary");
      const stoppingResult = manager.shutdown().then(
        () => null,
        (error: unknown) => error
      );
      release();

      await Promise.all([flushingResult, stoppingResult]);
      expect(loadedWhenPersistResumed).toBe(true);
    } finally {
      release();
      resetWorkspaceSafetyForTests();
      await manager.shutdown().catch(() => undefined);
    }
  });

  it("never opens or rewrites a read-only Markdown document", async () => {
    const manager = new YjsDocManager();
    await writeDoc("test-space", "read-only", "# Keep me\n\nOriginal markdown.", {
      updatedBy: "worktable-agent",
      source: "mcp",
    });

    await expect(
      manager.getOrCreateDoc("test-space", "read-only")
    ).rejects.toThrow(/Markdown.*read-only/i);
    await manager.shutdown();

    const persisted = await readDoc("test-space", "read-only");
    expect(persisted).toMatchObject({
      storedAs: "md",
      data: "# Keep me\n\nOriginal markdown.",
    });
  });

  it("attributes a content change without an edit signal to a non-human source", async () => {
    await writeDoc("test-space", "drift-doc", [para("original")], {
      updatedBy: "user",
      source: "browser-yjs",
    });

    await yjsManager.getOrCreateDoc("test-space", "drift-doc");
    // Content genuinely changes, but no MESSAGE_INTENT was sent → machine drift.
    await simulateClientEdit("test-space", "drift-doc", [para("changed by machine")]);
    await yjsManager.flushPersist("test-space", "drift-doc");

    const after = await getDocProvenance("test-space", "drift-doc");
    expect(after?.source).toBe("browser-yjs-sync");
    const freshness = await getDocFreshness("test-space", "drift-doc");
    expect(freshness.humanReviewed).toBe(false);
  });

  it("attributes a content change to a human after an edit signal", async () => {
    await writeDoc("test-space", "human-doc", [para("original")], {
      updatedBy: "worktable-agent",
      source: "mcp",
    });

    await yjsManager.getOrCreateDoc("test-space", "human-doc");
    const ws = new FakeWs();
    await yjsManager.handleConnection(ws, "test-space", "human-doc");
    // The client signals a genuine local edit, then content changes.
    yjsManager.handleMessage(ws, "test-space", "human-doc", intentMessage());
    await simulateClientEdit("test-space", "human-doc", [para("edited by hand")]);
    await yjsManager.flushPersist("test-space", "human-doc");

    const after = await getDocProvenance("test-space", "human-doc");
    expect(after?.source).toBe("browser-yjs");
    const freshness = await getDocFreshness("test-space", "human-doc");
    expect(freshness.humanReviewed).toBe(true);
  });

  it("rejects invalid Mermaid from a browser sync without replacing the valid file", async () => {
    const valid = {
      type: "mermaid",
      props: { data: "flowchart TD\nA-->B" },
      children: [],
    };
    await writeDoc("test-space", "browser-mermaid", [valid], {
      updatedBy: "user",
      source: "browser-yjs",
    });

    await yjsManager.getOrCreateDoc("test-space", "browser-mermaid");
    await simulateClientEdit("test-space", "browser-mermaid", [
      {
        type: "mermaid",
        props: { data: "flowchart TD\nA-->" },
        children: [],
      },
    ]);

    await expect(
      yjsManager.flushPersist("test-space", "browser-mermaid")
    ).rejects.toBeInstanceOf(MermaidDocumentValidationError);

    const stored = await readDoc("test-space", "browser-mermaid");
    expect(JSON.stringify(stored.data)).toContain("flowchart TD\\nA-->B");
  });

  it("opening a legacy doc with id-less blocks records no version", async () => {
    // Files written before canonical-on-write hold blocks without ids. The
    // no-op guard must let the disk blocks adopt the live doc's minted ids
    // before comparing — otherwise unchanged content hashes differently and
    // every open of a legacy doc records a phantom browser-yjs-sync version.
    const legacyPath = join(spacesDir, "test-space", "docs", "legacy-doc.json");
    mkdirSync(join(spacesDir, "test-space", "docs"), { recursive: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      legacyPath,
      JSON.stringify([{ type: "paragraph", content: [{ type: "text", text: "legacy", styles: {} }] }])
    );

    await yjsManager.getOrCreateDoc("test-space", "legacy-doc");
    await yjsManager.flushPersist("test-space", "legacy-doc");

    // No provenance was ever recorded for this doc, and a pure open must not
    // create one (a write would).
    expect(await getDocProvenance("test-space", "legacy-doc")).toBeUndefined();
  });

  it("normalizes a legacy Mermaid code block in memory and persists it only after an edit", async () => {
    const legacyPath = join(
      spacesDir,
      "test-space",
      "docs",
      "legacy-mermaid.json"
    );
    mkdirSync(join(spacesDir, "test-space", "docs"), { recursive: true });
    const legacyContent = [
      {
        id: "diagram",
        type: "codeBlock",
        props: { language: "mermaid" },
        content: [
          { type: "text", text: "flowchart TD\nA-->B", styles: {} },
        ],
        children: [],
      },
    ];
    writeFileSync(legacyPath, JSON.stringify(legacyContent));

    const ydoc = await yjsManager.getOrCreateDoc(
      "test-space",
      "legacy-mermaid"
    );
    const editor = await getServerEditor();
    const opened = editor.yDocToBlocks(ydoc, "document-store") as any[];
    expect(opened[0].type).toBe("mermaid");
    expect(opened[0].props.data).toBe("flowchart TD\nA-->B");

    expect(JSON.parse(readFileSync(legacyPath, "utf8"))).toEqual(legacyContent);
    expect(existsSync(yjsStatePath("legacy-mermaid"))).toBe(false);
    expect(
      await getDocProvenance("test-space", "legacy-mermaid")
    ).toBeUndefined();

    await simulateClientEdit("test-space", "legacy-mermaid", [
      {
        id: "diagram",
        type: "mermaid",
        props: { data: "flowchart TD\nA-->C" },
      },
    ]);
    await yjsManager.flushPersist("test-space", "legacy-mermaid");

    const persisted = (await readDoc("test-space", "legacy-mermaid"))
      .data as any[];
    expect(persisted[0].type).toBe("mermaid");
    expect(persisted[0].props.data).toBe("flowchart TD\nA-->C");
    expect(existsSync(yjsStatePath("legacy-mermaid"))).toBe(true);
  });

  it("normalizes a legacy Mermaid block synced from disk into an open room", async () => {
    await writeDoc("test-space", "watcher-mermaid", [para("before")], {
      updatedBy: "user",
      source: "browser-yjs",
    });
    const ydoc = await yjsManager.getOrCreateDoc(
      "test-space",
      "watcher-mermaid"
    );
    const legacyContent = [
      {
        id: "watcher-diagram",
        type: "codeBlock",
        props: { language: "mermaid" },
        content: [
          { type: "text", text: "flowchart TD\nDisk-->Room", styles: {} },
        ],
        children: [],
      },
    ];
    const docPath = getDocPath("test-space", "watcher-mermaid");
    writeFileSync(docPath, JSON.stringify(legacyContent));

    await yjsManager.syncFromDisk("test-space", "watcher-mermaid");

    const editor = await getServerEditor();
    const synced = editor.yDocToBlocks(ydoc, "document-store") as any[];
    expect(synced[0].type).toBe("mermaid");
    expect(synced[0].props.data).toBe("flowchart TD\nDisk-->Room");
    expect(JSON.parse(readFileSync(docPath, "utf8"))).toEqual(legacyContent);
  });

  it("does not replace a later accepted room edit with an older disk sync", async () => {
    await writeDoc("test-space", "ordered-sync", [para("original")], {
      updatedBy: "user",
      source: "browser-yjs",
    });
    const manager = new YjsDocManager();
    try {
      const ydoc = await manager.getOrCreateDoc("test-space", "ordered-sync");
      const docPath = getDocPath("test-space", "ordered-sync");
      writeFileSync(docPath, JSON.stringify([para("external edit")]));
      const diskSyncGeneration = manager.contentGeneration(
        "test-space",
        "ordered-sync"
      );
      if (diskSyncGeneration === null) throw new Error("room was not loaded");

      await simulateManagerClientEdit(manager, "test-space", "ordered-sync", [
        para("later room edit"),
      ]);
      await manager.syncFromDisk("test-space", "ordered-sync", {
        ifContentGeneration: diskSyncGeneration,
      });

      const editor = await getServerEditor();
      expect(
        JSON.stringify(editor.yDocToBlocks(ydoc, "document-store"))
      ).toContain("later room edit");
    } finally {
      await manager.deleteState("test-space", "ordered-sync");
    }
  });

  it("acknowledges MESSAGE_INTENT only when a persist consumes it", async () => {
    await writeDoc("test-space", "ack-doc", [para("content")], {
      updatedBy: "user",
      source: "browser-yjs",
    });
    await yjsManager.getOrCreateDoc("test-space", "ack-doc");
    const ws = new FakeWs();
    await yjsManager.handleConnection(ws, "test-space", "ack-doc");
    const sentBefore = ws.sent.length;

    // Delivery alone earns NO ack: the flag lives only in this process's
    // memory, and a receipt ack would clear the client's replay marker before
    // the attribution is durable (a crash before the debounced persist would
    // then lose it).
    yjsManager.handleMessage(ws, "test-space", "ack-doc", intentMessage());
    expect(ws.sent.slice(sentBefore).some(isIntentFrame)).toBe(false);

    // The persist that consumes the signal is what acknowledges it.
    await simulateClientEdit("test-space", "ack-doc", [para("edited")]);
    await yjsManager.flushPersist("test-space", "ack-doc");
    expect(ws.sent.slice(sentBefore).some(isIntentFrame)).toBe(true);
    expect((await getDocProvenance("test-space", "ack-doc"))?.source).toBe("browser-yjs");
  });

  it("preserves edit intent that arrives while disk content is being prepared", async () => {
    await writeDoc("test-space", "intent-during-sync", [para("original")], {
      updatedBy: "user",
      source: "browser-yjs",
    });
    const manager = new YjsDocManager();
    const ws = new FakeWs();
    try {
      await manager.handleConnection(ws, "test-space", "intent-during-sync");
      writeFileSync(
        getDocPath("test-space", "intent-during-sync"),
        JSON.stringify([para("canonical disk edit")])
      );
      const sentBefore = ws.sent.length;

      // syncFromDisk reaches an asynchronous preparation boundary before it
      // mutates the live room. Intent received there belongs to the client's
      // following Yjs update, not to the disk content being installed.
      const syncing = manager.syncFromDisk(
        "test-space",
        "intent-during-sync"
      );
      manager.handleMessage(
        ws,
        "test-space",
        "intent-during-sync",
        intentMessage()
      );
      await syncing;
      expect(ws.sent.slice(sentBefore).some(isIntentFrame)).toBe(false);

      await simulateManagerClientEdit(
        manager,
        "test-space",
        "intent-during-sync",
        [para("edited by hand")]
      );
      await manager.flushPersist("test-space", "intent-during-sync");

      expect(ws.sent.slice(sentBefore).some(isIntentFrame)).toBe(true);
      expect(
        (await getDocProvenance("test-space", "intent-during-sync"))?.source
      ).toBe("browser-yjs");
    } finally {
      await manager.deleteState("test-space", "intent-during-sync");
    }
  });

  it("acknowledges intent that a disk sync supersedes", async () => {
    // Intent delivered, then an agent write reaches the loaded doc before the
    // debounced persist consumes the edit. The disk apply spends the signal —
    // and must ACK it, or the client keeps its replay marker and a much later
    // reconnect would re-assert phantom human intent over fresh agent content.
    await writeDoc("test-space", "supersede-doc", [para("original")], {
      updatedBy: "user",
      source: "browser-yjs",
    });
    await yjsManager.getOrCreateDoc("test-space", "supersede-doc");
    const ws = new FakeWs();
    await yjsManager.handleConnection(ws, "test-space", "supersede-doc");
    const sentBefore = ws.sent.length;

    yjsManager.handleMessage(ws, "test-space", "supersede-doc", intentMessage());

    await writeDoc("test-space", "supersede-doc", [para("agent content")], {
      updatedBy: "worktable-agent",
      source: "mcp",
    });
    const written = await readDoc("test-space", "supersede-doc");
    await yjsManager.replaceContent("test-space", "supersede-doc", written.data as unknown[]);

    expect(ws.sent.slice(sentBefore).some(isIntentFrame)).toBe(true);

    // The spent signal must not attribute later machine drift as human.
    await simulateClientEdit("test-space", "supersede-doc", [para("later drift")]);
    await yjsManager.flushPersist("test-space", "supersede-doc");
    expect((await getDocProvenance("test-space", "supersede-doc"))?.source).toBe("mcp");
  });

  it("spends and acknowledges intent on a semantic no-op persist", async () => {
    // An edit that nets out to nothing (typed then undone) must still consume
    // its intent: without this, the next machine drift on the doc would be
    // attributed human and bypass the stale-cache guard.
    await writeDoc("test-space", "undo-doc", [para("original")], {
      updatedBy: "user",
      source: "browser-yjs",
    });
    await yjsManager.getOrCreateDoc("test-space", "undo-doc");
    const ws = new FakeWs();
    await yjsManager.handleConnection(ws, "test-space", "undo-doc");
    const sentBefore = ws.sent.length;

    // Intent arrives, but the content ends up unchanged → no-op persist.
    yjsManager.handleMessage(ws, "test-space", "undo-doc", intentMessage());
    const before = await getDocProvenance("test-space", "undo-doc");
    await yjsManager.flushPersist("test-space", "undo-doc");
    expect((await getDocProvenance("test-space", "undo-doc"))?.versionId).toBe(before!.versionId);
    expect(ws.sent.slice(sentBefore).some(isIntentFrame)).toBe(true);

    // The spent signal must not attribute later machine drift.
    await simulateClientEdit("test-space", "undo-doc", [para("later drift")]);
    await yjsManager.flushPersist("test-space", "undo-doc");
    expect((await getDocProvenance("test-space", "undo-doc"))?.source).toBe("browser-yjs-sync");
  });

  it("arms the stale-cache window synchronously when an agent write reaches a loaded doc", async () => {
    // An agent write to a LOADED doc goes: writeDoc → replaceContent (applies
    // the canonical disk content). replaceContent must arm protectedUntilMs
    // IMMEDIATELY — not on some later debounced persist — or a stale browser
    // update landing right after the agent write would be accepted over it.
    await writeDoc("test-space", "protect-doc", [para("browser content")], {
      updatedBy: "user",
      source: "browser-yjs",
    });
    await yjsManager.getOrCreateDoc("test-space", "protect-doc");
    const loadStat = statSync(getDocPath("test-space", "protect-doc"));

    await writeDoc("test-space", "protect-doc", [para("agent content")], {
      updatedBy: "worktable-agent",
      source: "mcp",
    });
    // Keep the file mtime inside the mtime-guard slack — the worst case, where
    // the mtime guard cannot catch the stale write either.
    utimesSync(getDocPath("test-space", "protect-doc"), loadStat.atime, loadStat.mtime);
    // Sync the live doc from the canonical disk blocks, exactly like the MCP
    // path (syncDocAfterToolWrite) does after a tool write.
    const written = await readDoc("test-space", "protect-doc");
    await yjsManager.replaceContent("test-space", "protect-doc", written.data as unknown[]);

    // A stale browser state diverges the live doc with no human intent,
    // IMMEDIATELY after the agent write (no debounce has fired in between).
    // The armed window must refuse to persist it over the fresh agent version.
    await simulateClientEdit("test-space", "protect-doc", [para("stale browser state")]);
    await yjsManager.flushPersist("test-space", "protect-doc");

    const after = await getDocProvenance("test-space", "protect-doc");
    expect(after?.source).toBe("mcp");
  });

  it("spends the human edit signal on the persist it attributes", async () => {
    await writeDoc("test-space", "spend-doc", [para("original")], {
      updatedBy: "user",
      source: "browser-yjs",
    });

    await yjsManager.getOrCreateDoc("test-space", "spend-doc");
    const ws = new FakeWs();
    await yjsManager.handleConnection(ws, "test-space", "spend-doc");

    // Edit with intent → attributed human.
    yjsManager.handleMessage(ws, "test-space", "spend-doc", intentMessage());
    await simulateClientEdit("test-space", "spend-doc", [para("human edit")]);
    await yjsManager.flushPersist("test-space", "spend-doc");
    expect((await getDocProvenance("test-space", "spend-doc"))?.source).toBe("browser-yjs");

    // A LATER content change with no new intent must not inherit the old
    // attribution — in a long-lived tab this is machine drift, not a person.
    await simulateClientEdit("test-space", "spend-doc", [para("later drift")]);
    await yjsManager.flushPersist("test-space", "spend-doc");
    expect((await getDocProvenance("test-space", "spend-doc"))?.source).toBe("browser-yjs-sync");
  });

  it("persists an unrelated open document while a rename transition is held", async () => {
    await writeDoc("test-space", "moving", [para("moving")], {
      updatedBy: "user",
      source: "rest-api",
    });
    await writeDoc("test-space", "unrelated", [para("before")], {
      updatedBy: "user",
      source: "rest-api",
    });

    const manager = new YjsDocManager();
    const ws = new FakeWs();
    let releaseTransition = () => {};
    let enterTransition = () => {};
    const held = new Promise<void>((resolve) => {
      releaseTransition = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      enterTransition = resolve;
    });
    let transition: Promise<void> | null = null;

    try {
      await manager.handleConnection(ws, "test-space", "unrelated");
      const serverDoc = await manager.getOrCreateDoc(
        "test-space",
        "unrelated"
      );
      const update = await syncUpdateMessage(serverDoc, [para("after")]);

      transition = manager.withDocPathMoveTransition(
        "test-space",
        "moving",
        "moved",
        async () => {
          enterTransition();
          await held;
        }
      );
      await entered;

      manager.handleMessage(ws, "test-space", "unrelated", update);
      await manager.flushPersist("test-space", "unrelated");

      expect(JSON.stringify((await readDoc("test-space", "unrelated")).data))
        .toContain("after");
    } finally {
      releaseTransition();
      await transition?.catch(() => undefined);
      await manager.shutdown();
    }
  });

  it("keeps an existing websocket usable after a rename moves its live room", async () => {
    await writeDoc("test-space", "live-old", [para("original")], {
      updatedBy: "user",
      source: "rest-api",
    });
    const ws = new FakeWs();
    await yjsManager.handleConnection(ws, "test-space", "live-old");
    const serverDoc = await yjsManager.getOrCreateDoc("test-space", "live-old");

    const documentId = mintDocumentId()
    await updateDocumentInventory("test-space", {
      upsert: [
        {
          documentId,
          path: "live-old",
          format: { id: "worktable.rich-text", sourceVersion: 1 },
          source: { kind: "file", relativePath: "docs/live-old.json" },
        },
      ],
    })
    await simulateClientEdit("test-space", "live-old", [
      para("edited before rename"),
    ])

    const { renameDocAndSync } = await import("./doc-rename.ts");
    let transitionEntered = () => {}
    let releaseTransition = () => {}
    const entered = new Promise<void>((resolve) => {
      transitionEntered = resolve
    })
    const held = new Promise<void>((resolve) => {
      releaseTransition = resolve
    })
    setDocumentLifecycleStepHookForTests((step) => {
      if (step !== "committed") return
      transitionEntered()
      return held
    })
    const renaming = renameDocAndSync("test-space", "live-old", "live-new")
    try {
      await entered
      // The socket URL remains immutable, and this frame arrives after the
      // portable source moved but before the live room is re-keyed.
      yjsManager.handleMessage(
        ws,
        "test-space",
        "live-old",
        await syncUpdateMessage(serverDoc, [para("edited during rename")])
      )
      releaseTransition()
      expect((await renaming).error).toBeNull()
    } finally {
      releaseTransition()
      setDocumentLifecycleStepHookForTests(null)
      await renaming.catch(() => undefined)
    }

    expect(
      JSON.stringify((await readDoc("test-space", "live-new")).data)
    ).toContain("edited before rename")
    await yjsManager.flushPersist("test-space", "live-new")
    expect(
      JSON.stringify((await readDoc("test-space", "live-new")).data)
    ).toContain("edited during rename")

    // The socket URL remains the old path after the room is re-keyed. New
    // frames must continue routing by socket ownership to the moved room.
    yjsManager.handleMessage(
      ws,
      "test-space",
      "live-old",
      await syncUpdateMessage(serverDoc, [para("edited after rename")])
    )
    await yjsManager.flushPersist("test-space", "live-new");

    const after = await readDoc("test-space", "live-new");
    expect(JSON.stringify(after.data)).toContain("edited after rename");
  });

  it("persists queued edits for every live room after a folder move", async () => {
    const documents = [
      {
        from: "live-folder",
        to: "moved-live-folder",
        edit: "parent edited during folder move",
      },
      {
        from: "live-folder/child",
        to: "moved-live-folder/child",
        edit: "child edited during folder move",
      },
    ] as const
    for (const document of documents) {
      await writeDoc("test-space", document.from, [para("original")], {
        updatedBy: "user",
        source: "rest-api",
      })
    }
    await updateDocumentInventory("test-space", {
      upsert: documents.map((document) => ({
        documentId: mintDocumentId(),
        path: document.from,
        format: { id: "worktable.rich-text", sourceVersion: 1 },
        source: {
          kind: "file" as const,
          relativePath: `docs/${document.from}.json`,
        },
      })),
    })
    const writtenWidget = await writeWidget(
      "test-space",
      buildWidgetFile({
        id: "live-folder/status",
        name: "Status",
        createdBy: "test",
        updatedBy: "test",
      }),
      "<h1>Live status</h1>"
    )
    writtenWidget.release?.()

    const rooms = await Promise.all(
      documents.map(async (document) => {
        const ws = new FakeWs()
        await yjsManager.handleConnection(ws, "test-space", document.from)
        const serverDoc = await yjsManager.getOrCreateDoc(
          "test-space",
          document.from
        )
        return { ...document, ws, serverDoc }
      })
    )

    let transitionEntered = () => {}
    let releaseTransition = () => {}
    const entered = new Promise<void>((resolve) => {
      transitionEntered = resolve
    })
    const held = new Promise<void>((resolve) => {
      releaseTransition = resolve
    })
    setDocumentLifecycleStepHookForTests((step) => {
      if (step !== "committed") return
      transitionEntered()
      return held
    })

    const renaming = moveDocumentFolder(
      "test-space",
      "live-folder",
      "moved-live-folder"
    )
    try {
      await entered
      for (const room of rooms) {
        yjsManager.handleMessage(
          room.ws,
          "test-space",
          room.from,
          await syncUpdateMessage(room.serverDoc, [para(room.edit)])
        )
      }
      releaseTransition()
      expect((await renaming).ok).toBe(true)
    } finally {
      releaseTransition()
      setDocumentLifecycleStepHookForTests(null)
      await renaming.catch(() => undefined)
    }

    for (const document of documents) {
      await yjsManager.flushPersist("test-space", document.to)
      expect(
        JSON.stringify((await readDoc("test-space", document.to)).data)
      ).toContain(document.edit)
    }
    expect(
      await readWidgetHtml("test-space", "moved-live-folder/status")
    ).toMatchObject({ data: "<h1>Live status</h1>" })
  })

  it("replays frames for every document in a rejected batch generation transition", async () => {
    const documents = [
      { path: "folder/unchanged-a", edit: "edited first during rejection" },
      { path: "folder/unchanged-b", edit: "edited second during rejection" },
    ]
    for (const document of documents) {
      await writeDoc("test-space", document.path, [para("before")], {
        updatedBy: "user",
        source: "rest-api",
      })
    }
    const rooms = documents.map((document) => ({
      ...document,
      ws: new FakeWs(),
      serverDoc: null as Y.Doc | null,
    }))
    let releaseTransition = () => {}
    let enterTransition = () => {}
    const held = new Promise<void>((resolve) => {
      releaseTransition = resolve
    })
    const entered = new Promise<void>((resolve) => {
      enterTransition = resolve
    })
    let transition: Promise<{ error: string | null }> | null = null

    try {
      for (const room of rooms) {
        await yjsManager.handleConnection(room.ws, "test-space", room.path)
        room.serverDoc = await yjsManager.getOrCreateDoc(
          "test-space",
          room.path
        )
      }

      transition = yjsManager.withDocGenerationTransitions(
        "test-space",
        documents.map((document) => document.path),
        async () => {
          enterTransition()
          await held
          return { error: "document deletion was rejected" }
        },
        (result) => result.error === null
      )
      await entered

      for (const room of rooms) {
        yjsManager.handleMessage(
          room.ws,
          "test-space",
          room.path,
          await syncUpdateMessage(room.serverDoc!, [para(room.edit)])
        )
      }
      releaseTransition()
      await transition
      for (const room of rooms) {
        expect(room.ws.closed).toBe(false)
        await yjsManager.flushPersist("test-space", room.path)
        expect(
          JSON.stringify((await readDoc("test-space", room.path)).data)
        ).toContain(room.edit)
      }
    } finally {
      releaseTransition()
      await transition?.catch(() => undefined)
      for (const document of documents) {
        await yjsManager.deleteState("test-space", document.path)
      }
    }
  })

  it("replays frames after an exact deletion is fully compensated", async () => {
    const docPath = "folder/compensated-delete"
    await writeDoc("test-space", docPath, [para("before")], {
      updatedBy: "user",
      source: "rest-api",
    })
    const ws = new FakeWs()
    let releaseFailure = () => {}
    let reportFailureBoundary = () => {}
    const held = new Promise<void>((resolve) => {
      releaseFailure = resolve
    })
    const failureBoundary = new Promise<void>((resolve) => {
      reportFailureBoundary = resolve
    })
    let deletion: ReturnType<typeof deleteDoc> | null = null

    try {
      await yjsManager.handleConnection(ws, "test-space", docPath)
      const serverDoc = await yjsManager.getOrCreateDoc("test-space", docPath)
      setDocumentLifecycleStepHookForTests((step) => {
        if (step !== "source-moved") return
        reportFailureBoundary()
        return held.then(() => {
          throw new Error("injected compensated deletion failure")
        })
      })

      deletion = deleteDoc("test-space", docPath)
      await failureBoundary
      yjsManager.handleMessage(
        ws,
        "test-space",
        docPath,
        await syncUpdateMessage(serverDoc, [para("edited during recovery")])
      )
      releaseFailure()
      await expect(deletion).rejects.toThrow(
        "injected compensated deletion failure"
      )

      expect(ws.closed).toBe(false)
      expect(await docExists("test-space", docPath)).toBe(true)
      await yjsManager.flushPersist("test-space", docPath)
      expect(
        JSON.stringify((await readDoc("test-space", docPath)).data)
      ).toContain("edited during recovery")
    } finally {
      releaseFailure()
      setDocumentLifecycleStepHookForTests(null)
      await deletion?.catch(() => undefined)
      await yjsManager.deleteState("test-space", docPath)
    }
  })

  it("replays an in-flight persist under the current path after rename", async () => {
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    let hookCalls = 0;
    const manager = new YjsDocManager({
      beforePersistWrite: async () => {
        if (hookCalls++ === 0) {
          entered();
          await resume;
        }
      },
    });
    await writeDoc("test-space", "racing-old", [para("before")], {
      updatedBy: "user",
      source: "browser-yjs",
    });
    const ydoc = await manager.getOrCreateDoc("test-space", "racing-old");
    const editor = await getServerEditor();
    ydoc.transact(() => {
      const fragment = ydoc.getXmlFragment("document-store");
      fragment.delete(0, fragment.length);
      editor.blocksToYXmlFragment([para("edit survives rename")], fragment);
    }, "test-client");

    const flushing = manager.flushPersist("test-space", "racing-old");
    await held;
    expect(
      (await renameDoc("test-space", "racing-old", "racing-new")).error
    ).toBeNull();
    await manager.renameState("test-space", "racing-old", "racing-new");
    release();
    await flushing;

    expect(await docExists("test-space", "racing-old")).toBe(false);
    expect(JSON.stringify((await readDoc("test-space", "racing-new")).data))
      .toContain("edit survives rename");
    await manager.shutdown();
  });

  it("does not trust orphaned machine-local Yjs state when the portable doc is missing", async () => {
    await writeDoc("test-space", "orphan/doc", [para("old")], {
      updatedBy: "user",
      source: "browser-yjs",
    });

    const firstManager = new YjsDocManager();
    await firstManager.getOrCreateDoc("test-space", "orphan/doc");
    const statePath = yjsStatePath("orphan/doc");
    expect(existsSync(statePath)).toBe(true);

    const oldDate = new Date("2000-01-01T00:00:00.000Z");
    utimesSync(statePath, oldDate, oldDate);

    await deleteDoc("test-space", "orphan/doc");
    expect(await docExists("test-space", "orphan/doc")).toBe(false);

    const secondManager = new YjsDocManager();
    await expect(
      secondManager.getOrCreateDoc("test-space", "orphan/doc")
    ).rejects.toThrow(/does not exist/);

    expect(existsSync(statePath)).toBe(false);
  });
});
