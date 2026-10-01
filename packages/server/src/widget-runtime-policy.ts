import type { WidgetFile } from "@worktable/types"
import { queryTargetCollections } from "./record-store.ts"

export function buildWidgetCsp(network: boolean, fontOrigin?: string): string {
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    `font-src data:${fontOrigin ? ` ${new URL("/worktable-preview/fonts/", fontOrigin).href}` : ""}`,
    network ? "connect-src 'self' ws: wss: https:" : "connect-src 'self'",
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ")
}

export function canWidgetRecord(
  widget: {
    permissions?: {
      records?: Record<
        string,
        { read?: boolean; create?: boolean; update?: boolean; delete?: boolean }
      >
    }
  },
  collectionId: string,
  action: "read" | "create" | "update" | "delete"
): boolean {
  const permission =
    widget.permissions?.records?.[collectionId] ??
    widget.permissions?.records?.["*"]
  return !!permission?.[action]
}

/** Includes every collection reached through relations, expands and backlinks. */
export async function deniedWidgetQueryCollection(
  spaceId: string,
  permissions: WidgetFile["permissions"],
  collectionId: string,
  query: unknown
): Promise<string | null> {
  if (!canWidgetRecord({ permissions }, collectionId, "read"))
    return collectionId
  for (const target of await queryTargetCollections(
    spaceId,
    collectionId,
    query
  )) {
    if (!canWidgetRecord({ permissions }, target, "read")) return target
  }
  return null
}

export class WidgetRecordAccessError extends Error {
  readonly collectionId: string
  constructor(collectionId: string) {
    super(`Widget lacks read permission for ${collectionId}`)
    this.collectionId = collectionId
    this.name = "WidgetRecordAccessError"
  }
}

/** Guard actual relation reads, even when schemas change after query preflight. */
export function widgetRecordReadGuard(permissions: WidgetFile["permissions"]) {
  return (collectionId: string): void => {
    if (!canWidgetRecord({ permissions }, collectionId, "read"))
      throw new WidgetRecordAccessError(collectionId)
  }
}
