// ============================================================
// Widget (HTML doc) version history.
//
// Mirrors doc versioning through the shared version-store primitives:
// full before/after snapshots at versions/<space>/widgets/<widget-id>/,
// hash dedup, source-transition checkpoints, and provenance in a
// widgets.meta.json sidecar (the widget analog of docs.meta.json).
//
// A snapshot's content is { html, widget: {name, description, permissions,
// metadata, runtime} }: permissions are versioned deliberately — restoring
// old HTML without its matching permissions would silently widen or narrow
// the widget's records/network access. state.yaml is runtime state the
// widget mutates, not authored content, and is never versioned.
// ============================================================

import { existsSync } from "node:fs";
import { join } from "node:path";
import { sourceCategory, WidgetPermissionsSchema, type DocumentId, type WidgetFile } from "@worktable/types";
import { atomicWriteText, getSpacesBaseDir, withStoreWriteLock, type DocProvenance } from "./store.ts";
import {
  getWidgetContentPath,
  getWidgetPath,
  readWidget,
  readWidgetHtml,
  withWidgetWriteLock,
} from "./widget-store.ts";
import { readBoundedRegularFileBytes } from "./bounded-file.ts";
import { DOCUMENT_GENERATION_MAX_ENTRY_BYTES } from "./document-version-store-v2.ts";
import { deleteAnnotationWidgetId } from "./annotation-store.ts";
import {
  materializeHtmlDocumentStorageV2,
  readHtmlDocumentStorageV2,
  rebindHtmlDocumentSourceV2,
  resolveHtmlDocumentStorageV2,
  usesHtmlDocumentStorageV2,
} from "./html-document-storage-v2.ts";
import { listDocumentGenerationsV2 } from "./document-version-store-v2.ts";
import { getWorkspaceRoot } from "./workspace.ts";
import { withDocPathLock } from "./doc-path-lock.ts";
import { readDocumentInventory } from "./document-inventory.ts";
import {
  automaticCheckpointLabel,
  listVersionEntries,
  markVersionCheckpoint,
  mintVersionId,
  pruneNonCheckpointVersions,
  readVersionSnapshot,
  stableVersionHash,
  versionKeyDir,
  writeVersionSnapshot,
  type VersionCheckpoint,
  type VersionEntry,
  type VersionSnapshotBase,
} from "./version-store.ts";

// Checkpoints are kept forever; non-checkpoint versions beyond this cap are
// pruned after each record. HTML snapshots (full markup + CSS + JS, twice per
// version) are far heavier than block JSON, so widgets prune where docs never
// did.
const NON_CHECKPOINT_VERSIONS_KEPT = 200;

/** The versionable subset of widget.yaml — provenance churn fields excluded. */
export interface WidgetVersionContentWidget {
  name: string;
  description?: string;
  permissions: WidgetFile["permissions"];
  metadata: WidgetFile["metadata"];
  runtime: WidgetFile["runtime"];
}

export interface WidgetVersionContent {
  html: string;
  widget: WidgetVersionContentWidget;
  /** Internal exact authored bytes for Storage V2 generation capture. */
  authoredSource?: {
    htmlBytes: Uint8Array;
    widgetYamlBytes?: Uint8Array;
  };
}

export interface WidgetVersionSnapshot extends VersionSnapshotBase {
  type: "worktable.widget-version";
  widgetId: string;
  before: { format: string | null; storedAs: string | null; contentHash: string | null; content: WidgetVersionContent } | null;
  after: { format: string | null; storedAs: string | null; contentHash: string; content: WidgetVersionContent };
}

export interface WidgetVersionContext {
  updatedBy?: string;
  source?: string;
  reason?: string;
  checkpointLabel?: string;
  checkpoint?: boolean;
}

export function versionableWidget(widget: WidgetFile): WidgetVersionContentWidget {
  return {
    name: widget.name,
    ...(widget.description !== undefined ? { description: widget.description } : {}),
    permissions: widget.permissions,
    metadata: widget.metadata,
    runtime: widget.runtime,
  };
}

function semanticWidgetContent(
  content: WidgetVersionContent
): Omit<WidgetVersionContent, "authoredSource"> {
  return { html: content.html, widget: content.widget };
}

function widgetContentHash(content: WidgetVersionContent): string {
  return stableVersionHash(semanticWidgetContent(content));
}

/**
 * Read the widget's current state as version content. Call BEFORE a write to
 * capture the prior version; recordWidgetVersion reads the after-state itself.
 */
