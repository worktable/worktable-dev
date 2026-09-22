// ============================================================
// Doc link graph: outbound links + backlinks per space
// ============================================================
//
// Extracts doc→doc references from markdown bodies and BlockNote
// inline links, resolves them against the space's docs root, and
// caches the resulting graph with the same lazy dirty/invalidate
// lifecycle as the search index. The graph is derived, in-memory,
// and rebuildable — never written to the workspace.
//
// Link semantics: a leading `/` resolves from the space docs root
// (the recommended, rename-stable form); anything else resolves
// relative to the linking doc's folder. External targets (URLs,
// mailto:, anchors) are ignored. Broken links are legal — they may
// simply be not-yet-written docs — and are reported, not rejected.

import { listDocs, readDoc } from "./store.ts";
import { onDocContentChanged } from "./content-events.ts";
import { resolveDocLink, type DocListEntry } from "@worktable/types";
import { readDocAliases, resolveDocAliasIn } from "./doc-aliases.ts";
import { onWorkspaceChange } from "./workspace-events.ts";

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

// ── Graph cache (mirrors search-index lifecycle) ─────────────

const graphs = new Map<string, SpaceLinkGraph>();
const building = new Map<string, { generation: number; promise: Promise<SpaceLinkGraph> }>();
let dirty = true;
let generation = 0;

export function invalidateLinkGraph(): void {
  generation += 1;
  dirty = true;
}

// Store-level change notifications cover internal writes whose watcher
// events are suppressed (REST PUT, MCP writes, Yjs persists).
onDocContentChanged(() => {
  invalidateLinkGraph();
});
onWorkspaceChange((event) => {
  if (event.type === "docAliases" || event.type === "workspaceReset") {
    invalidateLinkGraph();
  }
});

let rebuildHookForTests: (() => Promise<void>) | null = null;

export function setLinkGraphRebuildHookForTests(
  hook: (() => Promise<void>) | null,
): void {
  rebuildHookForTests = hook;
}

async function buildSpaceLinkGraph(spaceId: string): Promise<SpaceLinkGraph> {
  const docPaths = await listDocs(spaceId);
  const docSet = new Set(docPaths);
  const outbound = new Map<string, DocLink[]>();
  const inbound = new Map<string, string[]>();
  const broken: SpaceLinkGraph["broken"] = [];
  const { aliases, error: aliasError } = await readDocAliases(spaceId);
  if (!aliases) {
    throw new Error(aliasError ?? "Document aliases are unavailable");
  }

  for (const docPath of docPaths) {
    const result = await readDoc(spaceId, docPath);
    if (result.error || result.data === null) continue;

    const links: DocLink[] = [];
    const seen = new Set<string>();
    for (const target of extractDocLinkTargets(result.data as string | unknown[])) {
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
  await rebuildHookForTests?.();
  return { outbound, inbound, orphans, broken };
}

export async function getSpaceLinkGraph(spaceId: string): Promise<SpaceLinkGraph> {
  for (;;) {
    if (dirty) {
      graphs.clear();
      dirty = false;
    }
    const cached = graphs.get(spaceId);
    if (cached) return cached;

    const expectedGeneration = generation;
    let pending = building.get(spaceId);
    if (!pending || pending.generation !== expectedGeneration) {
      pending = { generation: expectedGeneration, promise: buildSpaceLinkGraph(spaceId) };
      building.set(spaceId, pending);
    }
    let graph: SpaceLinkGraph;
    try {
      graph = await pending.promise;
    } finally {
      if (building.get(spaceId) === pending) building.delete(spaceId);
    }
    if (generation !== expectedGeneration) {
      continue;
    }
    graphs.set(spaceId, graph);
    return graph;
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
