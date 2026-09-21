import { existsSync } from "node:fs";
import { mkdir, readdir, rmdir } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import {
  CanonicalIdSchema,
  WidgetFileSchema,
  WidgetIdSchema,
  type DocumentId,
  type WidgetFile,
} from "@worktable/types";
import { atomicWriteText, ensureSpaceDirectories, getSpacesBaseDir, suppressPath, unsuppressPath, withStoreWriteLock, withStoreWriteLocks } from "./store.ts";
import { parseCanonicalYaml, stringifyCanonicalYaml } from "./yaml.ts";
import { invalidateHostedDocumentShares } from "./share-lifecycle.ts";
import {
  createDocAliasReservationLookup,
  readDocAliases,
} from "./doc-aliases.ts";
import {
  listHtmlDocumentsStorageV2,
  isHtmlDocumentPath,
  parseHtmlDocumentWidgetFile,
  readHtmlDocumentStorageV2,
  resolveHtmlDocumentStorageV2,
  usesHtmlDocumentStorageV2,
  writeHtmlDocumentPropertiesV2,
  writeHtmlDocumentStorageV2,
  type HtmlDocumentStorageV2Owner,
} from "./html-document-storage-v2.ts";
import { setRegisteredDocumentArchived } from "./document-write-service.ts";

function isCanonicalId(id: string): boolean {
  return CanonicalIdSchema.safeParse(id).success;
}

function isWidgetId(id: string): boolean {
  return WidgetIdSchema.safeParse(id).success;
}

function invalidIdError(kind: string, id: string): string {
  return `Invalid ${kind} id: ${id}`;
}

function spaceDir(spaceId: string): string {
  return join(getSpacesBaseDir(), spaceId);
}

function widgetsDir(spaceId: string): string {
  return join(spaceDir(spaceId), "widgets");
}

function widgetDir(spaceId: string, widgetId: string): string {
  return join(widgetsDir(spaceId), widgetId);
}

function widgetPath(spaceId: string, widgetId: string): string {
  return join(widgetDir(spaceId, widgetId), "widget.yaml");
}

// Serialize the full capture→write→record sequence per widget id. writeWidget
// and recordWidgetVersion each lock individual files, but two concurrent writes
// to the SAME widget can still interleave across those file boundaries — leaving
// a mixed yaml/html on disk AND letting the post-write version snapshot capture
// one writer's metadata with another's HTML. Callers that write a widget and
// record its version wrap both in this lock. Keyed on the widget directory,
// distinct from the per-file keys the inner writes use, so it never
// self-deadlocks.
export function withWidgetWriteLock<T>(spaceId: string, widgetId: string, fn: () => Promise<T>): Promise<T> {
  return withStoreWriteLock(`widget-txn:${widgetDir(spaceId, widgetId)}`, fn);
}

/** Acquire several widget transaction locks in canonical order. */
export function withWidgetWriteLocks<T>(spaceId: string, widgetIds: string[], fn: () => Promise<T>): Promise<T> {
  return withStoreWriteLocks(
    widgetIds.map((widgetId) => `widget-txn:${widgetDir(spaceId, widgetId)}`),
    fn
  );
}

/**
 * Serialize mutations that can change the widget leaf/folder topology.
 *
 * Acquire this after the common document namespace lock and before any widget
 * transaction lock. Ordinary updates to an existing widget do not need it.
 */
export function withWidgetTopologyLock<T>(spaceId: string, fn: () => Promise<T>): Promise<T> {
  return withStoreWriteLock(`widget-topology:${widgetsDir(spaceId)}`, fn);
}

function widgetContentPath(spaceId: string, widgetId: string): string {
  return join(widgetDir(spaceId, widgetId), "index.html");
}

export function getWidgetPath(spaceId: string, widgetId: string): string {
  return widgetPath(spaceId, widgetId);
}

export function getWidgetContentPath(spaceId: string, widgetId: string): string {
  return widgetContentPath(spaceId, widgetId);
}

