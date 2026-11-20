import { z } from "zod";
import type {
  DocumentFormatClaim,
  DocumentHealth,
} from "./documents";
import type { SearchSkill } from "./skills";

export * from "./constants";
export * from "./sent-comment";
export * from "./mermaid";
export * from "./markdown";
export * from "./delimited-text";
export * from "./file-types";
export * from "./annotations";
export * from "./passage";
export * from "./html-element";
export * from "./widgets";
export * from "./records";
export * from "./link-grants";
export * from "./abilities";
export * from "./sharing";
export * from "./mcp-clients";
export * from "./doc-links";
export * from "./document-reference";
export * from "./documents";
export * from "./document-storage-v2";
export * from "./version-ids";
export * from "./threads";
export * from "./agent-connections";
export * from "./agent-platforms";
export * from "./activity";
export * from "./skills";
export * from "./teams";
export * from "./personal-navigation";
export * from "./recognition";
export * from "./setup";

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
  /** File mtime (ms) — last-updated fallback for docs without provenance. */
  updatedAt?: number;
  headings?: string[];
  blockCount?: number | null;
  containsMermaid?: boolean;
  richBlockTypes?: string[];
  archived?: ArchiveInfo;
  /** When the doc was created through Worktable; absent when unknown. */
  createdAt?: string;
  /** Present on temporary docs: when the doc archives itself. */
  archiveOn?: string;
  provenance?: {
    updatedAt: string;
    updatedBy: string;
    source: string;
    versionId: string;
    contentHash: string;
  };
  /** Docs linking to this one — count only in lists; full paths on single-doc reads. */
  backlinkCount?: number;
  /** The Doc is kept, but its source isn't Doc blocks, so it doesn't open. */
  unreadable?: true;
}

export { sourceCategory, type DocSourceCategory } from "./doc-source";

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
  /** Present on temporary documents: when the document archives itself. */
  archiveOn?: string;
  /**
   * The result or its Space is archived. Only on a search that asked for
   * archived results after the rest.
   */
  archived?: true;
  /** The Library skill this Doc is, when the reader sees the Library. */
  skill?: SearchSkill;
}

/** The kinds a search can be narrowed to. */
export const SEARCH_KINDS = ["doc", "html", "drawing", "file", "record"] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

/** Which kind a search result is, from its type and format. */
export function searchResultKind(result: {
  type: SearchResult["type"];
  format?: { id: string };
}): SearchKind {
  if (result.type === "record") return "record";
  switch (result.format?.id) {
    case "worktable.html":
      return "html";
    case "worktable.file":
      return "file";
    case "worktable.quickdraw":
    case "worktable.excalidraw":
      return "drawing";
    default:
      return "doc";
  }
}

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

export * from "./drawing-operations.ts";

export { DRAWING_THEME } from "./drawing-theme.generated";

export * from "./drawing-bindings.ts";
export * from "./drawing-record-comparison.ts";
export * from "./grok-bot.ts";
export * from "./document-preview.ts";
