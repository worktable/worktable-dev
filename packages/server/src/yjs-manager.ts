import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { normalizeMermaidBlocks } from "@worktable/types";
import { canonicalizeBlocks, getServerEditor, inheritBlockIds } from "./blocknote.ts";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAppDir } from "./app-storage.ts";
import { workspaceCacheKey } from "./workspace.ts";
import {
  readDoc,
  writeDoc,
  suppressPath,
  unsuppressPath,
  getDocPath,
  docStat,
  getDocProvenance,
  sanitizeDocPath,
  stableHash,
} from "./store.ts";
import { wsManager } from "./ws.ts";
import {
  requireWorkspaceRecovery,
  workspaceRecoveryRequired,
} from "./workspace-safety.ts"

// ── Constants ────────────────────────────────────────────────

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_PING = 42; // Custom: keepalive for y-websocket's messageReconnectTimeout
const MESSAGE_INTENT = 43; // Custom: client signals a genuine local (human) edit
const FRAGMENT_NAME = "document-store";
// Source recorded when the browser persists content that changed without a
// human edit signal (e.g. editor normalization after a schema/version drift).
// Maps to the "system" category, so it never launders agent output to human.
const SOURCE_BROWSER_HUMAN = "browser-yjs";
const SOURCE_BROWSER_SYNC = "browser-yjs-sync";

/** Both sources the browser persist path can write. Neither is "protected". */
function isBrowserSource(source: string): boolean {
  return source === SOURCE_BROWSER_HUMAN || source === SOURCE_BROWSER_SYNC;
}
const PERSIST_DEBOUNCE_MS = 2000;
const UNLOAD_DELAY_MS = 30_000;
const PING_INTERVAL_MS = 15_000; // Must be < y-websocket's 30s messageReconnectTimeout
const MAX_PENDING_CONNECTION_FRAMES = 64;
const MAX_PENDING_CONNECTION_BYTES = 8 * 1024 * 1024;
const MAX_DOC_PATH_MOVE_TRANSITIONS = 128;
const ORIGIN_FILE_WATCHER = "file-watcher"; // Skip persist for disk-originated updates
const ORIGIN_INITIAL_LOAD = "initial-load";
const YJS_STATE_FILE_TYPE = "worktable.yjs-state";
const YJS_STATE_FILE_VERSION = 1;
const YJS_STATE_MAGIC = "WTYJS1\n";
const MAX_YJS_STATE_HEADER_BYTES = 64 * 1024;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// ── Types ────────────────────────────────────────────────────

interface WsClient {
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(): void;
}

interface ClientFreshness {
  baseVersionId?: string;
  baseContentHash?: string;
  stale: boolean;
}

interface AcceptedClientFrame {
  bytes: Uint8Array;
  sequence: number;
}

interface PendingConnection {
  spaceId: string;
  docPath: string;
  frames: AcceptedClientFrame[];
  queuedBytes: number;
  disconnected: boolean;
  task: Promise<void> | null;
}

interface PausedClientFrames {
  liveDoc: LiveDoc;
  frames: AcceptedClientFrame[];
  queuedBytes: number;
}

interface LiveDoc {
  ydoc: Y.Doc;
  spaceId: string;
  // Current identity, updated by renameState. Long-lived closures such as the
  // Y.Doc update handler must read this instead of capturing the path used
  // when the room was created.
  key: string;
  docPath: string;
  clients: Set<WsClient>;
  persistTimer: ReturnType<typeof setTimeout> | null;
  persistPromise: Promise<void> | null;
  persistAgain: boolean;
  unloadTimer: ReturnType<typeof setTimeout> | null;
  lastPersistMs: number; // disk mtime (ms) the in-memory Y.Doc is based on
  protectedUntilMs: number; // briefly block browser persists over agent/filesystem versions
  humanEdited: boolean; // a connected client has signaled a genuine local edit this session
  contentGeneration: number; // bumped by every applied Y.Doc content update
  // Bumped on every MESSAGE_INTENT. Consumers snapshot it before their awaits
  // and only clear/ack the edit signal if it is unchanged after — an intent
  // arriving DURING a persist or disk sync describes an edit that is not in
  // that snapshot and must survive for the next persist.
  intentGeneration: number;
}

interface YjsStateHeader {
  type: typeof YJS_STATE_FILE_TYPE;
  version: typeof YJS_STATE_FILE_VERSION;
  docContentHash: string;
  docVersionId: string;
  storedAt: string;
}

interface DocSnapshotIdentity {
  contentHash: string;
  versionId: string;
}

interface EditIntentSnapshot {
  hadIntent: boolean;
  generation: number;
}

type DiskSyncResult =
  | "applied"
  | "superseded"
  | "not-loaded"
  | "not-applicable";

interface PreparedDocPathMove {
  from: string;
  to: string;
  oldKey: string;
  newKey: string;
}

// ── Shared editor ────────────────────────────────────────────

// The server-side BlockNote editor and its custom schema live in
// ./blocknote.ts so every path shares one canonical form.
const getEditor = getServerEditor;

// ── Doc key helper ───────────────────────────────────────────

function docKey(spaceId: string, docPath: string): string {
  return `${spaceId}/${docPath}`;
}

function prepareDocPathMoves(
  spaceId: string,
  moves: readonly { from: string; to: string }[]
): PreparedDocPathMove[] {
  if (moves.length === 0 || moves.length > MAX_DOC_PATH_MOVE_TRANSITIONS) {
    throw new RangeError(
      `a document path move must contain between 1 and ${MAX_DOC_PATH_MOVE_TRANSITIONS} documents`
    );
  }

  const oldKeys = new Set<string>();
  const newKeys = new Set<string>();
  return moves.map(({ from, to }) => {
    const oldKey = docKey(spaceId, from);
    const newKey = docKey(spaceId, to);
    if (oldKey === newKey) {
      throw new Error(`document ${spaceId}/${from} cannot move to itself`);
    }
    if (oldKeys.has(oldKey)) {
      throw new Error(`document source ${spaceId}/${from} is duplicated`);
    }
    if (newKeys.has(newKey)) {
      throw new Error(`document destination ${spaceId}/${to} is duplicated`);
    }
    oldKeys.add(oldKey);
    newKeys.add(newKey);
    return { from, to, oldKey, newKey };
  });
}

function yjsStatePath(spaceId: string, docPath: string): string {
  return join(getAppDir(), "yjs", workspaceCacheKey(), spaceId, `${sanitizeDocPath(docPath)}.bin`);
}

async function writeFileAtomic(path: string, data: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, data);
  await rename(tmpPath, path);
}

async function removeFileIfExists(path: string): Promise<void> {
  await rm(path, { force: true });
}

function isYjsStateHeader(value: unknown): value is YjsStateHeader {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate["type"] === YJS_STATE_FILE_TYPE &&
    candidate["version"] === YJS_STATE_FILE_VERSION &&
    typeof candidate["docContentHash"] === "string" &&
    typeof candidate["docVersionId"] === "string" &&
    typeof candidate["storedAt"] === "string"
  );
}

function encodeYjsStateFile(
  update: Uint8Array,
  identity: DocSnapshotIdentity
): Uint8Array {
  const header: YjsStateHeader = {
    type: YJS_STATE_FILE_TYPE,
    version: YJS_STATE_FILE_VERSION,
    docContentHash: identity.contentHash,
    docVersionId: identity.versionId,
    storedAt: new Date().toISOString(),
  };
  const magic = textEncoder.encode(YJS_STATE_MAGIC);
  const headerBytes = textEncoder.encode(JSON.stringify(header));
  const headerLengthBytes = textEncoder.encode(`${headerBytes.length}\n`);
  const data = new Uint8Array(
    magic.length + headerLengthBytes.length + headerBytes.length + update.length
  );
  data.set(magic, 0);
  data.set(headerLengthBytes, magic.length);
  data.set(headerBytes, magic.length + headerLengthBytes.length);
  data.set(update, magic.length + headerLengthBytes.length + headerBytes.length);
  return data;
}

function decodeYjsStateFile(
  data: Uint8Array
): { header: YjsStateHeader; update: Uint8Array } | null {
  const magic = textEncoder.encode(YJS_STATE_MAGIC);
  for (let index = 0; index < magic.length; index += 1) {
    if (data[index] !== magic[index]) return null;
  }

  const lengthStart = magic.length;
  const lengthEnd = data.indexOf(10, lengthStart);
  if (lengthEnd <= lengthStart) return null;

  const headerLength = Number(textDecoder.decode(data.subarray(lengthStart, lengthEnd)));
  if (
    !Number.isSafeInteger(headerLength) ||
    headerLength <= 0 ||
    headerLength > MAX_YJS_STATE_HEADER_BYTES
  ) {
    return null;
  }

  const headerStart = lengthEnd + 1;
  const headerEnd = headerStart + headerLength;
  if (headerEnd > data.length) return null;

  try {
    const parsed: unknown = JSON.parse(
      textDecoder.decode(data.subarray(headerStart, headerEnd))
    );
    if (!isYjsStateHeader(parsed)) return null;
    return { header: parsed, update: data.subarray(headerEnd) };
  } catch {
    return null;
  }
}

