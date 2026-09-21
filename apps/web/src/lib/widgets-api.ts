import type { DocFreshness, WidgetFile } from "@worktable/types";
import type { DocVersionCheckpoint, DocVersionEntry } from "./docs-api.ts";
import {
  authenticatedFetch,
  BASE_URL,
  fetchJSON,
  redirectToLogin,
  UnauthorizedError,
} from "./http.ts";
import { htmlDocumentApiPath } from "./html-document-api-path.ts";

/**
 * A widget list entry decorated with derived freshness — the client mirror of
 * the server's `WidgetListEntry` (packages/server/src/widget-freshness.ts). The
 * single-widget REST read (GET /:widgetId) does NOT carry freshness; only list
 * surfaces (REST GET /widgets, the space-detail embed, MCP) do.
 */
export type WidgetListEntry = WidgetFile & { freshness?: DocFreshness };

// ── Version history types ───────────────────────────────────
// The server mirrors doc version history for HTML docs (widgets), so the list
// entries are DocVersionEntry-shaped. The only widget-specific difference is
// the snapshot content: a rendered widget bundle rather than doc content.

export type WidgetVersionCheckpoint = DocVersionCheckpoint;
export type WidgetVersionEntry = DocVersionEntry;

export interface WidgetVersionContent {
  html: string;
  widget: {
    name?: string;
    description?: string;
    permissions?: unknown;
    metadata?: Record<string, unknown>;
    runtime?: unknown;
  };
}

export interface WidgetVersionSnapshot extends WidgetVersionEntry {
  after: { format: string | null; storedAs: string; contentHash: string; content: WidgetVersionContent };
}

export function listWidgets(spaceId: string, opts?: { includeArchived?: boolean }) {
  const params = new URLSearchParams();
  if (opts?.includeArchived !== undefined) params.set("includeArchived", String(opts.includeArchived));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return fetchJSON<{ widgets: WidgetListEntry[] }>(`/api/spaces/${spaceId}/widgets${suffix}`).then((r) => r.widgets);
}

export type WidgetProvenance = { updatedAt: string; updatedBy: string; source: string; versionId: string; contentHash: string };

export type WidgetRead = WidgetFile & { provenance?: WidgetProvenance };

export function getWidget(spaceId: string, widgetId: string): Promise<WidgetRead> {
  return fetchJSON<{ widget: WidgetFile; provenance?: WidgetProvenance }>(
    htmlDocumentApiPath(spaceId, widgetId)
  ).then((r) => ({ ...r.widget, ...(r.provenance ? { provenance: r.provenance } : {}) }));
}

