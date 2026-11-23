import type {
  DocumentFormatClaim,
  DocumentHealth,
} from "@worktable/types";

export type TreeNodeKind = "folder" | "document" | "conflict";

export interface TreeNode {
  name: string;
  /** Display name: a doc's first heading (H1) if present, else a humanized slug. */
  label: string;
  /** The doc's first heading (H1), if this node is a doc with one. Drives `label`. */
  title?: string;
  path: string;
  /** Common catalog state at this path; implicit folders have no document. */
  kind: TreeNodeKind;
  isFolder: boolean;
  format?: DocumentFormatClaim;
  health?: DocumentHealth;
  archived?: boolean;
  /** Last-write time (ms). Folders carry the newest of their descendants. */
  updatedAt?: number;
  /** A temporary document: it archives itself, on this date when known. */
  temporary?: { archiveOn?: string };
  /** The date a slug starts with ("2026-11-04-home-redesign"), as YYYY-MM-DD. */
  dated?: string;
  children: TreeNode[];
}

export interface TreeInput {
  path: string;
  /** Catalog entries are documents unless the path is an inert conflict. */
  kind?: "document" | "conflict";
  /** Explicit display label, overriding headings/humanized slug. */
  title?: string;
  format?: DocumentFormatClaim;
  health?: DocumentHealth;
  archived?: boolean;
  /** Legacy callers may still provide headings while migrating to catalog titles. */
  headings?: string[];
  /** ISO timestamp of the doc's last write (provenance.updatedAt). */
  updatedAt?: string;
  lifetime?: "durable" | "temporary";
  archiveOn?: string;
}

export type DocSortMode = "custom" | "alphabetical" | "updated";

export interface TreeSort {
  /** Sort mode; "custom" (default) uses `order`, falling back to alphabetical. */
  mode?: DocSortMode;
  /** Manual document/folder order (legacy setting key `docOrder`). */
  order?: string[];
  /**
   * List newest first, folders and documents together, wherever nobody set
   * an order by hand.
   */
  newestFirst?: boolean;
}

export interface TreeBuildOptions {
  /** Paths that remain folders because another projected cohort has children. */
  folderPaths?: ReadonlySet<string>;
}

const DATED_SLUG = /^(\d{4})-(\d{2})-(\d{2})[-_](.+)$/;

/**
 * A slug that starts with a date ("2026-11-04-home-redesign") reads as its
 * name ("Home Redesign") with the date apart, so a list of them doesn't
 * start every row with the same digits.
 */
export function datedSegment(
  segment: string
): { label: string; dated?: string } {
  const match = DATED_SLUG.exec(segment);
  if (!match) return { label: humanizeSegment(segment) };
  const [, year, month, day, rest] = match;
  const dated = `${year}-${month}-${day}`;
  if (Number.isNaN(Date.parse(dated))) return { label: humanizeSegment(segment) };
  return { label: humanizeSegment(rest), dated };
}

/**
 * When a node is from, for newest-first lists: a date in its name, which is
 * the date its row shows, or else its last write.
 */
export function nodeTime(node: TreeNode): number {
  return node.dated ? Date.parse(`${node.dated}T23:59:59`) : (node.updatedAt ?? 0);
}

/** Turn a slug segment ("planning-onsite") into a readable label ("Planning Onsite"). */
export function humanizeSegment(segment: string): string {
  const words = segment.replace(/[-_]+/g, " ").trim();
  if (!words) return segment;
  return words.replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase());
}