export async function captureWidgetVersionContent(
  spaceId: string,
  widgetId: string
): Promise<WidgetVersionContent | null> {
  if (await usesHtmlDocumentStorageV2()) {
    const document = await readHtmlDocumentStorageV2({ spaceId, path: widgetId });
    return document
      ? {
          html: document.html,
          widget: versionableWidget(document.widget),
          authoredSource: { htmlBytes: document.sourceBytes },
        }
      : null;
  }
  const { data: widget } = await readWidget(spaceId, widgetId);
  if (!widget) return null;
  const { data: html } = await readWidgetHtml(spaceId, widgetId);
  if (html == null) return null;
  const [htmlBytes, widgetYamlBytes] = await Promise.all([
    readBoundedRegularFileBytes(
      getWidgetContentPath(spaceId, widgetId),
      DOCUMENT_GENERATION_MAX_ENTRY_BYTES
    ),
    readBoundedRegularFileBytes(
      getWidgetPath(spaceId, widgetId),
      DOCUMENT_GENERATION_MAX_ENTRY_BYTES
    ),
  ]);
  return {
    html,
    widget: versionableWidget(widget),
    authoredSource: { htmlBytes, widgetYamlBytes },
  };
}

/**
 * Best-effort capture for the create-as-upsert paths. An explicit-id create can
 * target a widget whose widget.yaml is corrupt but whose index.html still holds
 * unversioned edits; captureWidgetVersionContent returns null there (it needs
 * parsed metadata), so the overwrite would record a create with no `before` and
 * the prior HTML would be unrestorable. Now that corrupt metadata is a supported
 * recovery state, snapshot the raw HTML with placeholder metadata (the corrupt
 * widget.yaml is unrecoverable; the HTML is what restore needs). Returns null
 * only when there is genuinely no prior HTML to preserve.
 */
export async function captureWidgetContentForOverwrite(
  spaceId: string,
  widgetId: string
): Promise<WidgetVersionContent | null> {
  const parsed = await captureWidgetVersionContent(spaceId, widgetId);
  if (parsed) return parsed;
  const { data: html } = await readWidgetHtml(spaceId, widgetId);
  if (html == null) return null;
  return {
    html,
    widget: {
      name: widgetId.split("/").pop() ?? widgetId,
      permissions: WidgetPermissionsSchema.parse({}),
      metadata: {},
      runtime: { type: "html", entry: "index.html" },
    },
  };
}

// ---- widgets.meta.json (provenance sidecar, mirrors docs.meta.json) ---------

interface WidgetMetaFile {
  version: 1;
  widgets: Record<string, { provenance?: DocProvenance }>;
}

function widgetMetaPath(spaceId: string): string {
  return join(getSpacesBaseDir(), spaceId, "widgets.meta.json");
}

async function readWidgetMetaFile(spaceId: string): Promise<WidgetMetaFile> {
  const path = widgetMetaPath(spaceId);
  if (!existsSync(path)) return { version: 1, widgets: {} };
  try {
    const parsed = JSON.parse(await Bun.file(path).text()) as WidgetMetaFile;
    // typeof null === "object": a hand-edited or partially written sidecar
    // like {"widgets": null} must fall back, not crash every later write.
    if (parsed?.version !== 1 || typeof parsed.widgets !== "object" || parsed.widgets === null || Array.isArray(parsed.widgets)) {
      return { version: 1, widgets: {} };
    }
    return parsed;
  } catch {
    return { version: 1, widgets: {} };
  }
}

export async function getWidgetProvenance(spaceId: string, widgetId: string): Promise<DocProvenance | undefined> {
  if (await usesHtmlDocumentStorageV2()) {
    const owner = await resolveHtmlDocumentStorageV2(spaceId, widgetId);
    if (!owner || owner.identity !== "durable") return undefined;
    const generations = await listDocumentGenerationsV2({
      workspaceRoot: getWorkspaceRoot(),
      spaceId,
      documentId: owner.documentId,
    });
    return generations.find((generation) => generation.provenance)?.provenance;
  }
  const meta = await readWidgetMetaFile(spaceId);
  const provenance = meta.widgets[widgetId]?.provenance;
  // The sidecar is hand-editable; a malformed entry must read as "no
  // provenance" instead of leaking non-strings into sourceCategory and
  // version records downstream.
  if (
    !provenance ||
    typeof provenance.updatedAt !== "string" ||
    typeof provenance.updatedBy !== "string" ||
    typeof provenance.source !== "string" ||
    typeof provenance.versionId !== "string" ||
    typeof provenance.contentHash !== "string"
  ) {
    return undefined;
  }
  return provenance;
}

