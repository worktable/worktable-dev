import { z } from "zod";
import type { WidgetFile } from "./widgets";
import type {
  DocFreshness,
  DocumentFormatClaim,
  DocumentHealth,
} from "./documents";

export * from "./mermaid";
export * from "./markdown";
export * from "./annotations";
export * from "./widgets";
export * from "./records";
export * from "./mcp-clients";
export * from "./doc-links";
export * from "./document-reference";
export * from "./documents";
export * from "./document-storage-v2";
export * from "./threads";
export * from "./agent-connections";

export type SpaceId = string;
export type AgentId = string;
export type ISOTimestamp = string;

export const SpaceFileSchema = z.object({
  type: z.literal("worktable.space"),
  version: z.number(),
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  icon: z.string().optional(),
  group: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: z.string(),
  settings: z.record(z.string(), z.unknown()),
});

export type SpaceFile = z.infer<typeof SpaceFileSchema>;

export const ArchiveInfoSchema = z.object({
  archivedAt: z.string(),
  archivedBy: z.string(),
  reason: z.string().optional(),
});

export type ArchiveInfo = z.infer<typeof ArchiveInfoSchema>;

export interface DocListEntry {
  path: string;
  format: "blocknote" | "markdown";
  storedAs?: "json" | "md";
  readFormatHint?: "blocknote" | "markdown";
  /** File mtime (ms) — last-updated fallback for docs without provenance. */
  updatedAt?: number;
  headings?: string[];
  blockCount?: number | null;
  containsMermaid?: boolean;
  richBlockTypes?: string[];
  archived?: ArchiveInfo;
  provenance?: {
    updatedAt: string;
    updatedBy: string;
    source: string;
    versionId: string;
    contentHash: string;
  };
  freshness?: DocFreshness;
  /** Docs linking to this one — count only in lists; full paths on single-doc reads. */
  backlinkCount?: number;
}

export type DocSourceCategory = "human" | "agent" | "external" | "system" | "restore";

/**
 * Classify who a doc write came from. Single source of truth shared by the
 * server (freshness derivation, checkpoint labels) and the web UI (provenance
 * chips) — keep the heuristics here so the two can never disagree.
 */
export function sourceCategory(source?: string, updatedBy?: string): DocSourceCategory {
  const normalizedSource = (source ?? "").toLowerCase();
  const normalizedBy = (updatedBy ?? "").toLowerCase();
  if (normalizedSource === "version-restore") return "restore";
  // A browser persist with no human-edit signal is machine normalization
  // drift, not a human touch — must never launder to "human".
  if (normalizedSource === "browser-yjs-sync") return "system";
  if (normalizedSource === "browser-yjs") return "human";
  if (normalizedSource === "mcp" || normalizedBy.includes("agent")) return "agent";
  if (normalizedSource === "filesystem") return "external";
  if (normalizedSource === "rest-api") {
    if (normalizedBy === "user" || normalizedBy === "human") return "human";
    if (normalizedBy && normalizedBy !== "unknown") return "agent";
    return "system";
  }
  return "system";
}

export interface SearchResult {
  spaceId: string;
  type: "doc" | "record";
  path?: string;
  title: string;
  score: number;
  /** Present for results produced by the format-neutral document search. */
  documentKind?: "document" | "conflict";
  /** Server-owned legacy view capability; absent when no current viewer can open it. */
  documentView?: "doc" | "html";
  /** Open format claim for a usable document; conflicts intentionally omit it. */
  format?: DocumentFormatClaim;
  /** Kernel health for a format-neutral document result. */
  health?: DocumentHealth;
  collectionId?: string;
  recordId?: string;
  /** Plain-text window around the first matched term (title-only matches fall back to the body's start). */
  excerpt?: string;
}

export type SpaceWithDocs = SpaceFile & { docs: DocListEntry[]; widgets?: WidgetFile[] };

export interface DocFile {
  path: string;
  content: unknown[];
  updatedAt: number;
}

export interface AgentAttribution {
  agentId: AgentId;
  timestamp: ISOTimestamp;
}
export * from "./quickdraw-document.ts";

export * from "./workspace-layout";