async function ensureWidgetDirs(spaceId: string, widgetId?: string): Promise<void> {
  await ensureSpaceDirectories(spaceId);
  await mkdir(widgetId ? widgetDir(spaceId, widgetId) : widgetsDir(spaceId), { recursive: true });
}

async function readYamlFile(path: string): Promise<unknown> {
  return parseCanonicalYaml(await Bun.file(path).text());
}

// Version-recording callers snapshot the widget AFTER the write returns, so the
// watcher echo of our own write must stay suppressed until that record has
// written provenance — otherwise a late fs event (delivered after a fixed
// window) mints a duplicate "filesystem" version before the caller's
// recordWidgetVersion runs. holdSuppression suppresses the paths and hands the
// caller an explicit release to call once provenance is recorded. A safety
// timeout guarantees a caller that never records (seed) or throws before
// releasing can never suppress the watcher forever — the only cost of the
// fallback is delayed external-edit detection for this one widget.
const WIDGET_SUPPRESS_SAFETY_MS = 5000;

function holdSuppression(paths: string[]): () => void {
  for (const p of paths) suppressPath(p);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(safety);
    for (const p of paths) unsuppressPath(p);
  };
  const safety = setTimeout(release, WIDGET_SUPPRESS_SAFETY_MS);
  return release;
}

async function writeTextFile(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await withStoreWriteLock(path, () => atomicWriteText(path, value));
}