async function readCurrentYjsStateUpdate(
  path: string,
  identity: DocSnapshotIdentity | undefined
): Promise<Uint8Array | null> {
  if (!identity) return null;
  try {
    const decoded = decodeYjsStateFile(await readFile(path));
    if (!decoded) return null;
    if (
      decoded.header.docContentHash !== identity.contentHash ||
      decoded.header.docVersionId !== identity.versionId
    ) {
      return null;
    }
    return decoded.update;
  } catch {
    return null;
  }
}

async function writeYjsStateFile(
  path: string,
  update: Uint8Array,
  identity: DocSnapshotIdentity | undefined
): Promise<void> {
  if (!identity) return;
  await writeFileAtomic(path, encodeYjsStateFile(update, identity));
}

// ── YjsDocManager ────────────────────────────────────────────

export class DocFormatTransitionConflictError extends Error {}

export class YjsDocManager {
  private docs: Map<string, LiveDoc> = new Map();
  private initializingDocs: Map<string, Promise<LiveDoc>> = new Map();
  private pendingConnections: Map<WsClient, PendingConnection> = new Map();
  private connectionTasks: Set<Promise<void>> = new Set();
  private pingTimers: Map<WsClient, ReturnType<typeof setInterval>> = new Map();
  private clientFreshness: Map<WsClient, ClientFreshness> = new Map();
  // The upgrade URL is immutable transport metadata. A live room can move to
  // a new doc path while its sockets stay connected, so message/disconnect
  // routing follows the room object rather than re-looking it up by that URL.
  private clientDocs: Map<WsClient, LiveDoc> = new Map();
  private frozenDocs: Set<string> = new Set();
  private moveTransitionTail: Promise<void> = Promise.resolve()
  private pausedDocMutationCutoffs: Map<string, number> = new Map()
  private mutationsPaused = false;
  private acceptedFrameSequence = 0;
  private nextContentGeneration = 0;
  private requiredDiskSyncs = new WeakMap<LiveDoc, number>();
  private mutationPauseCutoff = 0;
  private pausedClientFrames: Map<WsClient, PausedClientFrames> = new Map();
  private readonly beforePersistWrite?: () => Promise<void>;

  constructor(opts?: { beforePersistWrite?: () => Promise<void> }) {
    this.beforePersistWrite = opts?.beforePersistWrite;
  }

  async getOrCreateDoc(spaceId: string, docPath: string): Promise<Y.Doc> {
    return (await this.getOrCreateLiveDoc(spaceId, docPath)).ydoc;
  }

  private getOrCreateLiveDoc(
    spaceId: string,
    docPath: string
  ): Promise<LiveDoc> {
    const key = docKey(spaceId, docPath);
    if (this.frozenDocs.has(key)) {
      return Promise.reject(
        new Error(`document ${spaceId}/${docPath} is changing format`)
      );
    }
    const existing = this.docs.get(key);
    if (existing) return Promise.resolve(existing);

    const initializing = this.initializingDocs.get(key);
    if (initializing) return initializing;

    let task!: Promise<LiveDoc>;
    task = (async () => {
      try {
        return await this.loadLiveDoc(spaceId, docPath, key);
      } finally {
        if (this.initializingDocs.get(key) === task) {
          this.initializingDocs.delete(key);
        }
      }
    })();
    this.initializingDocs.set(key, task);
    return task;
  }

  private async loadLiveDoc(
    spaceId: string,
    docPath: string,
    key: string
  ): Promise<LiveDoc> {
    // Collaborative runtime state is persisted as Yjs binary updates. Portable
    // JSON docs are exported snapshots for agents/search/version history and are
    // imported when no fresh local Yjs state exists.
    const persistedYjsPath = yjsStatePath(spaceId, docPath);
    const current = await readDoc(spaceId, docPath);
    if (current.error || current.data === null) {
      await removeFileIfExists(persistedYjsPath);
      throw new Error(`document ${spaceId}/${docPath} does not exist`);
    }
    if (current.storedAs === "md") {
      await removeFileIfExists(persistedYjsPath);
      throw new Error(`Markdown document ${spaceId}/${docPath} is read-only`);
    }
    let ydoc = new Y.Doc();
    const editor = await getEditor();
    const fileStat = await docStat(spaceId, docPath);
    const provenance = await getDocProvenance(spaceId, docPath);
    // Provenance and cache headers can agree with each other while both lag a
    // portable source that was published before its version transaction
    // failed. Never admit machine-local state unless provenance also describes
    // the bytes currently on disk.
    const portableProvenance =
      provenance?.contentHash === stableHash(current.data)
        ? provenance
        : undefined
    const persistedUpdate = existsSync(persistedYjsPath)
      ? await readCurrentYjsStateUpdate(
          persistedYjsPath,
          portableProvenance
        )
      : null;

    if (persistedUpdate) {
      Y.applyUpdate(ydoc, persistedUpdate, ORIGIN_INITIAL_LOAD);
      const currentBlocks = editor.yDocToBlocks(ydoc, FRAGMENT_NAME);
      const normalized = normalizeMermaidBlocks(currentBlocks);
      if (normalized.changed) {
        const imported = editor.blocksToYDoc(
          normalized.blocks as Parameters<typeof editor.blocksToYDoc>[0],
          FRAGMENT_NAME
        );
        ydoc.destroy();
        ydoc = imported;
      }
    } else {
      if (Array.isArray(current.data)) {
        const normalized = normalizeMermaidBlocks(current.data);
        const imported = editor.blocksToYDoc(
          normalized.blocks as Parameters<typeof editor.blocksToYDoc>[0],
          FRAGMENT_NAME
        );
        Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(imported), ORIGIN_INITIAL_LOAD);
        imported.destroy();
        // Opening a legacy document should not itself rewrite either portable
        // content or machine-local collaboration state. The normalized block
        // shape is persisted by the next genuine edit.
        if (!normalized.changed) {
          await writeYjsStateFile(
            persistedYjsPath,
            Y.encodeStateAsUpdate(ydoc),
            portableProvenance
          );
          if (!portableProvenance) {
            await removeFileIfExists(persistedYjsPath)
          }
        }
      }
    }

    const protectedSource =
      portableProvenance?.source &&
      !isBrowserSource(portableProvenance.source) &&
      portableProvenance.source !== "rest-api";
    const liveDoc: LiveDoc = {
      ydoc,
      spaceId,
      key,
      docPath,
      clients: new Set(),
      persistTimer: null,
      persistPromise: null,
      persistAgain: false,
      unloadTimer: null,
      lastPersistMs: fileStat?.updatedAt ?? Date.now(),
      protectedUntilMs: protectedSource ? Date.now() + 15_000 : 0,
      humanEdited: false,
      contentGeneration: ++this.nextContentGeneration,
      intentGeneration: 0,
    };

    // Listen for updates: broadcast to other clients + schedule persist
    ydoc.on("update", (update: Uint8Array, origin: unknown) => {
      liveDoc.contentGeneration = ++this.nextContentGeneration;
      // Skip persist for file-watcher and initial-load origins.
      // Everything else, including browser edits, restores, and API writes,
      // updates the canonical Yjs state and exported JSON snapshot.
      if (origin !== ORIGIN_FILE_WATCHER && origin !== ORIGIN_INITIAL_LOAD) {
        this.schedulePersist(liveDoc.key, spaceId, liveDoc.docPath);
      }

      // Broadcast incremental update to all clients EXCEPT the origin
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      const msg = encoding.toUint8Array(encoder);

      for (const client of liveDoc.clients) {
        if (client !== origin) {
          try {
            client.send(msg);
          } catch {
            // Client disconnected, will be cleaned up
          }
        }
      }
    });

