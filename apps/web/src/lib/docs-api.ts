import type { ArchiveInfo, DocFreshness, DocListEntry, ResolvedDocumentReference } from "@worktable/types";
import { fetchJSON } from "./http.ts";

/**
 * Docs REST API client.
 * All requests scoped to a spaceId: /api/spaces/:spaceId/docs/*
 */

// ── Types ───────────────────────────────────────────────────

export interface DocVersionCheckpoint {
  meaningful: boolean;
  kind: "manual" | "source-transition" | "restore" | "system";
  label?: string;
  sourceCategory: "human" | "agent" | "external" | "system" | "restore";
  transition?: { from: string; to: string };
}

export interface DocVersionEntry {
  id: string;
  createdAt: string;
  createdBy: string;
  source: string;
  reason?: string;
  operation: "create" | "update" | "checkpoint";
  checkpoint?: DocVersionCheckpoint;
  after: { format: string | null; storedAs: string; contentHash: string; content?: unknown };
}

export interface DocVersionSnapshot extends DocVersionEntry {
  type: "worktable.doc-version";
  version: 1;
  spaceId: string;
  docPath: string;
  before: unknown;
  after: { format: string | null; storedAs: string; contentHash: string; content: unknown };
}

export interface DocMeta {
  path: string;
  content: unknown[] | string;
  format: "blocknote" | "markdown";
  storedAs: "json" | "md";
  updatedAt: number;
  collaborationEpoch: string;
  collaborationCacheEpoch: string;
  collaborationCacheEpochHistory?: string[];
  markdownCompatible: boolean | null;
  archived?: ArchiveInfo;
  provenance?: {
    updatedAt: string;
    updatedBy: string;
    source: string;
    versionId: string;
    contentHash: string;
  };
  freshness?: DocFreshness;
}

