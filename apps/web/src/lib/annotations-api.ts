import type { Annotation, AnnotationAuthor, AnnotationCategory, AnnotationStatus, AnnotationTarget } from "@worktable/types";
import { getUserProfile } from "./profile.ts";
import { fetchJSON } from "./http.ts";

export interface AnnotationListParams {
  docPath?: string;
  /** Filter to one HTML doc's (widget's) doc-level annotations. */
  widgetId?: string;
  blockId?: string;
  status?: AnnotationStatus[];
  category?: AnnotationCategory[];
  includeResolved?: boolean;
  labels?: string[];
  /** Server default is 100; pass explicitly when counting across a space. */
  limit?: number;
}

function query(params: AnnotationListParams): string {
  const search = new URLSearchParams();
  if (params.docPath) search.set("docPath", params.docPath);
  // Widget ids carry slashes; URLSearchParams percent-encodes the value on
  // serialization, so the query param survives the trip to the server.
  if (params.widgetId) search.set("widgetId", params.widgetId);
  if (params.blockId) search.set("blockId", params.blockId);
  if (params.status?.length) search.set("status", params.status.join(","));
  if (params.category?.length) search.set("category", params.category.join(","));
  if (params.includeResolved) search.set("includeResolved", "true");
  if (params.labels?.length) search.set("labels", params.labels.join(","));
  if (params.limit !== undefined) search.set("limit", String(params.limit));
  const value = search.toString();
  return value ? `?${value}` : "";
}

export function listAnnotations(spaceId: string, params: AnnotationListParams = {}) {
  return fetchJSON<{ annotations: Annotation[]; total: number; nextOffset?: number }>(
    `/api/spaces/${spaceId}/annotations${query(params)}`
  );
}

async function canonicalUserAuthor(): Promise<AnnotationAuthor> {
  const { id, name } = await getUserProfile();
  return { type: "user", id, name };
}

export async function createAnnotation(spaceId: string, input: {
  target: AnnotationTarget;
  category: AnnotationCategory;
  body: string;
  title?: string;
  labels?: string[];
}) {
  const author = await canonicalUserAuthor();
  return fetchJSON<{ ok: true; annotationId: string; annotation: Annotation; created: boolean }>(
    `/api/spaces/${spaceId}/annotations`,
    { method: "POST", body: JSON.stringify({ ...input, author }) }
  );
}

export async function replyAnnotation(spaceId: string, annotationId: string, body: string) {
  const author = await canonicalUserAuthor();
  return fetchJSON<{ ok: true; replyId: string; annotation: Annotation }>(
    `/api/spaces/${spaceId}/annotations/${annotationId}/replies`,
    { method: "POST", body: JSON.stringify({ body, author }) }
  );
}

export async function resolveAnnotation(spaceId: string, annotationId: string, reason?: string) {
  const author = await canonicalUserAuthor();
  return fetchJSON<{ ok: true; annotation: Annotation }>(
    `/api/spaces/${spaceId}/annotations/${annotationId}/resolve`,
    { method: "POST", body: JSON.stringify({ reason, resolvedBy: author.id }) }
  );
}

export async function reopenAnnotation(spaceId: string, annotationId: string) {
  const author = await canonicalUserAuthor();
  return fetchJSON<{ ok: true; annotation: Annotation }>(
    `/api/spaces/${spaceId}/annotations/${annotationId}`,
    { method: "PATCH", body: JSON.stringify({ status: "open", updatedBy: author.id }) }
  );
}