export function buildTree(
  items: (string | TreeInput)[],
  sort?: TreeSort,
  options?: TreeBuildOptions
): TreeNode[] {
  const root: TreeNode[] = [];
  // Each level's nodes by name, so placing a path costs one lookup per segment.
  const levels = new Map<TreeNode[], Map<string, TreeNode>>();
  const namesAt = (level: TreeNode[]) => {
    let names = levels.get(level);
    if (!names) {
      names = new Map();
      levels.set(level, names);
    }
    return names;
  };

  for (const item of items) {
    const path = typeof item === "string" ? item : item.path;
    const kind =
      typeof item === "string" ? "document" : (item.kind ?? "document");
    const format = typeof item === "string" ? undefined : item.format;
    const health = typeof item === "string" ? undefined : item.health;
    const archived = typeof item === "string" ? undefined : item.archived;
    const title =
      typeof item === "string"
        ? undefined
        : (item.title?.trim() || item.headings?.[0]?.trim());
    const updatedAtIso = typeof item === "string" ? undefined : item.updatedAt;
    const temporary =
      typeof item !== "string" && item.lifetime === "temporary"
        ? { ...(item.archiveOn ? { archiveOn: item.archiveOn } : {}) }
        : undefined;
    const updatedAt = updatedAtIso ? Date.parse(updatedAtIso) || undefined : undefined;
    const parts = path.split("/");
    let current = root;
    let currentPath = "";

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isLast = i === parts.length - 1;

      // The catalog has already resolved the common namespace: one logical
      // path becomes one document, one inert conflict, or one implicit folder.
      const names = namesAt(current);
      let node = names.get(part);
      if (!node) {
        const slug = datedSegment(part);
        node = {
          name: part,
          title: isLast ? title : undefined,
          // Catalog titles win; folders and label-less leaves humanize the slug.
          label: isLast && title ? title : slug.label,
          ...(slug.dated && !(isLast && title) ? { dated: slug.dated } : {}),
          path: currentPath,
          kind: isLast ? kind : "folder",
          isFolder: !isLast || options?.folderPaths?.has(currentPath) === true,
          format: isLast ? format : undefined,
          health: isLast ? health : undefined,
          archived: isLast ? archived : undefined,
          ...(isLast && temporary ? { temporary } : {}),
          updatedAt,
          children: [],
        };
        current.push(node);
        names.set(part, node);
      } else {
        if (!isLast || options?.folderPaths?.has(currentPath)) {
          // This path has children here or in another projected cohort.
          node.isFolder = true;
        }
        if (isLast) {
          // A document may also own a path with descendants; retain both roles.
          if (format) node.format = format;
          if (health) node.health = health;
          if (archived) node.archived = true;
          if (title) node.title = title;
          if (temporary) node.temporary = temporary;
          node.kind = kind;
        }
        // Recompute display label: a doc's H1 always wins over the humanized slug,
        // and survives promotion when a path is both a doc and a folder.
        const slug = datedSegment(part);
        node.label = node.title ?? slug.label;
        if (node.title || !slug.dated) delete node.dated;
        else node.dated = slug.dated;
      }
      // Ancestors inherit the newest descendant write time ("updated" sort).
      if (updatedAt && (!node.updatedAt || updatedAt > node.updatedAt)) {
        node.updatedAt = updatedAt;
      }
      current = node.children;
    }
  }

  // Sort: folders always group before docs; within each kind the mode decides —
  // "custom" (default) uses the manual order with alphabetical fallback,
  // "alphabetical" ignores the manual order, "updated" is newest-write-first.
  const mode = sort?.mode ?? "custom";
  const orderIndex = new Map<string, number>(
    (mode === "custom" ? (sort?.order ?? []) : []).map((path, i) => [path, i])
  );
  const sortNodes = (nodes: TreeNode[]) => {
    // Nobody ordered these by hand: newest first, folders and docs together.
    if (
      sort?.newestFirst &&
      mode === "custom" &&
      !nodes.some((node) => orderIndex.has(node.path))
    ) {
      nodes.sort((a, b) => nodeTime(b) - nodeTime(a) || a.name.localeCompare(b.name));
      nodes.forEach((n) => sortNodes(n.children));
      return;
    }
    nodes.sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      if (mode === "updated") {
        const au = a.updatedAt ?? 0;
        const bu = b.updatedAt ?? 0;
        if (au !== bu) return bu - au;
        return a.name.localeCompare(b.name);
      }
      const ai = orderIndex.get(a.path) ?? Number.POSITIVE_INFINITY;
      const bi = orderIndex.get(b.path) ?? Number.POSITIVE_INFINITY;
      if (ai !== bi) return ai - bi;
      return a.name.localeCompare(b.name);
    });
    nodes.forEach((n) => sortNodes(n.children));
  };
  sortNodes(root);

  return root;
}

/** All document and folder paths in display order. */
export function flattenTreeOrder(nodes: TreeNode[]): string[] {
  return nodes.flatMap((n) => [n.path, ...flattenTreeOrder(n.children)]);
}