/** Encode each segment of a doc path for safe use in URLs */
function encodeDocPath(docPath: string): string {
  return docPath
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

// ── List all doc paths in a space ───────────────────────────

export function listDocs(spaceId: string, includeArchived = true): Promise<DocListEntry[]> {
  return fetchJSON<{ docs: DocListEntry[] }>(
    `/api/spaces/${spaceId}/docs?includeArchived=${includeArchived ? "true" : "false"}`
  ).then((r) => r.docs);
}

const DOCUMENT_REFERENCE_BATCH_LIMIT = 500

export async function resolveDocumentReferences(spaceId: string, paths: unknown[]): Promise<ResolvedDocumentReference[]> {
  const chunks: unknown[][] = []
  for (let index = 0; index < paths.length; index += DOCUMENT_REFERENCE_BATCH_LIMIT) {
    chunks.push(paths.slice(index, index + DOCUMENT_REFERENCE_BATCH_LIMIT))
  }
  if (chunks.length === 0) return []

  const results = await Promise.all(
    chunks.map((chunk) =>
      fetchJSON<{ references: ResolvedDocumentReference[] }>(
        `/api/spaces/${spaceId}/docs/resolve-references`,
        { method: "POST", body: JSON.stringify({ paths: chunk }) }
      ).then((result) => result.references)
    )
  )
  return results.flat()
}

// ── Read a single doc ───────────────────────────────────────

export function readDoc(spaceId: string, docPath: string): Promise<DocMeta> {
  return fetchJSON<DocMeta>(
    `/api/spaces/${spaceId}/docs/${encodeDocPath(docPath)}?conversionCheck=skip`
  );
}

// ── Export a doc as markdown (server converts BlockNote docs) ──

export function exportDocMarkdown(
  spaceId: string,
  docPath: string
): Promise<string> {
  return fetchJSON<{ markdown: string }>(
    `/api/spaces/${spaceId}/docs/${encodeDocPath(docPath)}?format=markdown`
  ).then((r) => r.markdown);
}

// ── Download a doc as a .md file ────────────────────────────

/** Filename for a downloaded doc: the slug (last path segment) + ".md". */
export function docMarkdownFilename(docPath: string): string {
  const slug = docPath.split("/").filter(Boolean).at(-1);
  return `${slug || "doc"}.md`;
}

export async function downloadDocMarkdown(
  spaceId: string,
  docPath: string
): Promise<void> {
  const markdown = await exportDocMarkdown(spaceId, docPath);
  const url = URL.createObjectURL(
    new Blob([markdown], { type: "text/markdown;charset=utf-8" })
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = docMarkdownFilename(docPath);
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Deferred so the browser has started the download before the URL dies
  // (immediate revoke drops the download in Safari).
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ── Create a doc from a human title (server slugifies the path) ──

export function createDoc(
  spaceId: string,
  title: string,
  content?: unknown[]
): Promise<{ path: string; updatedAt: number; provenance?: DocMeta["provenance"] }> {
  return fetchJSON(`/api/spaces/${spaceId}/docs`, {
    method: "POST",
    body: JSON.stringify({ title, content }),
  });
}

// ── Write (create/update) a doc ─────────────────────────────

export function writeDoc(
  spaceId: string,
  docPath: string,
  content: unknown[]
): Promise<{ path: string; updatedAt: number; provenance?: DocMeta["provenance"] }> {
  return fetchJSON(`/api/spaces/${spaceId}/docs/${encodeDocPath(docPath)}`, {
    method: "PUT",
    body: JSON.stringify({ content }),
  });
}

// ── Delete a doc ────────────────────────────────────────────

export function deleteDoc(
  spaceId: string,
  docPath: string
): Promise<{ ok: boolean }> {
  return fetchJSON(`/api/spaces/${spaceId}/docs/${encodeDocPath(docPath)}`, {
    method: "DELETE",
  });
}

// ── Convert a markdown doc to BlockNote ─────────────────────

export function convertDoc(
  spaceId: string,
  docPath: string
): Promise<{ ok: boolean; path: string; blockCount: number; updatedAt: number }> {
  return fetchJSON(`/api/spaces/${spaceId}/docs/${encodeDocPath(docPath)}/convert`, {
    method: "POST",
  });
}

export function convertDocToMarkdown(
  spaceId: string,
  docPath: string
): Promise<{ ok: boolean; path: string; updatedAt: number }> {
  return fetchJSON(
    `/api/spaces/${spaceId}/docs/${encodeDocPath(docPath)}/convert-to-markdown`,
    { method: "POST" }
  );
}

// ── Rename a doc ────────────────────────────────────────────

export function renameDoc(
  spaceId: string,
  docPath: string,
  newPath: string,
  scope?: "document" | "folder"
): Promise<{ ok: boolean; count?: number; renamed?: Array<{ from: string; to: string }> }> {
  return fetchJSON(`/api/spaces/${spaceId}/docs/${encodeDocPath(docPath)}/rename`, {
    method: "POST",
    body: JSON.stringify({ newPath, scope }),
  });
}

export function archiveDoc(
  spaceId: string,
  docPath: string,
  reason?: string
): Promise<{ ok: boolean; archived?: ArchiveInfo; count?: number; paths?: string[] }> {
  return fetchJSON(`/api/spaces/${spaceId}/docs/${encodeDocPath(docPath)}/archive`, {
    method: "POST",
    body: JSON.stringify(reason ? { reason } : {}),
  });
}

export function restoreDoc(
  spaceId: string,
  docPath: string
): Promise<{ ok: boolean; count?: number; paths?: string[] }> {
  return fetchJSON(`/api/spaces/${spaceId}/docs/${encodeDocPath(docPath)}/restore`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function listDocVersions(
  spaceId: string,
  docPath: string,
  all = false
): Promise<DocVersionEntry[]> {
  return fetchJSON<{ versions: DocVersionEntry[] }>(
    `/api/spaces/${spaceId}/docs/${encodeDocPath(docPath)}/versions${all ? "?all=true" : ""}`
  ).then((r) => r.versions);
}

export function readDocVersion(
  spaceId: string,
  docPath: string,
  versionId: string
): Promise<DocVersionSnapshot> {
  return fetchJSON<{ version: DocVersionSnapshot }>(
    `/api/spaces/${spaceId}/docs/${encodeDocPath(docPath)}/versions/${encodeURIComponent(versionId)}`
  ).then((r) => r.version);
}

export function createDocCheckpoint(
  spaceId: string,
  docPath: string,
  label?: string
): Promise<{ ok: boolean; provenance?: DocMeta["provenance"] }> {
  return fetchJSON(`/api/spaces/${spaceId}/docs/${encodeDocPath(docPath)}/versions/checkpoint`, {
    method: "POST",
    body: JSON.stringify({ label }),
  });
}

// ── Record a human review checkpoint ────────────────────────
// REST-only on the server by design: review is the human trust anchor and
// is never exposed over MCP.

export function reviewDoc(
  spaceId: string,
  docPath: string
): Promise<{ ok: boolean; provenance?: DocMeta["provenance"]; freshness?: DocFreshness }> {
  return fetchJSON(`/api/spaces/${spaceId}/docs/${encodeDocPath(docPath)}/review`, {
    method: "POST",
  });
}

export function restoreDocVersion(
  spaceId: string,
  docPath: string,
  versionId: string
): Promise<{ ok: boolean; provenance?: DocMeta["provenance"]; updatedAt: number }> {
  return fetchJSON(`/api/spaces/${spaceId}/docs/${encodeDocPath(docPath)}/versions/${encodeURIComponent(versionId)}/restore`, {
    method: "POST",
  });
}
