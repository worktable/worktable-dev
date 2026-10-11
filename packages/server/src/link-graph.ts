// ============================================================
// Doc link graph: outbound links + backlinks per space
// ============================================================
//
// Extracts doc→doc references from markdown bodies and BlockNote
// inline links, resolves them against the space's docs root, and
// caches each Doc's links and the resulting graph, refreshing only
// the Docs that changed. The graph is derived, in-memory, and
// rebuildable — never written to the workspace.
//
// Link semantics: a leading `/` resolves from the space docs root
// (the recommended, rename-stable form); anything else resolves
// relative to the linking doc's folder. External targets (URLs,
// mailto:, anchors) are ignored. Broken links are legal — they may
// simply be not-yet-written docs — and are reported, not rejected.

import { docStat, listDocs, readDoc } from "./store.ts";
import { onDocContentChanged } from "./content-events.ts";
import { resolveDocLink, type DocListEntry } from "@worktable/types";
import {
  readDocAliases,
  resolveDocAliasIn,
  type DocAliases,
} from "./doc-aliases.ts";
import { onWorkspaceChange } from "./workspace-events.ts";
import { canReuseDerived, type DerivedRevision } from "./derived-revision.ts";

export { resolveDocLink } from "@worktable/types";

export interface DocLink {
  /** Raw link target as written in the doc. */
  target: string;
  /** Canonical doc path the target resolves to. */
  resolvedPath: string;
  /** Whether a doc exists at the resolved path. */
  resolved: boolean;
}

export interface SpaceLinkGraph {
  /** Outbound doc links per doc path. */
  outbound: Map<string, DocLink[]>;
  /** Doc paths linking to the keyed doc (resolved links only). */
  inbound: Map<string, string[]>;
  /** Docs with no inbound links from any other doc. */
  orphans: string[];
  /** Outbound links whose target doc does not exist. */
  broken: Array<{ docPath: string; target: string; resolvedPath: string }>;
}

// ── Extraction ────────────────────────────────────────────────