async function updateWidgetProvenance(spaceId: string, widgetId: string, provenance: DocProvenance): Promise<void> {
  if (await usesHtmlDocumentStorageV2()) return;
  const path = widgetMetaPath(spaceId);
  await withStoreWriteLock(path, async () => {
    const meta = await readWidgetMetaFile(spaceId);
    meta.widgets[widgetId] = { ...(meta.widgets[widgetId] ?? {}), provenance };
    await atomicWriteText(path, JSON.stringify(meta, null, 2));
  });
}

/**
 * Move a deleted widget's version directory aside (versions/.../<id> →
 * <id>.deleted-<ts>). History stays on disk for manual recovery — matching the
 * delete-leaves-history contract — but a later widget REUSING the id starts
 * with a clean slate instead of inheriting a stranger's snapshots.
 */
export async function retireWidgetVersionHistory(spaceId: string, widgetId: string): Promise<void> {
  if (await usesHtmlDocumentStorageV2()) return;
  const dir = versionKeyDir(spaceId, "widgets", widgetId);
  if (!existsSync(dir)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const { rename } = await import("node:fs/promises");
  await rename(dir, `${dir}.deleted-${stamp}`).catch((err) => {
    console.error("[widget-versions] failed to retire version history:", err);
  });
}

export async function deleteWidgetProvenance(spaceId: string, widgetId: string): Promise<void> {
  if (await usesHtmlDocumentStorageV2()) return;
  const path = widgetMetaPath(spaceId);
  await withStoreWriteLock(path, async () => {
    const meta = await readWidgetMetaFile(spaceId);
    if (!(widgetId in meta.widgets)) return;
    delete meta.widgets[widgetId];
    await atomicWriteText(path, JSON.stringify(meta, null, 2));
  });
}

// ---- Recording ----------------------------------------------------------------

/**
 * Record a version for the widget's CURRENT on-disk state. `before` is the
 * content captured via captureWidgetVersionContent before the write (null on
 * create). Mirrors recordDocVersion: hash dedup unless forced, provenance in
 * widgets.meta.json, and marking the previous version a meaningful checkpoint
 * when the source category transitions (human ↔ agent ↔ external ↔ restore).
 */
export async function recordWidgetVersion(
  spaceId: string,
  widgetId: string,
  before: WidgetVersionContent | null,
  context?: WidgetVersionContext,
  opts?: {
    force?: boolean;
    operation?: "create" | "update" | "checkpoint";
    checkpoint?: VersionCheckpoint;
    documentId?: DocumentId;
    /** Exact result of a creation whose inventory claim is not published yet. */
    afterContent?: WidgetVersionContent;
  }
): Promise<DocProvenance | undefined> {
  const after = opts?.afterContent ?? await captureWidgetVersionContent(spaceId, widgetId);
  if (!after) return undefined;

  const previousProvenance = await getWidgetProvenance(spaceId, widgetId);
  const beforeHash = before ? widgetContentHash(before) : null;
  const afterHash = widgetContentHash(after);
  if (!opts?.force && beforeHash && beforeHash === afterHash) return undefined;

  const currentCategory = sourceCategory(
    context?.source ?? "unknown",
    context?.updatedBy ?? "unknown"
  );
  const checkpoint = opts?.checkpoint ?? (context?.checkpoint
    ? {
        meaningful: true,
        kind: context.source === "version-restore" ? "restore" as const : "system" as const,
        label: context.checkpointLabel,
        sourceCategory: currentCategory,
      }
    : undefined);
  const {
    recordLegacyWidgetVersionV2,
    usesDocumentVersionStoreV2,
  } = await import("./document-version-compatibility-v2.ts");
  if (await usesDocumentVersionStoreV2()) {
    const provenance = await recordLegacyWidgetVersionV2({
      spaceId,
      path: widgetId,
      before,
      after,
      updatedBy: context?.updatedBy ?? "unknown",
      source: context?.source ?? "unknown",
      ...(context?.reason ? { reason: context.reason } : {}),
      options: {
        ...opts,
        ...(checkpoint ? { checkpoint } : {}),
      },
      contentHash: afterHash,
      baselineRequired: Boolean(
        beforeHash && previousProvenance?.contentHash !== beforeHash
      ),
      previousProvenance,
    });
    if (provenance) {
      await updateWidgetProvenance(spaceId, widgetId, provenance);
    }
    return provenance;
  }

  // A pre-tracking widget's original content would otherwise only exist in the
  // first tracked version's `before` — but restore reads `after`, so the
  // original could never be rolled back to. Seed it as its own restorable
  // baseline snapshot, dated just before the update so it sorts as history.
  if (!previousProvenance && before && beforeHash && beforeHash !== afterHash) {
    const baselineAt = new Date(Date.now() - 1000).toISOString();
    const baseline: WidgetVersionSnapshot = {
      type: "worktable.widget-version",
      version: 1,
      id: mintVersionId(baselineAt),
      spaceId,
      widgetId,
      operation: "create",
      createdAt: baselineAt,
      createdBy: "system",
      source: "filesystem",
      checkpoint: {
        meaningful: true,
        kind: "system",
        label: "Pre-tracking baseline",
        sourceCategory: "external",
      },
      before: null,
      after: {
        format: "html",
        storedAs: "html",
        contentHash: beforeHash,
        content: semanticWidgetContent(before),
      },
    };
    await writeVersionSnapshot(spaceId, "widgets", widgetId, baseline);
  }

  const now = new Date().toISOString();
  const versionId = mintVersionId(now);
  const provenance: DocProvenance = {
    updatedAt: now,
    updatedBy: context?.updatedBy ?? "unknown",
    source: context?.source ?? "unknown",
    versionId,
    contentHash: afterHash,
  };

  const snapshot: WidgetVersionSnapshot = {
    type: "worktable.widget-version",
    version: 1,
    id: versionId,
    spaceId,
    widgetId,
    operation: opts?.operation ?? (before === null ? "create" : "update"),
    createdAt: now,
    createdBy: provenance.updatedBy,
    source: provenance.source,
    reason: context?.reason,
    checkpoint,
    before: before === null ? null : {
      format: "html",
      storedAs: "html",
      contentHash: beforeHash,
      content: semanticWidgetContent(before),
    },
    after: {
      format: "html",
      storedAs: "html",
      contentHash: afterHash,
      content: semanticWidgetContent(after),
    },
  };

  await writeVersionSnapshot(spaceId, "widgets", widgetId, snapshot);

  if (previousProvenance && previousProvenance.contentHash !== afterHash) {
    const previousCategory = sourceCategory(previousProvenance.source, previousProvenance.updatedBy);
    if (previousCategory !== currentCategory) {
      await markVersionCheckpoint(spaceId, "widgets", widgetId, previousProvenance.versionId, {
        meaningful: true,
        kind: previousCategory === "restore" || currentCategory === "restore" ? "restore" : "source-transition",
        label: automaticCheckpointLabel(previousCategory, currentCategory),
        sourceCategory: previousCategory,
        transition: { from: previousCategory, to: currentCategory },
      });
    }
  }

  await updateWidgetProvenance(spaceId, widgetId, provenance);
  await pruneNonCheckpointVersions(spaceId, "widgets", widgetId, NON_CHECKPOINT_VERSIONS_KEPT);
  return provenance;
}

/**
 * Version an external (filesystem) widget edit. Dedups by content hash against
 * the recorded provenance, so watcher echo of our own writes records nothing.
 * A single logical save touches widget.yaml AND index.html (two watcher
 * events); callers coalesce per widget id before invoking (see index.ts).
 */
export async function recordExternalWidgetChange(
  spaceId: string,
  widgetId: string,
  context?: WidgetVersionContext
): Promise<DocProvenance | undefined> {
  if (await usesHtmlDocumentStorageV2()) {
    return withDocPathLock(spaceId, () =>
      withWidgetWriteLock(spaceId, widgetId, () =>
        recordExternalWidgetChangeLocked(spaceId, widgetId, context)
      )
    );
  }
  return recordExternalWidgetChangeLocked(spaceId, widgetId, context);
}

/**
 * Lifecycle transactions already own the namespace and narrower locks; startup
 * recovery runs while workspace writes are unavailable. Do not reacquire them.
 */
export async function recordExternalWidgetChangeLocked(
  spaceId: string,
  widgetId: string,
  context?: WidgetVersionContext
): Promise<DocProvenance | undefined> {
  if (await usesHtmlDocumentStorageV2()) {
    const sourcePath = join(getSpacesBaseDir(), spaceId, "docs", `${widgetId}.html`);
    const { lstat } = await import("node:fs/promises");
    let missing = false;
    try {
      await lstat(sourcePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      missing = true;
    }
    if (missing) {
      // A completed delete reconciles here too. Its owner is already retired;
      // starting another lifecycle transaction would reacquire its lock.
      const inventory = await readDocumentInventory(spaceId);
      if ([...inventory.entries.values()].some((entry) =>
        entry.path === widgetId &&
        entry.format.id === "worktable.html" &&
        entry.source.kind === "file" &&
        entry.source.relativePath === `docs/${widgetId}.html`
      )) {
        const { deleteDurableDocExactlyLocked } = await import("./document-lifecycle-journal.ts");
        const result = await deleteDurableDocExactlyLocked(spaceId, widgetId);
        if (result.error) throw new Error(result.error);
      }
      return undefined;
    }
    await materializeHtmlDocumentStorageV2(spaceId, widgetId);
    await rebindHtmlDocumentSourceV2({ spaceId, path: widgetId });
  }
  const current = await captureWidgetVersionContent(spaceId, widgetId);
  if (!current) {
    // captureWidgetVersionContent returns null if EITHER widget.yaml or
    // index.html is missing/unreadable. Only treat this as a genuine external
    // delete when the widget DIRECTORY itself is gone. A missing/corrupt
    // widget.yaml (or a transient index.html loss) with the directory intact is
    // the recovery scenario the version UI exists for — retiring history there
    // would erase authored content that is still on disk. On a real delete,
    // retire history + drop provenance so a reused id starts clean and the
    // sidecar has no dangling entry.
    if (!existsSync(join(getSpacesBaseDir(), spaceId, "widgets", widgetId))) {
      await deleteWidgetProvenance(spaceId, widgetId);
      await retireWidgetVersionHistory(spaceId, widgetId);
      // Cascade like the REST/MCP delete paths: an externally deleted HTML doc
      // must not leave a dangling annotations/widgets/<id>.annotations.json.
      await deleteAnnotationWidgetId(spaceId, widgetId);
    }
    return undefined;
  }
  const previous = await getWidgetProvenance(spaceId, widgetId);
  if (previous?.contentHash === widgetContentHash(current)) return undefined;
  // Reconstruct `before` from the last recorded version's `after` (the pre-edit
  // disk state) so edits on an already-versioned widget record as proper
  // updates rather than before-less creates. An upgraded widget with no prior
  // provenance has no recoverable pre-edit state (the edit already overwrote
  // it), so before stays null and the edit records as the first tracked
  // version — the same shape a REST create produces for such a widget.
  let before: WidgetVersionContent | null = null;
  if (previous?.versionId) {
    const lastVersion = await getWidgetVersion(
      spaceId,
      widgetId,
      previous.versionId
    );
    before = lastVersion?.after.content ?? null;
  }
  return recordWidgetVersion(spaceId, widgetId, before, {
    updatedBy: context?.updatedBy ?? "external",
    source: context?.source ?? "filesystem",
    reason: context?.reason ?? "Detected by file watcher",
  });
}

// ---- Reads ----------------------------------------------------------------------

export async function listWidgetVersions(
  spaceId: string,
  widgetId: string,
  opts?: { checkpointsOnly?: boolean }
): Promise<VersionEntry[]> {
  const {
    listLegacyWidgetVersionsV2,
    usesDocumentVersionStoreV2,
  } = await import("./document-version-compatibility-v2.ts");
  if (await usesDocumentVersionStoreV2()) {
    return listLegacyWidgetVersionsV2(spaceId, widgetId, opts);
  }
  return listVersionEntries(spaceId, "widgets", widgetId, opts);
}

export async function getWidgetVersion(
  spaceId: string,
  widgetId: string,
  versionId: string
): Promise<WidgetVersionSnapshot | null> {
  const {
    readLegacyWidgetVersionV2,
    usesDocumentVersionStoreV2,
  } = await import("./document-version-compatibility-v2.ts");
  if (await usesDocumentVersionStoreV2()) {
    return (await readLegacyWidgetVersionV2(
      spaceId,
      widgetId,
      versionId
    )) as WidgetVersionSnapshot | null;
  }
  return readVersionSnapshot<WidgetVersionSnapshot>(spaceId, "widgets", widgetId, versionId);
}