export function createWidget(spaceId: string, data: { id?: string; name: string; description?: string; html: string; metadata?: Record<string, unknown> }) {
  return fetchJSON<{ widget: WidgetFile; widgetId: string }>(`/api/spaces/${spaceId}/widgets`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function patchWidget(spaceId: string, widgetId: string, data: { name?: string; description?: string | null; metadata?: Record<string, unknown> }) {
  return fetchJSON<{ widget: WidgetFile }>(
    htmlDocumentApiPath(spaceId, widgetId), {
    method: "PATCH",
    body: JSON.stringify(data),
  }).then((r) => r.widget);
}

export function moveWidget(spaceId: string, widgetId: string, newPath: string) {
  return fetchJSON<{
    ok: true;
    from: string;
    to: string;
    documentId: string;
  }>(`${htmlDocumentApiPath(spaceId, widgetId)}/move`, {
    method: "POST",
    body: JSON.stringify({ newPath }),
  });
}

export function archiveWidget(spaceId: string, widgetId: string, reason?: string) {
  return fetchJSON<{ ok: boolean; widget: WidgetFile }>(`${htmlDocumentApiPath(spaceId, widgetId)}/archive`, {
    method: "POST",
    body: JSON.stringify(reason ? { reason } : {}),
  });
}

export function restoreWidget(spaceId: string, widgetId: string) {
  return fetchJSON<{ ok: boolean; widget: WidgetFile }>(`${htmlDocumentApiPath(spaceId, widgetId)}/restore`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function deleteWidget(spaceId: string, widgetId: string) {
  return fetchJSON<{ ok: boolean }>(htmlDocumentApiPath(spaceId, widgetId), {
    method: "DELETE",
  });
}

// ── Record a human review checkpoint ────────────────────────
// REST-only on the server by design (mirrors reviewDoc): review is the human
// trust anchor and is never exposed over MCP, so an agent can't launder its own
// output into "reviewed".
export function reviewWidget(
  spaceId: string,
  widgetId: string
): Promise<{ ok: boolean; provenance?: unknown; freshness?: DocFreshness }> {
  return fetchJSON(`${htmlDocumentApiPath(spaceId, widgetId)}/review`, {
    method: "POST",
  });
}

export function widgetContentUrl(spaceId: string, widgetId: string) {
  return `${BASE_URL}${htmlDocumentApiPath(spaceId, widgetId)}/content`;
}

// ── Version history ─────────────────────────────────────────
// Mirrors docs-api's version fns. Widget ids may contain slashes and
// interpolate into the path as-is (same as everywhere else); version ids are
// encoded like docs-api does.

export function listWidgetVersions(
  spaceId: string,
  widgetId: string,
  all = false
): Promise<WidgetVersionEntry[]> {
  return fetchJSON<{ versions: WidgetVersionEntry[] }>(
    `${htmlDocumentApiPath(spaceId, widgetId)}/versions${all ? "?all=true" : ""}`
  ).then((r) => r.versions);
}

export function readWidgetVersion(
  spaceId: string,
  widgetId: string,
  versionId: string
): Promise<WidgetVersionSnapshot> {
  return fetchJSON<{ version: WidgetVersionSnapshot }>(
    `${htmlDocumentApiPath(spaceId, widgetId)}/versions/${encodeURIComponent(versionId)}`
  ).then((r) => r.version);
}

export function createWidgetCheckpoint(
  spaceId: string,
  widgetId: string,
  label?: string
): Promise<{ ok: boolean; provenance?: unknown }> {
  return fetchJSON(`${htmlDocumentApiPath(spaceId, widgetId)}/versions/checkpoint`, {
    method: "POST",
    body: JSON.stringify({ label }),
  });
}

export function restoreWidgetVersion(
  spaceId: string,
  widgetId: string,
  versionId: string
): Promise<{ ok: boolean; widget: WidgetFile; provenance?: unknown }> {
  return fetchJSON(
    `${htmlDocumentApiPath(spaceId, widgetId)}/versions/${encodeURIComponent(versionId)}/restore`,
    { method: "POST" }
  );
}

/**
 * URL for a version snapshot's RENDERED HTML (theme-applied, sandbox-safe, no
 * runtime bridge) — used directly as an iframe src for compare. Mirrors
 * widgetContentUrl; append `?theme=light|dark` at the call site.
 */
export function widgetVersionContentUrl(spaceId: string, widgetId: string, versionId: string) {
  return `${BASE_URL}${htmlDocumentApiPath(spaceId, widgetId)}/versions/${encodeURIComponent(versionId)}/content`;
}

/**
 * Fetch a widget's raw authored HTML source (the `?format=raw` variant of the
 * content endpoint). Returns text rather than JSON. Widget ids may contain
 * slashes; they interpolate into the path as-is, same as everywhere else.
 */
export async function exportWidgetHtml(spaceId: string, widgetId: string): Promise<string> {
  const res = await authenticatedFetch(`${widgetContentUrl(spaceId, widgetId)}?format=raw`);
  if (res.status === 401) {
    redirectToLogin();
    throw new UnauthorizedError();
  }
  if (!res.ok) {
    throw new Error(`Failed to export widget HTML: HTTP ${res.status}`);
  }
  return res.text();
}