// A directory under widgets/ is a widget iff it contains widget.yaml; any other
// directory is an implicit folder. Widget directories are leaves — the walk never
// descends past a widget.yaml, and writeWidget refuses ids that would nest a
// widget inside another (see the leaf-only guards there).
export async function listWidgets(
  spaceId: string,
  opts: {
    includeArchived?: boolean;
    /** Internal topology callers may need every physical bundle for slugging. */
    includeAliasShadows?: boolean;
  } = {}
): Promise<WidgetFile[]> {
  if (!isCanonicalId(spaceId)) return [];
  if (await usesHtmlDocumentStorageV2()) {
    return listHtmlDocumentsStorageV2({
      spaceId,
      includeArchived: opts.includeArchived,
      includeAliasShadows: opts.includeAliasShadows,
    })
  }
  const base = widgetsDir(spaceId);
  if (!existsSync(base)) return [];
  const aliases = opts.includeAliasShadows
    ? null
    : (await readDocAliases(spaceId)).aliases;
  // Corrupt or ambiguous portable aliases cannot safely establish which
  // physical HTML bundle owns a public path. Hide the specialized list for
  // this Space instead of advertising entries its reads may not open.
  if (!opts.includeAliasShadows && !aliases) return [];
  const aliasReservation = aliases
    ? createDocAliasReservationLookup(aliases)
    : null;
  const widgets: WidgetFile[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = prefix ? `${prefix}/${entry.name}` : entry.name;
      const childDir = join(dir, entry.name);
      if (existsSync(join(childDir, "widget.yaml"))) {
        if (aliasReservation?.(id)) continue;
        const result = await readWidget(spaceId, id);
        if (!result.data) continue;
        if (!opts.includeArchived && result.data.archive) continue;
        widgets.push(result.data);
        continue;
      }
      await walk(childDir, id);
    }
  };
  await walk(base, "");
  return widgets.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readWidget(spaceId: string, widgetId: string): Promise<{ data: WidgetFile | null; error: string | null }> {
  if (!isCanonicalId(spaceId)) return { data: null, error: invalidIdError("space", spaceId) };
  const storageV2 = await usesHtmlDocumentStorageV2();
  if (storageV2 ? !isHtmlDocumentPath(widgetId) : !isWidgetId(widgetId)) {
    return { data: null, error: invalidIdError("widget", widgetId) };
  }
  if (storageV2) {
    try {
      const document = await readHtmlDocumentStorageV2({
        spaceId,
        path: widgetId,
      });
      return document
        ? { data: document.widget, error: null }
        : { data: null, error: `Widget not found: ${widgetId}` };
    } catch (error) {
      return {
        data: null,
        error: `Failed to read widget: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }
  const path = widgetPath(spaceId, widgetId);
  if (!existsSync(path)) return { data: null, error: `Widget not found: ${widgetId}` };
  try {
    return { data: WidgetFileSchema.parse(await readYamlFile(path)), error: null };
  } catch (error) {
    return { data: null, error: `Failed to parse widget: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Read authored HTML and its source-bound permissions as one V2 snapshot. */
export async function readWidgetDocument(
  spaceId: string,
  widgetId: string
): Promise<{
  data: { widget: WidgetFile; html: string } | null;
  error: string | null;
}> {
  if (!isCanonicalId(spaceId))
    return { data: null, error: invalidIdError("space", spaceId) };
  if (await usesHtmlDocumentStorageV2()) {
    if (!isHtmlDocumentPath(widgetId))
      return { data: null, error: invalidIdError("widget", widgetId) };
    try {
      const document = await readHtmlDocumentStorageV2({
        spaceId,
        path: widgetId,
      });
      return document
        ? {
            data: { widget: document.widget, html: document.html },
            error: null,
          }
        : { data: null, error: `Widget not found: ${widgetId}` };
    } catch (error) {
      return {
        data: null,
        error: `Failed to read widget: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  const [widget, html] = await Promise.all([
    readWidget(spaceId, widgetId),
    readWidgetHtml(spaceId, widgetId),
  ]);
  return widget.data && html.data !== null
    ? { data: { widget: widget.data, html: html.data }, error: null }
    : { data: null, error: widget.error ?? html.error };
}

export async function readWidgetHtml(spaceId: string, widgetId: string): Promise<{ data: string | null; error: string | null }> {
  if (!isCanonicalId(spaceId)) return { data: null, error: invalidIdError("space", spaceId) };
  const storageV2 = await usesHtmlDocumentStorageV2();
  if (storageV2 ? !isHtmlDocumentPath(widgetId) : !isWidgetId(widgetId)) {
    return { data: null, error: invalidIdError("widget", widgetId) };
  }
  if (storageV2) {
    try {
      const document = await readHtmlDocumentStorageV2({
        spaceId,
        path: widgetId,
      });
      return document
        ? { data: document.html, error: null }
        : { data: null, error: `Widget content not found: ${widgetId}` };
    } catch (error) {
      return {
        data: null,
        error: `Failed to read widget content: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }
  const path = widgetContentPath(spaceId, widgetId);
  if (!existsSync(path)) return { data: null, error: `Widget content not found: ${widgetId}` };
  return { data: await Bun.file(path).text(), error: null };
}

// The slug pool for auto-derived widget ids: every existing id PLUS every
// folder prefix those ids occupy. Without the prefixes, creating "Plans" while
// widget `plans/q3` exists would derive `plans`, which writeWidget then rejects
// (a folder containing widgets can't also be a widget) — dedup to `plans-2`
// instead of failing the create.
export function widgetIdDedupePool(existing: Array<{ id: string }>): string[] {
  const pool = new Set<string>();
  for (const widget of existing) {
    pool.add(widget.id);
    const segments = widget.id.split("/");
    for (let i = 1; i < segments.length; i++) {
      pool.add(segments.slice(0, i).join("/"));
    }
  }
  return [...pool];
}

async function containsWidget(dir: string): Promise<boolean> {
  if (existsSync(join(dir, "widget.yaml"))) return true;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory() && (await containsWidget(join(dir, entry.name)))) return true;
  }
  return false;
}

export async function writeWidget(
  spaceId: string,
  widget: WidgetFile,
  html: string,
  options?: { documentId?: DocumentId }
): Promise<{ data: WidgetFile | null; error: string | null; release?: () => void }> {
  if (!isCanonicalId(spaceId)) return { data: null, error: invalidIdError("space", spaceId) };
  const storageV2 = await usesHtmlDocumentStorageV2();
  let parsedWidget: WidgetFile;
  try {
    parsedWidget = storageV2
      ? parseHtmlDocumentWidgetFile(widget, widget.id)
      : WidgetFileSchema.parse(widget);
  } catch (error) {
    return {
      data: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (storageV2) {
    const existing = await resolveHtmlDocumentStorageV2(spaceId, parsedWidget.id);
    const owner: HtmlDocumentStorageV2Owner | null =
      existing ??
      (options?.documentId
        ? {
            documentId: options.documentId,
            identity: "durable",
            path: parsedWidget.id,
            sourceRelativePath: `docs/${parsedWidget.id}.html`,
            title: parsedWidget.name,
            updatedAt: parsedWidget.updatedAt,
            archived: false,
          }
        : null);
    if (!owner) {
      return {
        data: null,
        error: `HTML document requires a stable ID before mutation: ${parsedWidget.id}`,
      };
    }
    const htmlPath = join(spaceDir(spaceId), owner.sourceRelativePath);
    const release = holdSuppression([htmlPath]);
    try {
      await writeHtmlDocumentStorageV2({
        spaceId,
        owner,
        widget: parsedWidget,
        html,
      });
    } catch (error) {
      release();
      throw error;
    }
    return { data: parsedWidget, error: null, release };
  }
  // Leaf-only nesting: a widget directory never contains another widget. Without
  // this, deleteWidget's recursive rm would silently destroy child widgets and
  // "is this dir a folder or a widget" becomes ambiguous.
  const segments = parsedWidget.id.split("/");
  for (let i = 1; i < segments.length; i++) {
    const prefix = segments.slice(0, i).join("/");
    if (existsSync(widgetPath(spaceId, prefix))) {
      return { data: null, error: `Widget id "${parsedWidget.id}" is nested under existing widget "${prefix}"; widgets cannot contain other widgets` };
    }
  }
  const dir = widgetDir(spaceId, parsedWidget.id);
  if (existsSync(dir) && !existsSync(widgetPath(spaceId, parsedWidget.id)) && (await containsWidget(dir))) {
    return { data: null, error: `Widget id "${parsedWidget.id}" is a folder that contains widgets; widgets cannot contain other widgets` };
  }
  await ensureWidgetDirs(spaceId, parsedWidget.id);
  // Suppress the watcher echo of this internal write, held until the caller has
  // recorded the version (see holdSuppression). The caller MUST invoke the
  // returned release once recordWidgetVersion resolves.
  const yamlPath = widgetPath(spaceId, parsedWidget.id);
  const htmlPath = widgetContentPath(spaceId, parsedWidget.id);
  const release = holdSuppression([yamlPath, htmlPath]);
  try {
    await writeTextFile(yamlPath, stringifyCanonicalYaml(parsedWidget));
    await writeTextFile(htmlPath, html);
  } catch (err) {
    release();
    throw err;
  }
  return { data: parsedWidget, error: null, release };
}

export async function updateWidgetMetadata(
  spaceId: string,
  widgetId: string,
  patch: {
    name?: string;
    description?: string | null;
    metadata?: Record<string, unknown>;
    updatedBy?: string;
    now?: string;
  }
): Promise<{ data: WidgetFile | null; error: string | null; release?: () => void }> {
  const { data: existing, error } = await readWidget(spaceId, widgetId);
  if (error || !existing) return { data: null, error: error ?? `Widget not found: ${widgetId}` };
  const next: WidgetFile = {
    ...existing,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.description !== undefined ? { description: patch.description ?? undefined } : {}),
    ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
    updatedAt: patch.now ?? new Date().toISOString(),
    updatedBy: patch.updatedBy ?? "user",
  };
  const storageV2 = await usesHtmlDocumentStorageV2();
  let parsedWidget: WidgetFile;
  try {
    parsedWidget = storageV2
      ? parseHtmlDocumentWidgetFile(next, widgetId)
      : WidgetFileSchema.parse(next);
  } catch (parseError) {
    return {
      data: null,
      error:
        parseError instanceof Error ? parseError.message : String(parseError),
    };
  }
  if (storageV2) {
    const owner = await resolveHtmlDocumentStorageV2(spaceId, widgetId);
    if (!owner) return { data: null, error: `Widget not found: ${widgetId}` };
    await writeHtmlDocumentPropertiesV2({
      spaceId,
      owner,
      widget: parsedWidget,
    });
    return { data: parsedWidget, error: null };
  }
  await ensureWidgetDirs(spaceId, widgetId);
  // Held suppression: handlePatchWidget records a version after this returns, so
  // it releases once provenance is written (same race as writeWidget).
  const path = widgetPath(spaceId, widgetId);
  const release = holdSuppression([path]);
  try {
    await writeTextFile(path, stringifyCanonicalYaml(parsedWidget));
  } catch (err) {
    release();
    throw err;
  }
  return { data: parsedWidget, error: null, release };
}

// Single-file metadata writes get the same echo suppression as writeWidget.
async function writeSuppressed(path: string, value: string): Promise<void> {
  suppressPath(path);
  try {
    await writeTextFile(path, value);
  } finally {
    setTimeout(() => unsuppressPath(path), 300);
  }
}

async function setWidgetArchivedUnderLock(
  spaceId: string,
  widgetId: string,
  archived: boolean,
  archivedBy = "user",
  reason?: string
): Promise<{ data: WidgetFile | null; error: string | null }> {
  const { data: existing, error } = await readWidget(spaceId, widgetId);
  if (error || !existing) return { data: null, error: error ?? `Widget not found: ${widgetId}` };
  const now = new Date().toISOString();
  const next: WidgetFile = {
    ...existing,
    archive: archived
      ? {
          archivedAt: now,
          archivedBy,
          ...(reason ? { reason } : {}),
        }
      : null,
    updatedAt: now,
    updatedBy: archivedBy,
  };
  const parsed = WidgetFileSchema.safeParse(next);
  if (!parsed.success) return { data: null, error: parsed.error.message };
  await writeSuppressed(widgetPath(spaceId, widgetId), stringifyCanonicalYaml(parsed.data));
  if (archived) {
    await invalidateHostedDocumentShares([
      { kind: "html", spaceId, artifactKey: widgetId },
    ]);
  }
  return { data: parsed.data, error: null };
}

export async function setWidgetArchived(
  spaceId: string,
  widgetId: string,
  archived: boolean,
  archivedBy = "user",
  reason?: string
): Promise<{ data: WidgetFile | null; error: string | null }> {
  if (!isCanonicalId(spaceId)) return { data: null, error: invalidIdError("space", spaceId) };
  const storageV2 = await usesHtmlDocumentStorageV2();
  if (storageV2 ? !isHtmlDocumentPath(widgetId) : !isWidgetId(widgetId)) {
    return { data: null, error: invalidIdError("widget", widgetId) };
  }
  if (storageV2) {
    try {
      await setRegisteredDocumentArchived({
        spaceId,
        path: widgetId,
        archived,
        archivedBy,
        ...(reason ? { reason } : {}),
      });
      const result = await readWidget(spaceId, widgetId);
      if (archived) {
        await invalidateHostedDocumentShares([
          { kind: "html", spaceId, artifactKey: widgetId },
        ]);
      }
      return result;
    } catch (error) {
      return {
        data: null,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
  // Archive metadata lives inside the bundle, so its read and write must stay
  // on one side of an exact bundle deletion.
  return withWidgetWriteLock(spaceId, widgetId, () =>
    setWidgetArchivedUnderLock(spaceId, widgetId, archived, archivedBy, reason)
  );
}

/** Remove only empty implicit folders left above a deleted nested widget. */
export async function pruneEmptyWidgetParents(spaceId: string, widgetId: string): Promise<void> {
  if (!isCanonicalId(spaceId) || !isWidgetId(widgetId)) return;
  const root = widgetsDir(spaceId);
  let parent = dirname(widgetDir(spaceId, widgetId));
  while (parent !== root && parent.startsWith(root + sep)) {
    try {
      // The atomic emptiness check belongs to the filesystem. A sibling can
      // appear under a different widget lock, so never recurse after a stale
      // userspace check.
      await rmdir(parent);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        parent = dirname(parent);
        continue;
      }
      if (code === "ENOTEMPTY" || code === "EEXIST") return;
      throw error;
    }
    parent = dirname(parent);
  }
}