/** Strip fenced code blocks and inline code spans so their contents never register as links. */
function stripCode(markdown: string): string {
  return markdown
    .replace(/^```[\s\S]*?^```/gm, "")
    .replace(/`[^`\n]*`/g, "");
}

function extractMarkdownLinkTargets(markdown: string): string[] {
  const targets: string[] = [];
  // Inline links [text](target "title"), excluding images ![alt](src).
  const linkRe = /(!?)\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  const cleaned = stripCode(markdown);
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(cleaned)) !== null) {
    if (match[1] === "!") continue;
    targets.push(match[2]!);
  }
  return targets;
}

function extractBlockNoteLinkTargets(blocks: unknown[], targets: string[] = []): string[] {
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (Array.isArray(b.content)) {
      for (const inline of b.content) {
        if (!inline || typeof inline !== "object") continue;
        const node = inline as Record<string, unknown>;
        if (node.type === "link" && typeof node.href === "string") {
          targets.push(node.href);
        }
      }
    }
    if (Array.isArray(b.children)) {
      extractBlockNoteLinkTargets(b.children, targets);
    }
  }
  return targets;
}

/** Raw link targets from a doc body (markdown string or BlockNote blocks). */
export function extractDocLinkTargets(content: string | unknown[]): string[] {
  if (typeof content === "string") return extractMarkdownLinkTargets(content);
  if (Array.isArray(content)) return extractBlockNoteLinkTargets(content);
  return [];
}

// ── Graph cache ─────────────────────────────────────────────
//
// Per Space: each Doc's raw link targets with the source revision they were
// read from, and the graph resolved from them. Change events mark the Space
// dirty and name the Docs that changed. The next read re-lists the Space,
// re-reads only Docs whose revision changed or that an event named, and
// re-resolves the graph, which needs no reads.

/** Rebuilds one read waits for before answering with the latest graph. */
const MAX_REBUILD_ROUNDS = 3;

interface DocTargets extends DerivedRevision {
  targets: string[];
}

interface SpaceLinks {
  docs: Map<string, DocTargets>;
  graph: SpaceLinkGraph | null;
  dirty: boolean;
  /** Doc paths to re-read even when their revision looks unchanged. */
  forced: Set<string>;
  building: Promise<void> | null;
}

const spaces = new Map<string, SpaceLinks>();
let resetEpoch = 0;

function markSpace(spaceId: string, docPath?: string): void {
  const space = spaces.get(spaceId);
  if (!space) return;
  space.dirty = true;
  if (docPath !== undefined) space.forced.add(docPath);
}

/** Re-check every Space at its next read; unchanged Docs are not re-read. */
export function invalidateLinkGraph(): void {
  for (const space of spaces.values()) space.dirty = true;
}

// Store-level change notifications cover internal writes whose watcher
// events are suppressed (REST PUT, MCP writes, Yjs persists); workspace
// events carry external edits and catalog changes.
onDocContentChanged((spaceId, docPath) => {
  markSpace(spaceId, docPath);
});
onWorkspaceChange((event) => {
  switch (event.type) {
    case "doc":
      markSpace(event.spaceId, event.docPath);
      break;
    case "space":
    case "docAliases":
    case "documentCorpus":
      markSpace(event.spaceId);
      break;
    case "workspaceReset":
      resetEpoch += 1;
      spaces.clear();
      break;
  }
});

let rebuildHookForTests: (() => Promise<void>) | null = null;

export function setLinkGraphRebuildHookForTests(
  hook: (() => Promise<void>) | null,
): void {
  rebuildHookForTests = hook;
}

function resolveSpaceLinkGraph(
  docPaths: string[],
  docs: ReadonlyMap<string, DocTargets>,
  aliases: DocAliases,
): SpaceLinkGraph {
  const docSet = new Set(docPaths);
  const outbound = new Map<string, DocLink[]>();
  const inbound = new Map<string, string[]>();
  const broken: SpaceLinkGraph["broken"] = [];

  for (const docPath of docPaths) {
    const targets = docs.get(docPath)?.targets;
    if (!targets) continue;

    const links: DocLink[] = [];
    const seen = new Set<string>();
    for (const target of targets) {
      const lexicalPath = resolveDocLink(docPath, target);
      if (lexicalPath === null) continue;
      const resolvedPath = resolveDocAliasIn(aliases, lexicalPath);
      if (resolvedPath === null) {
        throw new Error(`Document alias cycle or hop limit exceeded for ${lexicalPath}`);
      }
      if (resolvedPath === docPath) continue;
      if (seen.has(resolvedPath)) continue;
      seen.add(resolvedPath);

      const resolved = docSet.has(resolvedPath);
      links.push({ target, resolvedPath, resolved });
      if (resolved) {
        const sources = inbound.get(resolvedPath) ?? [];
        sources.push(docPath);
        inbound.set(resolvedPath, sources);
      } else {
        broken.push({ docPath, target, resolvedPath });
      }
    }
    if (links.length > 0) outbound.set(docPath, links);
  }

  const orphans = docPaths.filter((path) => !inbound.has(path));
  return { outbound, inbound, orphans, broken };
}

async function buildSpaceLinks(spaceId: string, space: SpaceLinks): Promise<void> {
  const forced = space.forced;
  // Marks made while this build runs stay for the next one.
  space.forced = new Set();
  space.dirty = false;
  try {
    const docPaths = await listDocs(spaceId);
    const { aliases, error: aliasError } = await readDocAliases(spaceId);
    if (!aliases) {
      throw new Error(aliasError ?? "Document aliases are unavailable");
    }

    const docs = new Map<string, DocTargets>();
    for (const docPath of docPaths) {
      const readAt = Date.now();
      const stat = await docStat(spaceId, docPath);
      const revision = stat ? `${stat.format}:${stat.updatedAt}` : "";
      const cached = space.docs.get(docPath);
      if (
        cached &&
        !forced.has(docPath) &&
        canReuseDerived(cached, revision, stat?.updatedAt)
      ) {
        docs.set(docPath, cached);
        continue;
      }
      const result = await readDoc(spaceId, docPath);
      if (result.error || result.data === null) continue;
      docs.set(docPath, {
        revision,
        readAt,
        targets: extractDocLinkTargets(result.data as string | unknown[]),
      });
    }

    const graph = resolveSpaceLinkGraph(docPaths, docs, aliases);
    await rebuildHookForTests?.();
    space.docs = docs;
    space.graph = graph;
  } catch (error) {
    space.dirty = true;
    for (const docPath of forced) space.forced.add(docPath);
    throw error;
  }
}

function rebuildSpaceLinks(spaceId: string, space: SpaceLinks): Promise<void> {
  if (!space.building) {
    const building = buildSpaceLinks(spaceId, space);
    space.building = building;
    void building
      .finally(() => {
        if (space.building === building) space.building = null;
      })
      .catch(() => undefined);
  }
  return space.building;
}

export async function getSpaceLinkGraph(spaceId: string): Promise<SpaceLinkGraph> {
  for (let round = 1; ; round += 1) {
    const epoch = resetEpoch;
    let space = spaces.get(spaceId);
    if (!space) {
      space = { docs: new Map(), graph: null, dirty: true, forced: new Set(), building: null };
      spaces.set(spaceId, space);
    }
    if (space.graph && !space.dirty && !space.building) return space.graph;
    await rebuildSpaceLinks(spaceId, space);
    // A workspace reset retired this cache: never answer from another
    // workspace's Docs.
    if (resetEpoch !== epoch) continue;
    // Continuous edits must not hold a reader hostage: after a few rounds,
    // answer with the graph as of the latest rebuild.
    if (space.graph && (!space.dirty || round >= MAX_REBUILD_ROUNDS)) {
      return space.graph;
    }
  }
}

export async function getDocLinks(
  spaceId: string,
  docPath: string
): Promise<{ links: DocLink[]; backlinks: string[] }> {
  const graph = await getSpaceLinkGraph(spaceId);
  return {
    links: graph.outbound.get(docPath) ?? [],
    backlinks: graph.inbound.get(docPath) ?? [],
  };
}

/** Annotate a doc list with backlink counts from one graph build. */
export async function decorateDocsWithBacklinkCounts(
  spaceId: string,
  docs: DocListEntry[]
): Promise<DocListEntry[]> {
  const graph = await getSpaceLinkGraph(spaceId);
  return docs.map((doc) => ({
    ...doc,
    backlinkCount: graph.inbound.get(doc.path)?.length ?? 0,
  }));
}
