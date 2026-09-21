// ============================================================
// Server-generated space index
// ============================================================
//
// The one index that can never rot: computed from the filesystem
// on every request, never stored, and never writable by agents
// (a doc-file index under spaces/ would be agent-writable and is
// the classic wiki-rot artifact). Docs are grouped by top-level
// folder and carry the derived freshness/backlink signals, giving
// humans a browsable space overview and agents progressive
// disclosure without loading every doc.

import type { DocFreshness } from "@worktable/types";
import { decorateDocsWithFreshness } from "./freshness.ts";
import { decorateDocsWithBacklinkCounts } from "./link-graph.ts";
import { listDocsDetailed, readSpace } from "./store.ts";

export interface SpaceIndexDoc {
  path: string;
  title: string;
  headings: string[];
  freshness?: DocFreshness;
  backlinkCount: number;
}

export interface SpaceIndexGroup {
  /** Top-level folder ("" for root docs). */
  folder: string;
  /** Human-readable group label ("Overview" for root docs). */
  label: string;
  docs: SpaceIndexDoc[];
}

export interface SpaceIndex {
  spaceId: string;
  name: string;
  description?: string;
  generatedAt: string;
  docCount: number;
  groups: SpaceIndexGroup[];
}

function humanize(segment: string): string {
  const cleaned = segment.replace(/[-_]+/g, " ").trim();
  return cleaned.replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase());
}

function docTitle(path: string, headings: string[]): string {
  if (headings.length > 0 && headings[0]!.trim()) return headings[0]!;
  return humanize(path.split("/").pop() ?? path);
}

export async function buildSpaceIndex(spaceId: string): Promise<SpaceIndex | null> {
  const space = await readSpace(spaceId);
  if (!space.data) return null;

  const docs = await decorateDocsWithBacklinkCounts(
    spaceId,
    await decorateDocsWithFreshness(spaceId, await listDocsDetailed(spaceId, { includeArchived: false }))
  );

  const byFolder = new Map<string, SpaceIndexDoc[]>();
  for (const doc of docs) {
    const slash = doc.path.indexOf("/");
    const folder = slash === -1 ? "" : doc.path.slice(0, slash);
    const entry: SpaceIndexDoc = {
      path: doc.path,
      title: docTitle(doc.path, doc.headings ?? []),
      headings: doc.headings ?? [],
      freshness: doc.freshness,
      backlinkCount: doc.backlinkCount ?? 0,
    };
    const group = byFolder.get(folder) ?? [];
    group.push(entry);
    byFolder.set(folder, group);
  }

  const groups: SpaceIndexGroup[] = [...byFolder.entries()]
    .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
    .map(([folder, groupDocs]) => ({
      folder,
      label: folder === "" ? "Overview" : humanize(folder),
      docs: groupDocs.sort((a, b) => a.path.localeCompare(b.path)),
    }));

  return {
    spaceId,
    name: space.data.name,
    ...(space.data.description ? { description: space.data.description } : {}),
    generatedAt: new Date().toISOString(),
    docCount: docs.length,
    groups,
  };
}