    this.docs.set(key, liveDoc);
    return liveDoc;
  }

  handleConnection(
    ws: WsClient,
    spaceId: string,
    docPath: string,
    freshness?: { baseVersionId?: string; baseContentHash?: string }
  ): Promise<void> {
    if (this.pendingConnections.has(ws) || this.clientDocs.has(ws)) {
      return Promise.reject(new Error("Yjs client is already connecting or connected"));
    }

    const pending: PendingConnection = {
      spaceId,
      docPath,
      frames: [],
      queuedBytes: 0,
      disconnected: false,
      task: null,
    };
    this.pendingConnections.set(ws, pending);

    let task!: Promise<void>;
    task = this.initializeConnection(ws, pending, freshness).finally(() => {
      if (this.pendingConnections.get(ws) === pending) {
        this.pendingConnections.delete(ws);
      }
      this.connectionTasks.delete(task);
    });
    pending.task = task;
    this.connectionTasks.add(task);
    return task;
  }

  private async initializeConnection(
    ws: WsClient,
    pending: PendingConnection,
    freshness?: { baseVersionId?: string; baseContentHash?: string }
  ): Promise<void> {
    const { spaceId, docPath } = pending;
    let liveDoc: LiveDoc | null = null;

    try {
      liveDoc = await this.getOrCreateLiveDoc(spaceId, docPath);

      const provenance = await getDocProvenance(spaceId, docPath);
      const hasClientBase = Boolean(
        freshness?.baseVersionId || freshness?.baseContentHash
      );
      const stale = Boolean(
        hasClientBase &&
          provenance &&
          ((freshness?.baseVersionId &&
            freshness.baseVersionId !== provenance.versionId) ||
            (freshness?.baseContentHash &&
              freshness.baseContentHash !== provenance.contentHash))
      );

      if (pending.disconnected) {
        this.scheduleUnloadIfEmpty(liveDoc);
        return;
      }

      this.clientFreshness.set(ws, {
        baseVersionId: freshness?.baseVersionId,
        baseContentHash: freshness?.baseContentHash,
        stale,
      });

      if (stale) {
        console.warn(
          `[YjsManager] stale client connected for ${docPath}; baseVersion=${freshness?.baseVersionId}, currentVersion=${provenance?.versionId}`
        );
      }

      liveDoc.clients.add(ws);
      this.clientDocs.set(ws, liveDoc);

      if (liveDoc.unloadTimer) {
        clearTimeout(liveDoc.unloadTimer);
        liveDoc.unloadTimer = null;
      }

      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(encoder, liveDoc.ydoc);
      ws.send(encoding.toUint8Array(encoder));

      const pingTimer = setInterval(() => {
        try {
          const pingEncoder = encoding.createEncoder();
          encoding.writeVarUint(pingEncoder, MESSAGE_PING);
          ws.send(encoding.toUint8Array(pingEncoder));
        } catch {
          // Client gone; the transport's close callback performs cleanup.
        }
      }, PING_INTERVAL_MS);
      this.pingTimers.set(ws, pingTimer);

      const queuedFrames = pending.frames;
      pending.frames = [];
      pending.queuedBytes = 0;
      this.pendingConnections.delete(ws);
      for (const frame of queuedFrames) {
        this.dispatchOrQueueMessage(ws, liveDoc, frame);
      }
    } catch (err) {
      this.detachClient(ws, {
        close: false,
        keepPending: false,
        scheduleUnload: true,
      });
      throw err;
    }
  }

  handleMessage(
    ws: WsClient,
    spaceId: string,
    docPath: string,
    data: ArrayBuffer | Uint8Array | string
  ): void {
    let frame: Uint8Array;
    if (data instanceof Uint8Array) {
      frame = data;
    } else if (data instanceof ArrayBuffer) {
      frame = new Uint8Array(data);
    } else {
      return;
    }

    const liveDoc = this.clientDocs.get(ws);
    if (liveDoc) {
      this.dispatchOrQueueMessage(ws, liveDoc, {
        bytes: frame,
        sequence: ++this.acceptedFrameSequence,
      });
      return;
    }

    const pending = this.pendingConnections.get(ws);
    if (!pending || pending.disconnected) return;
    if (pending.spaceId !== spaceId || pending.docPath !== docPath) return;

    const nextBytes = pending.queuedBytes + frame.byteLength;
    if (
      pending.frames.length >= MAX_PENDING_CONNECTION_FRAMES ||
      nextBytes > MAX_PENDING_CONNECTION_BYTES
    ) {
      console.warn(
        `[YjsManager] closing ${spaceId}/${docPath}: pending connection queue exceeded its limit`
      );
      this.detachClient(ws, {
        close: true,
        keepPending: true,
        scheduleUnload: true,
      });
      return;
    }

    const copy = new Uint8Array(frame.byteLength);
    copy.set(frame);
    pending.frames.push({
      bytes: copy,
      sequence: ++this.acceptedFrameSequence,
    });
    pending.queuedBytes = nextBytes;
  }

  /**
   * Freeze mutations from already-upgraded Yjs rooms while a portable snapshot
   * is captured. Frames are bounded and replayed in order after the barrier, so
   * clients neither write into the snapshot window nor lose accepted edits.
   */
  pauseWorkspaceMutations(): () => void {
    if (this.mutationsPaused) {
      throw new Error("Yjs workspace mutations are already paused");
    }
    if (this.pausedDocMutationCutoffs.size > 0) {
      throw new Error("Yjs document mutations are paused for a move");
    }
    // Frames already accepted by the transport remain inside the snapshot
    // cutoff, including frames waiting on a cold room initialization. Frames
    // accepted after this point are replayed only after capture completes.
    this.mutationPauseCutoff = this.acceptedFrameSequence;
    this.mutationsPaused = true;
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      if (workspaceRecoveryRequired()) {
        this.pausedClientFrames.clear();
        return;
      }
      this.mutationsPaused = false;
      this.replayPausedFrames();
    };
  }

  private frameMutationIsPaused(
    liveDoc: LiveDoc,
    frame: AcceptedClientFrame
  ): boolean {
    if (
      this.mutationsPaused &&
      frame.sequence > this.mutationPauseCutoff
    ) {
      return true
    }
    const docCutoff = this.pausedDocMutationCutoffs.get(liveDoc.key)
    return docCutoff !== undefined && frame.sequence > docCutoff
  }

  private replayPausedFrames(docKeys?: ReadonlySet<string>): void {
    if (workspaceRecoveryRequired()) {
      this.pausedClientFrames.clear()
      return
    }
    const queued = [...this.pausedClientFrames.entries()].filter(
      ([, pending]) => !docKeys || docKeys.has(pending.liveDoc.key)
    )
    for (const [client] of queued) this.pausedClientFrames.delete(client)
    for (const [client, pending] of queued) {
      if (this.clientDocs.get(client) !== pending.liveDoc) continue
      for (const frame of pending.frames) {
        try {
          this.processMessage(client, pending.liveDoc, frame.bytes)
        } catch (error) {
          console.warn(
            `[YjsManager] closing ${pending.liveDoc.spaceId}/${pending.liveDoc.docPath}: queued frame replay failed`,
            error
          )
          this.detachClient(client, {
            close: true,
            keepPending: false,
            scheduleUnload: true,
          })
          break
        }
      }
    }
  }

  private dispatchOrQueueMessage(
    ws: WsClient,
    liveDoc: LiveDoc,
    frame: AcceptedClientFrame
  ): void {
    if (!this.frameMutationIsPaused(liveDoc, frame)) {
      this.processMessage(ws, liveDoc, frame.bytes);
      return;
    }
    const pending = this.pausedClientFrames.get(ws) ?? {
      liveDoc,
      frames: [],
      queuedBytes: 0,
    };
    const nextBytes = pending.queuedBytes + frame.bytes.byteLength;
    if (
      pending.frames.length >= MAX_PENDING_CONNECTION_FRAMES ||
      nextBytes > MAX_PENDING_CONNECTION_BYTES
    ) {
      console.warn(
        `[YjsManager] closing ${liveDoc.spaceId}/${liveDoc.docPath}: paused mutation queue exceeded its limit`
      );
      this.pausedClientFrames.delete(ws);
      this.detachClient(ws, {
        close: true,
        keepPending: false,
        scheduleUnload: true,
      });
      return;
    }
    const copy = new Uint8Array(frame.bytes.byteLength);
    copy.set(frame.bytes);
    pending.frames.push({ bytes: copy, sequence: frame.sequence });
    pending.queuedBytes = nextBytes;
    this.pausedClientFrames.set(ws, pending);
  }

  private processMessage(
    ws: WsClient,
    liveDoc: LiveDoc,
    frame: Uint8Array
  ): void {
    const decoder = decoding.createDecoder(frame);
    const messageType = decoding.readVarUint(decoder);

    if (messageType === MESSAGE_SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);

      // readSyncMessage applies updates to ydoc (with ws as origin).
      // The ydoc 'update' handler broadcasts incremental updates to other clients.
      syncProtocol.readSyncMessage(decoder, encoder, liveDoc.ydoc, ws);

      // Send response if encoder has content (sync step 2 reply)
      if (encoding.length(encoder) > 1) {
        ws.send(encoding.toUint8Array(encoder));
      }
    } else if (messageType === MESSAGE_INTENT) {
      // Client observed a genuine local (human) edit. Attribution of the next
      // persist becomes "human"; without this signal a content change is
      // treated as machine normalization and recorded as a system source.
      // Acknowledged only when a persist CONSUMES the signal (see persistDoc),
      // not on receipt: a receipt ack would clear the client's replay marker
      // while the flag still lives only in this process's memory, so a crash
      // before the debounced persist would lose the attribution for good.
      liveDoc.humanEdited = true;
      liveDoc.intentGeneration += 1;
    } else if (messageType === MESSAGE_AWARENESS) {
      // Single-user app; awareness not needed. Ignore.
    }
  }

  handleDisconnect(ws: WsClient, spaceId: string, docPath: string): void {
    const pending = this.pendingConnections.get(ws);
    if (
      pending &&
      (pending.spaceId !== spaceId || pending.docPath !== docPath)
    ) {
      return;
    }
    this.detachClient(ws, {
      close: false,
      keepPending: true,
      scheduleUnload: true,
    });
  }

  /**
   * Replace a loaded doc's live content with the CANONICAL on-disk blocks the
   * caller just wrote (MCP tool writes, REST PUT, version restore). This is
   * disk content, so it gets the same treatment as a watcher sync — applied
   * with the file-watcher origin (broadcasts to clients, schedules no echo
   * persist) and with all bookkeeping armed SYNCHRONOUSLY: waiting for a
   * debounced persist to arm the stale-cache window would leave a gap in
   * which a stale reconnect could land over a fresh agent version.
   */
  async replaceContent(
    spaceId: string,
    docPath: string,
    blocks: unknown[]
  ): Promise<void> {
    const key = docKey(spaceId, docPath);
    const liveDoc = this.docs.get(key);
    if (!liveDoc) return; // Not loaded in memory, nothing to update
    const intentAtStart = this.snapshotEditIntent(liveDoc);
    await this.applyDiskContent(
      liveDoc,
      spaceId,
      docPath,
      blocks,
      intentAtStart
    );
  }

  /**
   * Sync a doc from disk into the in-memory Y.Doc.
   * Called by the file watcher when an external process writes to a doc file.
   * Broadcasts the update to all connected browser clients.
   */
  contentGeneration(spaceId: string, docPath: string): number | null {
    return this.docs.get(docKey(spaceId, docPath))?.contentGeneration ?? null;
  }

  async syncFromDisk(
    spaceId: string,
    docPath: string,
    options?: { ifContentGeneration?: number }
  ): Promise<DiskSyncResult> {
    console.log(`[Worktable] syncFromDisk called: spaceId=${spaceId}, docPath=${docPath}`);
    const key = docKey(spaceId, docPath);
    const liveDoc = this.docs.get(key);
    console.log(`[Worktable] syncFromDisk: LiveDoc exists=${!!liveDoc} for key=${key}`);
    if (!liveDoc) return "not-loaded"; // Not loaded in memory, nothing to sync
    const intentAtStart = this.snapshotEditIntent(liveDoc);

    const expectedGeneration = options?.ifContentGeneration;
    if (expectedGeneration !== undefined) {
      if (liveDoc.contentGeneration !== expectedGeneration) {
        this.requiredDiskSyncs.delete(liveDoc);
        return "superseded";
      }
      // Register before the first await. If this attempt fails before applying
      // disk content, every queued persist must retry it instead of writing the
      // stale room over the external file whose provenance is already durable.
      this.requiredDiskSyncs.set(liveDoc, expectedGeneration);
    }

    console.log(`[Worktable] syncFromDisk: connected clients=${liveDoc.clients.size}`);

    try {
      const result = await readDoc(spaceId, docPath);
      // File deleted, unreadable, or markdown (read-only in the editor).
      if (!Array.isArray(result.data) || result.storedAs === "md") {
        this.requiredDiskSyncs.delete(liveDoc);
        return "not-applicable";
      }

      console.log(`[Worktable] syncFromDisk: blocks read from disk=${result.data.length}`);
      const applied = await this.applyDiskContent(
        liveDoc,
        spaceId,
        docPath,
        result.data,
        intentAtStart,
        expectedGeneration
      );
      this.requiredDiskSyncs.delete(liveDoc);
      if (applied !== "applied") return applied;
      console.log(`[Worktable] syncFromDisk: Y.Doc update applied for ${docKey(spaceId, docPath)}`);
      return "applied";
    } catch (error) {
      if (
        expectedGeneration !== undefined &&
        (liveDoc.contentGeneration !== expectedGeneration ||
          liveDoc.spaceId !== spaceId ||
          liveDoc.docPath !== docPath ||
          this.docs.get(liveDoc.key) !== liveDoc)
      ) {
        this.requiredDiskSyncs.delete(liveDoc);
      }
      throw error;
    }
  }

  /**
   * Apply already-on-disk blocks to a live Y.Doc: replace the fragment with
   * the file-watcher origin (broadcast, no persist scheduling — the content
   * is persisted by definition), refresh the machine-local Yjs state, and
   * update the guard bookkeeping (lastPersistMs, protected window, spent
   * edit signal).
   */
  private async applyDiskContent(
    liveDoc: LiveDoc,
    spaceId: string,
    docPath: string,
    blocks: unknown[],
    intentAtStart: EditIntentSnapshot,
    ifContentGeneration?: number
  ): Promise<"applied" | "superseded"> {
    const editor = await getEditor();
    const normalized = normalizeMermaidBlocks(blocks).blocks;
    // Build the replacement away from the live room. Schema conversion can
    // fail, and deleting the live fragment before that conversion completes
    // would leave a partially replaced document that a retry cannot safely
    // distinguish from a newer accepted edit.
    const preparedDoc = new Y.Doc();
    const preparedFragment = preparedDoc.getXmlFragment(FRAGMENT_NAME);
    let replacement: Parameters<Y.XmlFragment["insert"]>[1];
    try {
      editor.blocksToYXmlFragment(
        normalized as Parameters<typeof editor.blocksToYXmlFragment>[0],
        preparedFragment
      );
      replacement = preparedFragment
        .toArray()
        .map((item) => item.clone()) as Parameters<Y.XmlFragment["insert"]>[1];
    } finally {
      preparedDoc.destroy();
    }

    // All fallible canonical reads happen before the live Y.Doc changes. A
    // failure here is therefore safe for the watcher to retry with the same
    // generation token.
    const fileStat = await docStat(spaceId, docPath);
    const provenance = await getDocProvenance(spaceId, docPath);
    if (
      liveDoc.spaceId !== spaceId ||
      liveDoc.docPath !== docPath ||
      this.docs.get(liveDoc.key) !== liveDoc ||
      (ifContentGeneration !== undefined &&
        liveDoc.contentGeneration !== ifContentGeneration)
    ) {
      return "superseded";
    }
    const { ydoc } = liveDoc;

    ydoc.transact(() => {
      const fragment = ydoc.getXmlFragment(FRAGMENT_NAME);
      fragment.delete(0, fragment.length);
      fragment.insert(0, replacement);
    }, ORIGIN_FILE_WATCHER);

    const protectedSource = provenance?.source && !isBrowserSource(provenance.source) && provenance.source !== "rest-api";
    // Once the transaction commits, arm every correctness guard without an
    // await. A later client update must observe the new baseline even if the
    // derived machine-local state file cannot be refreshed.
    liveDoc.lastPersistMs = fileStat?.updatedAt ?? Date.now();
    liveDoc.protectedUntilMs = protectedSource ? Date.now() + 15_000 : 0;
    // Disk content just replaced the doc: an earlier edit signal referred to
    // content that is now persisted or superseded, so spend it AND acknowledge
    // it — clearing without the ack would leave the client's replay marker
    // set, and a much later reconnect would re-assert phantom human intent
    // over whatever is fresh then. A user actively typing re-asserts on their
    // next input.
    if (
      intentAtStart.hadIntent &&
      liveDoc.intentGeneration === intentAtStart.generation
    ) {
      liveDoc.humanEdited = false;
      this.sendIntentAck(liveDoc);
    }
    try {
      await writeYjsStateFile(
        yjsStatePath(spaceId, docPath),
        Y.encodeStateAsUpdate(ydoc),
        provenance
      );
    } catch (error) {
      console.warn(
        `[YjsManager] failed to refresh derived Yjs state for ${spaceId}/${docPath}:`,
        error
      );
    }
    return "applied";
  }

  private snapshotEditIntent(liveDoc: LiveDoc): EditIntentSnapshot {
    return {
      hadIntent: liveDoc.humanEdited,
      generation: liveDoc.intentGeneration,
    };
  }

  /** Check if a doc is currently loaded in memory */
  isLoaded(spaceId: string, docPath: string): boolean {
    return this.docs.has(docKey(spaceId, docPath));
  }

  async deleteState(spaceId: string, docPath: string): Promise<void> {
    const key = docKey(spaceId, docPath);
    const connecting: Promise<void>[] = [];
    for (const [client, pending] of this.pendingConnections) {
      if (pending.spaceId === spaceId && pending.docPath === docPath) {
        if (pending.task) connecting.push(pending.task);
        this.detachClient(client, {
          close: true,
          keepPending: true,
          scheduleUnload: false,
        });
      }
    }
    await Promise.allSettled(connecting);
    await this.initializingDocs.get(key)?.catch(() => undefined);

    const liveDoc = this.docs.get(key);
    if (liveDoc) {
      if (liveDoc.persistTimer) clearTimeout(liveDoc.persistTimer);
      if (liveDoc.unloadTimer) clearTimeout(liveDoc.unloadTimer);
      for (const client of [...liveDoc.clients]) {
        this.detachClient(client, {
          close: true,
          keepPending: false,
          scheduleUnload: false,
        });
      }
      liveDoc.ydoc.destroy();
      this.docs.delete(key);
    }
    await removeFileIfExists(yjsStatePath(spaceId, docPath));
  }

  /**
   * Stop collaborative writes while one doc changes storage format. Connected
   * editors are closed before the final persist, so every update the server
   * accepted is included and no later Yjs write can race the transition.
   */
  async withDocFormatTransition<T>(
    spaceId: string,
    docPath: string,
    transition: () => Promise<T>
  ): Promise<T> {
    return this.withExclusiveDocTransition(spaceId, docPath, transition);
  }

  /**
   * Drain accepted edits and fence new rooms while one document generation is
   * replaced or retired. Frames accepted during the portable mutation stay
   * queued. A rejected mutation keeps the room and replays them; a committed
   * mutation retires the old room so it cannot overwrite the new generation.
   */
  async withDocGenerationTransition<T>(
    spaceId: string,
    docPath: string,
    transition: () => Promise<T>,
    didCommit: (result: T) => boolean,
    didPreserveGenerationOnError?: (error: unknown) => boolean
  ): Promise<T> {
    return this.withDocGenerationTransitions(
      spaceId,
      [docPath],
      transition,
      didCommit,
      didPreserveGenerationOnError
    )
  }

  /**
   * Drain and fence a bounded set of document generations as one mutation.
   * Rejected mutations replay every queued room only after compensation proves
   * the whole set survived; committed or uncertain mutations retire them all.
   */
  async withDocGenerationTransitions<T>(
    spaceId: string,
    docPaths: readonly string[],
    transition: () => Promise<T>,
    didCommit: (result: T) => boolean,
    didPreserveGenerationOnError?: (error: unknown) => boolean
  ): Promise<T> {
    const paths = [...new Set(docPaths)]
    if (paths.length === 0) {
      throw new Error("document generation transition requires a document")
    }
    const keys = new Set(paths.map((docPath) => docKey(spaceId, docPath)))
    if (this.mutationsPaused) {
      throw new DocFormatTransitionConflictError(
        "workspace document mutations are paused"
      )
    }
    const frozenPath = paths.find((docPath) =>
      this.frozenDocs.has(docKey(spaceId, docPath))
    )
    if (frozenPath) {
      throw new DocFormatTransitionConflictError(
        `document ${spaceId}/${frozenPath} is already changing`
      )
    }

    const pauseCutoff = this.acceptedFrameSequence
    for (const key of keys) {
      this.frozenDocs.add(key)
      this.pausedDocMutationCutoffs.set(key, pauseCutoff)
    }
    let drainSucceeded = false
    let retireRooms = false
    let operationError: unknown
    let result!: T
    try {
      const connecting = [...this.pendingConnections.values()]
        .filter(
          (pending) =>
            pending.spaceId === spaceId &&
            keys.has(docKey(spaceId, pending.docPath))
        )
        .flatMap((pending) => (pending.task ? [pending.task] : []))
      await Promise.allSettled(connecting)
      await Promise.allSettled(
        [...keys]
          .map((key) => this.initializingDocs.get(key))
          .filter((task): task is Promise<LiveDoc> => Boolean(task))
      )

      for (const key of keys) {
        const liveDoc = this.docs.get(key)
        if (liveDoc?.persistTimer) {
          clearTimeout(liveDoc.persistTimer)
          liveDoc.persistTimer = null
        }
      }
      for (const key of keys) await this.runPersist(key)
      drainSucceeded = true

      result = await transition()
      retireRooms = didCommit(result)
    } catch (error) {
      operationError = error
      // Once the portable mutation starts, an exception leaves its commit
      // state uncertain unless its transaction proves that compensation
      // restored the same generation. Only that proven case may replay frames.
      if (drainSucceeded) {
        retireRooms = !didPreserveGenerationOnError?.(error)
      }
    } finally {
      const cacheRetirementErrors: unknown[] = []
      if (drainSucceeded && retireRooms) {
        for (const path of paths) {
          try {
            await removeFileIfExists(yjsStatePath(spaceId, path))
          } catch (error) {
            cacheRetirementErrors.push(error)
            requireWorkspaceRecovery(
              "document generation collaboration state could not be retired"
            )
          }
        }
        for (const key of keys) {
          const liveDoc = this.docs.get(key)
          if (liveDoc) {
            if (liveDoc.persistTimer) clearTimeout(liveDoc.persistTimer)
            if (liveDoc.unloadTimer) clearTimeout(liveDoc.unloadTimer)
            for (const client of [...liveDoc.clients]) {
              this.detachClient(client, {
                close: true,
                keepPending: false,
                scheduleUnload: false,
              })
            }
            liveDoc.ydoc.destroy()
            this.docs.delete(key)
          }
        }
      }
      for (const key of keys) {
        this.pausedDocMutationCutoffs.delete(key)
        this.frozenDocs.delete(key)
      }
      if (!retireRooms) {
        if (!drainSucceeded) {
          for (const key of keys) {
            const liveDoc = this.docs.get(key)
            if (liveDoc) this.scheduleUnloadIfEmpty(liveDoc)
          }
        }
        this.replayPausedFrames(keys)
      }
      const cacheRetirementError =
        cacheRetirementErrors.length === 0
          ? undefined
          : cacheRetirementErrors.length === 1
            ? cacheRetirementErrors[0]
            : new AggregateError(
                cacheRetirementErrors,
                "document generation collaboration states could not be retired"
              )
      if (cacheRetirementError && operationError) {
        operationError = new AggregateError(
          [operationError, cacheRetirementError],
          "document generation failed and collaboration state could not be retired"
        )
      } else if (cacheRetirementError) operationError = cacheRetirementError
    }
    if (operationError) throw operationError
    return result
  }

  private async withExclusiveDocTransition<T>(
    spaceId: string,
    docPath: string,
    transition: () => Promise<T>
  ): Promise<T> {
    const key = docKey(spaceId, docPath);
    if (this.frozenDocs.has(key)) {
      throw new DocFormatTransitionConflictError(
        `document ${spaceId}/${docPath} is already changing format`
      );
    }
    this.frozenDocs.add(key);
    let drainSucceeded = false;

    try {
      const connecting: Array<{ client: WsClient; task: Promise<void> }> = [];
      for (const [client, pending] of this.pendingConnections) {
        if (pending.spaceId === spaceId && pending.docPath === docPath) {
          if (pending.task) connecting.push({ client, task: pending.task });
        }
      }
      await Promise.allSettled(connecting.map(({ task }) => task));
      for (const { client } of connecting) {
        this.detachClient(client, {
          close: true,
          keepPending: false,
          scheduleUnload: false,
        });
      }
      await this.initializingDocs.get(key)?.catch(() => undefined);

      const liveDoc = this.docs.get(key);
      if (liveDoc) {
        for (const client of [...liveDoc.clients]) {
          this.detachClient(client, {
            close: true,
            keepPending: false,
            scheduleUnload: false,
          });
        }
        if (liveDoc.persistTimer) {
          clearTimeout(liveDoc.persistTimer);
          liveDoc.persistTimer = null;
        }
        await this.runPersist(key);
      }
      drainSucceeded = true;

      return await transition();
    } finally {
      if (!drainSucceeded) {
        // A failed drain still owns accepted in-memory edits. Keep the room so
        // its normal unload path can retry instead of discarding that state.
        this.frozenDocs.delete(key);
        const liveDoc = this.docs.get(key);
        if (liveDoc) this.scheduleUnloadIfEmpty(liveDoc);
      } else {
        try {
          // A generation transition replaces or retires the portable snapshot.
          // The old room must not survive and later overwrite that outcome from
          // stale memory.
          const liveDoc = this.docs.get(key);
          if (liveDoc) {
            if (liveDoc.persistTimer) clearTimeout(liveDoc.persistTimer);
            if (liveDoc.unloadTimer) clearTimeout(liveDoc.unloadTimer);
            for (const client of [...liveDoc.clients]) {
              this.detachClient(client, {
                close: true,
                keepPending: false,
                scheduleUnload: false,
              });
            }
            liveDoc.ydoc.destroy();
            this.docs.delete(key);
          }
        } finally {
          this.frozenDocs.delete(key);
        }
      }
    }
  }

  /**
   * Fence both path identities while a durable rename commits. Existing
   * clients remain attached to the same room; accepted edits are persisted
   * before the move and frames arriving during it replay after the room is
   * re-keyed. New source or destination rooms cannot initialize mid-move.
   */
  async withDocPathMoveTransition<T>(
    spaceId: string,
    oldPath: string,
    newPath: string,
    transition: () => Promise<T>
  ): Promise<T> {
    return this.withDocPathMoveTransitions(
      spaceId,
      [{ from: oldPath, to: newPath }],
      transition
    )
  }

  /**
   * Fence every source and destination identity while a bounded path move
   * commits. Sources may also be destinations, so ancestor-overlapping moves
   * and swaps share one mutation barrier without treating each other as open
   * destination conflicts.
   */
  async withDocPathMoveTransitions<T>(
    spaceId: string,
    moves: readonly { from: string; to: string }[],
    transition: () => Promise<T>
  ): Promise<T> {
    const preparedMoves = prepareDocPathMoves(spaceId, moves)
    const previous = this.moveTransitionTail
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => current)
    this.moveTransitionTail = tail
    await previous

    const oldKeys = new Set(preparedMoves.map((move) => move.oldKey))
    const fencedKeys = new Set(
      preparedMoves.flatMap((move) => [move.oldKey, move.newKey])
    )
    try {
      if (this.mutationsPaused) {
        throw new Error("Yjs workspace mutations are already paused")
      }
      const frozenMove = preparedMoves.find(
        (move) =>
          this.frozenDocs.has(move.oldKey) ||
          this.frozenDocs.has(move.newKey)
      )
      if (frozenMove) {
        throw new DocFormatTransitionConflictError(
          `document ${spaceId}/${frozenMove.from} or ${frozenMove.to} is already moving`
        )
      }
      for (const key of fencedKeys) this.frozenDocs.add(key)
      const pauseCutoff = this.acceptedFrameSequence
      for (const key of fencedKeys) {
        this.pausedDocMutationCutoffs.set(key, pauseCutoff)
      }
      try {
        const connecting = [...this.pendingConnections.values()]
          .filter(
            (pending) =>
              pending.spaceId === spaceId &&
              fencedKeys.has(docKey(spaceId, pending.docPath))
          )
          .flatMap((pending) => (pending.task ? [pending.task] : []))
        await Promise.allSettled(connecting)
        await Promise.allSettled(
          [...fencedKeys]
            .map((key) => this.initializingDocs.get(key))
            .filter((task): task is Promise<LiveDoc> => Boolean(task))
        )
        const occupiedMove = preparedMoves.find(
          (move) =>
            !oldKeys.has(move.newKey) && this.docs.has(move.newKey)
        )
        if (occupiedMove) {
          throw new DocFormatTransitionConflictError(
            `document destination ${spaceId}/${occupiedMove.to} is already open`
          )
        }
        for (const { oldKey } of preparedMoves) {
          const liveDoc = this.docs.get(oldKey)
          if (liveDoc?.persistTimer) {
            clearTimeout(liveDoc.persistTimer)
            liveDoc.persistTimer = null
          }
          await this.runPersist(oldKey)
        }
        return await transition()
      } finally {
        for (const key of fencedKeys) {
          this.pausedDocMutationCutoffs.delete(key)
          this.frozenDocs.delete(key)
        }
        this.replayPausedFrames(fencedKeys)
      }
    } finally {
      release()
      if (this.moveTransitionTail === tail) {
        this.moveTransitionTail = Promise.resolve()
      }
    }
  }

  /**
   * Rekey the live rooms for a committed batch move. All sources are removed
   * before any destination is installed so source/destination overlap cannot
   * overwrite another room. Machine-local state files are derived caches; an
   * involved cache is discarded and rebuilt from the committed portable doc.
   */
  async renameStatesBatch(
    spaceId: string,
    moves: readonly { from: string; to: string }[]
  ): Promise<void> {
    const preparedMoves = prepareDocPathMoves(spaceId, moves)
    const oldKeys = new Set(preparedMoves.map((move) => move.oldKey))
    const fencedKeys = new Set(
      preparedMoves.flatMap((move) => [move.oldKey, move.newKey])
    )

    const connecting = [...this.pendingConnections.values()]
      .filter(
        (pending) =>
          pending.spaceId === spaceId &&
          fencedKeys.has(docKey(spaceId, pending.docPath))
      )
      .flatMap((pending) => (pending.task ? [pending.task] : []))
    await Promise.allSettled(connecting)
    await Promise.allSettled(
      [...fencedKeys]
        .map((key) => this.initializingDocs.get(key))
        .filter((task): task is Promise<LiveDoc> => Boolean(task))
    )

    const occupiedMove = preparedMoves.find(
      (move) => !oldKeys.has(move.newKey) && this.docs.has(move.newKey)
    )
    if (occupiedMove) {
      throw new DocFormatTransitionConflictError(
        `document destination ${spaceId}/${occupiedMove.to} is already open`
      )
    }

    const liveMoves = preparedMoves.flatMap((move) => {
      const liveDoc = this.docs.get(move.oldKey)
      if (!liveDoc) return []
      if (liveDoc.persistTimer) {
        clearTimeout(liveDoc.persistTimer)
        liveDoc.persistTimer = null
      }
      if (liveDoc.unloadTimer) {
        clearTimeout(liveDoc.unloadTimer)
        liveDoc.unloadTimer = null
      }
      return [{ move, liveDoc }]
    })

    for (const { oldKey } of preparedMoves) this.docs.delete(oldKey)
    for (const { move, liveDoc } of liveMoves) {
      this.docs.set(move.newKey, liveDoc)
      liveDoc.key = move.newKey
      liveDoc.docPath = move.to
    }

    const cachePaths = new Set(
      preparedMoves.flatMap((move) => [
        yjsStatePath(spaceId, move.from),
        yjsStatePath(spaceId, move.to),
      ])
    )
    const cacheResults = await Promise.allSettled(
      [...cachePaths].map((path) => rm(path, { force: true }))
    )
    const cacheErrors = cacheResults.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    )
    if (cacheErrors.length > 0) {
      console.warn(
        `[YjsManager] could not discard every stale cache while moving ${preparedMoves.length} documents in ${spaceId}`,
        cacheErrors
      )
    }

    for (const { move, liveDoc } of liveMoves) {
      this.schedulePersist(move.newKey, spaceId, move.to)
      if (liveDoc.clients.size === 0) this.scheduleUnloadIfEmpty(liveDoc)
    }
  }

  async renameState(spaceId: string, oldPath: string, newPath: string): Promise<void> {
    const oldKey = docKey(spaceId, oldPath);
    const connecting = [...this.pendingConnections.values()]
      .filter(
        (pending) =>
          pending.spaceId === spaceId && pending.docPath === oldPath
      )
      .flatMap((pending) => (pending.task ? [pending.task] : []));
    await Promise.allSettled(connecting);
    await this.initializingDocs.get(oldKey)?.catch(() => undefined);

    const oldLiveDoc = this.docs.get(oldKey);
    if (oldLiveDoc) {
      if (oldLiveDoc.persistTimer) {
        clearTimeout(oldLiveDoc.persistTimer);
        oldLiveDoc.persistTimer = null;
      }
      this.docs.delete(oldKey);
      const newKey = docKey(spaceId, newPath);
      this.docs.set(newKey, oldLiveDoc);
      oldLiveDoc.key = newKey;
      oldLiveDoc.docPath = newPath;
    }

    const oldStatePath = yjsStatePath(spaceId, oldPath);
    const newStatePath = yjsStatePath(spaceId, newPath);
    try {
      if (existsSync(oldStatePath)) {
        await mkdir(dirname(newStatePath), { recursive: true });
        // The portable destination has already been proven vacant under both
        // path fences. Its machine-local cache is therefore stale by definition,
        // and Windows rename will not replace it for us.
        await rm(newStatePath, { force: true });
        await rename(oldStatePath, newStatePath);
      }
    } catch (error) {
      await Promise.allSettled([
        rm(oldStatePath, { force: true }),
        rm(newStatePath, { force: true }),
      ]);
      console.warn(
        `[YjsManager] discarded stale cache while moving ${spaceId}/${oldPath} to ${newPath}`,
        error
      );
    } finally {
      if (oldLiveDoc) {
        this.schedulePersist(docKey(spaceId, newPath), spaceId, newPath);
      }
    }
  }

  // ── Private helpers ──────────────────────────────────────

  private detachClient(
    ws: WsClient,
    options: {
      close: boolean;
      keepPending: boolean;
      scheduleUnload: boolean;
    }
  ): void {
    const pending = this.pendingConnections.get(ws);
    if (pending) {
      pending.disconnected = true;
      pending.frames = [];
      pending.queuedBytes = 0;
      if (!options.keepPending) this.pendingConnections.delete(ws);
    }

    const pingTimer = this.pingTimers.get(ws);
    if (pingTimer) {
      clearInterval(pingTimer);
      this.pingTimers.delete(ws);
    }

    this.clientFreshness.delete(ws);
    this.pausedClientFrames.delete(ws);
    const liveDoc = this.clientDocs.get(ws);
    this.clientDocs.delete(ws);
    if (liveDoc) {
      liveDoc.clients.delete(ws);
      if (options.scheduleUnload) this.scheduleUnloadIfEmpty(liveDoc);
    }

    if (options.close) {
      try {
        ws.close();
      } catch {
        // The transport may already have completed its close handshake.
      }
    }
  }

  private scheduleUnloadIfEmpty(liveDoc: LiveDoc): void {
    if (
      liveDoc.clients.size > 0 ||
      liveDoc.unloadTimer ||
      this.docs.get(liveDoc.key) !== liveDoc
    ) {
      return;
    }

    const key = liveDoc.key;
    const spaceId = liveDoc.spaceId;
    const docPath = liveDoc.docPath;
    liveDoc.unloadTimer = setTimeout(() => {
      void this.unloadDoc(key, spaceId, docPath);
    }, UNLOAD_DELAY_MS);
  }

  /**
   * Tell connected clients their edit intent was CONSUMED by a persist (either
   * attributed to a human write or spent on a semantic no-op). Clients keep
   * their replay marker until this arrives, so intent survives a server crash
   * between delivery and the debounced persist — the edit replays from the
   * client's local state on reconnect, and so does its attribution.
   */
  private sendIntentAck(liveDoc: LiveDoc): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_INTENT);
    const frame = encoding.toUint8Array(encoder);
    for (const client of liveDoc.clients) {
      try {
        client.send(frame);
      } catch {
        // Client gone; it will replay its pending intent on reconnect.
      }
    }
  }

  private schedulePersist(
    key: string,
    spaceId: string,
    docPath: string
  ): void {
    const liveDoc = this.docs.get(key);
    if (!liveDoc) return;

    if (liveDoc.persistTimer) {
      clearTimeout(liveDoc.persistTimer);
    }

    liveDoc.persistTimer = setTimeout(() => {
      liveDoc.persistTimer = null;
      this.runPersist(key).catch((err) =>
        console.error("[YjsManager] persist error:", err)
      );
    }, PERSIST_DEBOUNCE_MS);
  }

  /**
   * Run any pending persist for a loaded doc immediately, cancelling the
   * debounce. Used to flush deterministically (e.g. in tests, or a graceful
   * save) instead of waiting out PERSIST_DEBOUNCE_MS. No-op if not loaded.
   */
  async flushPersist(spaceId: string, docPath: string): Promise<void> {
    const key = docKey(spaceId, docPath);
    const liveDoc = this.docs.get(key);
    if (!liveDoc) return;
    if (liveDoc.persistTimer) {
      clearTimeout(liveDoc.persistTimer);
      liveDoc.persistTimer = null;
    }
    await this.runPersist(key);
  }

  /** Persist every currently loaded room without disconnecting its clients. */
  async flushAllPersists(): Promise<void> {
    if (this.initializingDocs.size > 0) {
      await Promise.allSettled([...this.initializingDocs.values()]);
    }
    const results = await Promise.allSettled(
      [...this.docs.entries()].map(async ([key, liveDoc]) => {
        if (liveDoc.persistTimer) {
          clearTimeout(liveDoc.persistTimer);
          liveDoc.persistTimer = null;
        }
        await this.runPersist(key);
      })
    );

    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "failed to persist collaborative edits before workspace export"
      );
    }
  }

  /** Serialize persists per room and replay once when an edit arrives mid-write. */
  private async runPersist(key: string): Promise<void> {
    const liveDoc = this.docs.get(key);
    if (!liveDoc) return;
    if (liveDoc.persistPromise) {
      liveDoc.persistAgain = true;
      await liveDoc.persistPromise;
      return;
    }

    const task = (async () => {
      do {
        liveDoc.persistAgain = false;
        await this.persistDoc(
          liveDoc.key,
          liveDoc.spaceId,
          liveDoc.docPath
        );
      } while (
        liveDoc.persistAgain && this.docs.get(liveDoc.key) === liveDoc
      );
    })();
    liveDoc.persistPromise = task;
    try {
      await task;
    } finally {
      if (liveDoc.persistPromise === task) liveDoc.persistPromise = null;
    }
  }

  private async persistDoc(
    key: string,
    spaceId: string,
    docPath: string
  ): Promise<void> {
    const liveDoc = this.docs.get(key);
    if (!liveDoc) return;

    const requiredDiskSync = this.requiredDiskSyncs.get(liveDoc);
    if (requiredDiskSync !== undefined) {
      if (liveDoc.contentGeneration !== requiredDiskSync) {
        // A later accepted room update supersedes the failed disk-sync attempt
        // and is now the content this persist is responsible for.
        this.requiredDiskSyncs.delete(liveDoc);
      } else {
        await this.syncFromDisk(spaceId, docPath, {
          ifContentGeneration: requiredDiskSync,
        });
        return;
      }
    }

    // Safety net: if the file on disk is newer than our last persist,
    // an external process wrote to it. Reload from disk instead of
    // overwriting with potentially stale Y.Doc state.
    const fileStat = await docStat(spaceId, docPath);
    if (fileStat && fileStat.updatedAt > liveDoc.lastPersistMs + 500) {
      console.log(
        `[YjsManager] mtime guard: ${docPath} modified externally (disk=${fileStat.updatedAt}, lastPersist=${liveDoc.lastPersistMs}), syncing from disk`
      );
      await this.syncFromDisk(spaceId, docPath);
      return;
    }

    const provenance = await getDocProvenance(spaceId, docPath);
    // Stale-cache guard: briefly refuse to overwrite a fresh agent/filesystem
    // version with a reconnecting browser's possibly-stale cached state. Only
    // applies when no human edit was signaled — a genuine local edit must never
    // be discarded, and intent gating already attributes it correctly.
    const protectedSource = provenance?.source && !isBrowserSource(provenance.source) && provenance.source !== "rest-api";
    if (protectedSource && !liveDoc.humanEdited && Date.now() < liveDoc.protectedUntilMs) {
      console.log(
        `[YjsManager] stale-cache guard: refusing early browser persist over ${provenance.source} version for ${docPath}`
      );
      await this.syncFromDisk(spaceId, docPath);
      return;
    }

    const editor = await getEditor();
    const blocks = editor.yDocToBlocks(liveDoc.ydoc, FRAGMENT_NAME);
    // Snapshot the edit signal WITH the content it describes. Awaits below
    // yield; an intent arriving mid-persist belongs to an edit that is not in
    // this snapshot and must neither attribute this write nor be cleared/acked
    // by it — the generation check below leaves it for the next persist.
    const hadIntent = liveDoc.humanEdited;
    const intentGen = liveDoc.intentGeneration;
    const spendIntent = () => {
      if (hadIntent && liveDoc.intentGeneration === intentGen) {
        liveDoc.humanEdited = false;
        this.sendIntentAck(liveDoc);
      }
    };

    // Semantic no-op guard: the browser's initial editor sync round-trips the
    // doc through y-prosemirror and emits a client update even when nothing
    // changed. Compare the exported blocks against the current on-disk content
    // in canonical form (both normalized by the same editor). If they match,
    // this persist carries no new content — refresh only the Yjs state cache
    // and record no version, so opening a doc never launders provenance. This
    // also covers legacy docs whose on-disk bytes predate canonical-on-write.
    const exportedHash = stableHash(blocks);
    const current = await readDoc(spaceId, docPath);
    await this.beforePersistWrite?.();
    // A rename can complete while the reads/conversion above are awaiting.
    // Never recreate the old path; ask the serialized loop to persist the
    // same room again under its current identity.
    if (liveDoc.key !== key || this.docs.get(key) !== liveDoc) {
      liveDoc.persistAgain = true;
      return;
    }
    // Markdown is an explicit read-only format in the browser, and a missing
    // canonical file must never be recreated from stale in-memory state.
    if (current.error || current.data === null || current.storedAs === "md") {
      return;
    }
    if (Array.isArray(current.data)) {
      let onDiskCanonicalHash: string;
      try {
        // Legacy files can hold id-less blocks; canonicalizing them standalone
        // would mint ids that can never match the ids the Y.Doc import minted,
        // so unchanged content would hash differently and record a phantom
        // version. Let the disk blocks adopt the live ids for matching content
        // first — identical content then hashes identically.
        onDiskCanonicalHash = stableHash(
          await canonicalizeBlocks(inheritBlockIds(current.data, blocks))
        );
      } catch {
        onDiskCanonicalHash = stableHash(current.data);
      }
      if (onDiskCanonicalHash === exportedHash) {
        await writeYjsStateFile(
          yjsStatePath(spaceId, docPath),
          Y.encodeStateAsUpdate(liveDoc.ydoc),
          provenance
        );
        liveDoc.lastPersistMs = fileStat?.updatedAt ?? liveDoc.lastPersistMs;
        // Belt to replaceContent's synchronous arming: if a no-op persist
        // observes a fresh protected version (e.g. the open-echo of an agent
        // doc), arm the stale-cache window here too — anchored at the file
        // mtime, so a fresh agent write protects its 15s while an old one
        // arms nothing.
        if (protectedSource) {
          liveDoc.protectedUntilMs = Math.max(
            liveDoc.protectedUntilMs,
            (fileStat?.updatedAt ?? Date.now()) + 15_000
          );
        }
        // An edit that nets out to no content change (e.g. typed then undone)
        // still consumed its intent: spend and acknowledge it, or the next
        // machine drift on this doc would inherit a human attribution and
        // bypass the stale-cache guard.
        spendIntent();
        return;
      }
    }

    // A genuine content change. Attribute it to a human only when a connected
    // client signaled a real local edit (MESSAGE_INTENT) BEFORE this snapshot
    // was exported; otherwise it is machine normalization drift and must not
    // read as human-reviewed.
    const source = hadIntent ? SOURCE_BROWSER_HUMAN : SOURCE_BROWSER_SYNC;
    const updatedBy = hadIntent ? "user" : "system";

    const filePath = getDocPath(spaceId, docPath);
    suppressPath(filePath);
    try {
      const writeResult = await writeDoc(spaceId, docPath, blocks, {
        updatedBy,
        source,
        managedIdentity: true,
      });
      if (!writeResult.ok) {
        throw new Error(writeResult.error ?? "Yjs document persist failed");
      }
      // The edit signal is spent by the persist it attributed, and the
      // consumption is acknowledged so clients drop their replay markers. A
      // live client re-asserts on every local edit, so only content that
      // changes WITHOUT further input (machine drift after an agent write,
      // editor normalization) is left to fall back to the system source.
      spendIntent();
      const updatedStat = await docStat(spaceId, docPath);
      const updatedProvenance = await getDocProvenance(spaceId, docPath);
      await writeYjsStateFile(
        yjsStatePath(spaceId, docPath),
        Y.encodeStateAsUpdate(liveDoc.ydoc),
        updatedProvenance
      );
      liveDoc.lastPersistMs = updatedStat?.updatedAt ?? Date.now();
      // The watcher is suppressed for this self-write, so without an explicit
      // event no doc-list consumer (sidebar labels derive from headings,
      // freshness dots) would ever hear about a browser edit.
      wsManager.broadcast(spaceId, {
        type: "doc_update",
        spaceId,
        docPath,
        data: {
          path: docPath,
          updatedAt: liveDoc.lastPersistMs,
          provenance: updatedProvenance,
        },
      });
    } finally {
      setTimeout(() => unsuppressPath(filePath), 150);
    }
  }

  private async unloadDoc(
    key: string,
    spaceId: string,
    docPath: string
  ): Promise<void> {
    const liveDoc = this.docs.get(key);
    if (!liveDoc) return;
    liveDoc.unloadTimer = null;

    // Final persist
    await this.runPersist(key).catch((err) =>
      console.error("[YjsManager] final persist error:", err)
    );

    // A client can reconnect while the final persist is awaiting filesystem
    // work. Its connection cancels the unload; never destroy an active or
    // rekeyed room when the old timer resumes.
    if (this.docs.get(key) !== liveDoc || liveDoc.clients.size > 0) return;

    // Cleanup
    if (liveDoc.persistTimer) clearTimeout(liveDoc.persistTimer);
    if (liveDoc.unloadTimer) clearTimeout(liveDoc.unloadTimer);
    liveDoc.ydoc.destroy();
    this.docs.delete(key);
  }

  /**
   * Stop process-local collaboration without persisting into an ambiguous
   * portable lifecycle. Browser clients retain unacknowledged intent and can
   * replay it after restart recovery.
   */
  quarantineForWorkspaceRecovery(): void {
    for (const [client] of this.pendingConnections) {
      this.detachClient(client, {
        close: true,
        keepPending: true,
        scheduleUnload: false,
      });
    }
    for (const liveDoc of this.docs.values()) {
      if (liveDoc.persistTimer) {
        clearTimeout(liveDoc.persistTimer);
        liveDoc.persistTimer = null;
      }
      if (liveDoc.unloadTimer) {
        clearTimeout(liveDoc.unloadTimer);
        liveDoc.unloadTimer = null;
      }
      for (const client of [...liveDoc.clients]) {
        this.detachClient(client, {
          close: true,
          keepPending: false,
          scheduleUnload: false,
        });
      }
    }
    this.pausedClientFrames.clear();
    this.pausedDocMutationCutoffs.clear();
    this.mutationsPaused = true;
  }

  /**
   * Flush every live room, then tear down its timers, clients, and Y.Doc.
   * Awaiting the final persist is what makes this a safe provider-reset and
   * supervised-restart boundary: no edit can be discarded or write later into
   * a different workspace root.
   */
  async shutdown(): Promise<void> {
    if (workspaceRecoveryRequired()) {
      this.quarantineForWorkspaceRecovery();
    }
    for (const [client] of this.pendingConnections) {
      this.detachClient(client, {
        close: true,
        keepPending: true,
        scheduleUnload: false,
      });
    }
    while (this.connectionTasks.size > 0) {
      await Promise.allSettled([...this.connectionTasks]);
    }
    if (this.initializingDocs.size > 0) {
      await Promise.allSettled([...this.initializingDocs.values()]);
    }

    const rooms = [...this.docs.entries()];
    const results = await Promise.allSettled(
      rooms.map(async ([key, liveDoc]) => {
        if (liveDoc.persistTimer) {
          clearTimeout(liveDoc.persistTimer);
          liveDoc.persistTimer = null;
        }
        if (workspaceRecoveryRequired()) {
          // Quarantine must not start a fresh persist, but an already-running
          // one still owns filesystem work. Await it before this room can be
          // destroyed or another workspace provider can start.
          await liveDoc.persistPromise;
          return;
        }
        await this.runPersist(key);
      })
    );

    for (const liveDoc of this.docs.values()) {
      if (liveDoc.persistTimer) clearTimeout(liveDoc.persistTimer);
      if (liveDoc.unloadTimer) clearTimeout(liveDoc.unloadTimer);
      for (const client of [...liveDoc.clients]) {
        this.detachClient(client, {
          close: true,
          keepPending: false,
          scheduleUnload: false,
        });
      }
      liveDoc.ydoc.destroy();
    }
    for (const ping of this.pingTimers.values()) clearInterval(ping);
    this.docs.clear();
    this.pingTimers.clear();
    this.clientFreshness.clear();
    this.clientDocs.clear();
    this.frozenDocs.clear();
    this.pausedDocMutationCutoffs.clear();
    this.mutationsPaused = false;
    this.acceptedFrameSequence = 0;
    this.mutationPauseCutoff = 0;
    this.pausedClientFrames.clear();
    this.pendingConnections.clear();
    this.connectionTasks.clear();
    this.initializingDocs.clear();

    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "failed to persist one or more Yjs documents during shutdown"
      );
    }
  }
}

export const yjsManager = new YjsDocManager();
