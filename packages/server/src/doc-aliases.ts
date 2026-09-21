import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWriteText } from "./atomic-file.ts";
import {
  BoundedFileReadError,
  readBoundedRegularFile,
} from "./bounded-file.ts";
import { getDocAliasesPath } from "./workspace.ts";
import { notifyWorkspaceChange } from "./workspace-events.ts";
import { assertWorkspaceAvailable } from "./workspace-safety.ts"
import {
  analyzeDocumentPath,
  documentPathKeyIsAtOrBelow,
  documentPathKeyIsBelow,
} from "./document-path.ts"

export interface DocAliases {
  exact: Record<string, string>;
  prefixes: Record<string, string>;
}

interface DocAliasesFile extends DocAliases {
  type: "worktable.doc-aliases";
  version: 1;
}

export type AliasKind = "exact" | "prefix";

const MAX_ALIAS_HOPS = 32;
export const DOC_ALIASES_MAX_BYTES = 8 * 1024 * 1024;
const ALIAS_VALIDATION_CACHE_MAX_ENTRIES = 256;
const aliasLocks = new Map<string, Promise<void>>();
const aliasValidationCache = new Map<
  string,
  { revision: string; valid: boolean }
>();

function emptyAliases(): DocAliases {
  return { exact: Object.create(null), prefixes: Object.create(null) };
}

function parseMap(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result: Record<string, string> = Object.create(null);
  for (const [from, to] of Object.entries(value as Record<string, unknown>)) {
    const fromKey = analyzeDocumentPath(from).comparisonKey;
    if (
      !isStoreCanonicalPath(from) ||
      typeof to !== "string" ||
      !isStoreCanonicalPath(to) ||
      from === to ||
      (fromKey !== null && fromKey === analyzeDocumentPath(to).comparisonKey)
    ) return null;
    result[from] = to;
  }
  return result;
}

function isStoreCanonicalPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("..") &&
    !path.includes("\0")
  );
}

function parseAliases(value: unknown): DocAliases | null {
  if (!value || typeof value !== "object") return null;
  const file = value as Record<string, unknown>;
  if (file["type"] !== "worktable.doc-aliases" || file["version"] !== 1) {
    return null;
  }
  const exact = parseMap(file["exact"]);
  const prefixes = parseMap(file["prefixes"]);
  return exact && prefixes ? { exact, prefixes } : null;
}

export async function readDocAliases(
  spaceId: string
): Promise<{ aliases: DocAliases | null; error: string | null }> {
  return readDocAliasesAt(getDocAliasesPath(spaceId));
}

export async function readDocAliasesAt(
  path: string
): Promise<{ aliases: DocAliases | null; error: string | null }> {
  let text: string;
  try {
    text = await readBoundedRegularFile(path, DOC_ALIASES_MAX_BYTES);
  } catch (error) {
    if (error instanceof BoundedFileReadError && error.reason === "missing") {
      return { aliases: emptyAliases(), error: null };
    }
    if (
      error instanceof BoundedFileReadError &&
      (error.reason === "symlink" || error.reason === "not-file")
    ) {
      return {
        aliases: null,
        error: `Document alias file must be a regular file: ${path}`,
      };
    }
    if (error instanceof BoundedFileReadError && error.reason === "too-large") {
      return {
        aliases: null,
        error: `Document alias file exceeds its size limit: ${path}`,
      };
    }
    return { aliases: null, error: `Corrupt document alias file: ${path}` };
  }

  return parseDocAliasesSnapshot(text, path);
}

/** Parse one already-captured alias-file snapshot without rereading its path. */
export function parseDocAliasesSnapshot(
  text: string | null,
  path: string
): { aliases: DocAliases | null; error: string | null } {
  if (text === null) return { aliases: emptyAliases(), error: null };
  try {
    const parsed = parseAliases(JSON.parse(text));
    if (!parsed) {
      return { aliases: null, error: `Corrupt document alias file: ${path}` };
    }
    if (!aliasRevisionIsValid(path, text, parsed)) {
      return {
        aliases: null,
        error: `Document alias cycle or hop limit exceeded: ${path}`,
      };
    }
    return { aliases: parsed, error: null };
  } catch {
    return { aliases: null, error: `Corrupt document alias file: ${path}` };
  }
}

function aliasRevisionIsValid(
  path: string,
  text: string,
  aliases: DocAliases
): boolean {
  const revision = createHash("sha256").update(text).digest("base64url");
  const cached = aliasValidationCache.get(path);
  if (cached?.revision === revision) {
    aliasValidationCache.delete(path);
    aliasValidationCache.set(path, cached);
    return cached.valid;
  }

  const valid = aliasesResolveAcyclically(aliases);
  aliasValidationCache.delete(path);
  aliasValidationCache.set(path, { revision, valid });
  while (aliasValidationCache.size > ALIAS_VALIDATION_CACHE_MAX_ENTRIES) {
    const oldest = aliasValidationCache.keys().next().value;
    if (typeof oldest !== "string") break;
    aliasValidationCache.delete(oldest);
  }
  return valid;
}

interface AppliedAlias {
  path: string;
  key: string | null;
  kind: AliasKind | null;
}

interface AliasSourceIndex {
  exactByComparisonKey: Map<string, string[]>;
  exactSources: Array<{ path: string; comparisonKey: string | null }>;
  prefixSources: Array<{ path: string; comparisonKey: string | null }>;
  prefixesByPath: Map<string, string[]>;
  prefixesByComparisonKey: Map<string, string[]>;
}

function buildAliasSourceIndex(aliases: DocAliases): AliasSourceIndex {
  const exactByComparisonKey = new Map<string, string[]>();
  const exactSources = Object.keys(aliases.exact).map((path) => {
    const comparisonKey = analyzeDocumentPath(path).comparisonKey;
    if (comparisonKey) {
      const sources = exactByComparisonKey.get(comparisonKey) ?? [];
      sources.push(path);
      exactByComparisonKey.set(comparisonKey, sources);
    }
    return { path, comparisonKey };
  });
  const prefixesByPath = new Map<string, string[]>();
  const prefixesByComparisonKey = new Map<string, string[]>();
  const prefixSources = Object.keys(aliases.prefixes).map((path) => {
    const comparisonKey = analyzeDocumentPath(path).comparisonKey;
    const lexicalSources = prefixesByPath.get(path) ?? [];
    lexicalSources.push(path);
    prefixesByPath.set(path, lexicalSources);
    if (comparisonKey) {
      const portableSources = prefixesByComparisonKey.get(comparisonKey) ?? [];
      portableSources.push(path);
      prefixesByComparisonKey.set(comparisonKey, portableSources);
    }
    return { path, comparisonKey };
  });
  return {
    exactByComparisonKey,
    exactSources,
    prefixSources,
    prefixesByPath,
    prefixesByComparisonKey,
  };
}

function prefixSourcesArePortableUnique(index: AliasSourceIndex): boolean {
  const comparisonKeys = new Set<string>();
  for (const source of index.prefixSources) {
    if (!source.comparisonKey) continue;
    if (comparisonKeys.has(source.comparisonKey)) return false;
    comparisonKeys.add(source.comparisonKey);
  }
  return true;
}

function portablePathMatches(left: string, right: string): boolean {
  if (left === right) return true;
  const leftKey = analyzeDocumentPath(left).comparisonKey;
  const rightKey = analyzeDocumentPath(right).comparisonKey;
  return Boolean(leftKey && rightKey && leftKey === rightKey);
}

function exactAliasSources(
  aliases: DocAliases,
  path: string,
  index: AliasSourceIndex
): string[] {
  const comparisonKey = analyzeDocumentPath(path).comparisonKey;
  if (comparisonKey) return index.exactByComparisonKey.get(comparisonKey) ?? [];
  return Object.hasOwn(aliases.exact, path) ? [path] : [];
}

function portablePrefixAliasSources(
  path: string,
  index: AliasSourceIndex
): string[] {
  const matchingSources = new Set<string>();
  for (const ancestor of pathAndAncestors(path)) {
    for (const source of index.prefixesByPath.get(ancestor) ?? []) {
      matchingSources.add(source);
    }
  }
  const pathKey = analyzeDocumentPath(path).comparisonKey;
  if (pathKey) {
    for (const ancestor of pathAndAncestors(pathKey)) {
      for (const source of
        index.prefixesByComparisonKey.get(ancestor) ?? []) {
        matchingSources.add(source);
      }
    }
  }
  return [...matchingSources]
    .sort((left, right) => {
      const segmentDelta = right.split("/").length - left.split("/").length;
      return segmentDelta || right.length - left.length;
    });
}

function pathAndAncestors(path: string): string[] {
  const paths = [path];
  let separator = path.lastIndexOf("/");
  while (separator >= 0) {
    paths.push(path.slice(0, separator));
    separator = path.lastIndexOf("/", separator - 1);
  }
  return paths;
}

function lexicalPrefixAliasSources(
  path: string,
  index: AliasSourceIndex
): string[] {
  // A prefix alias stores only its root. Portable matching cannot reconstruct
  // the canonical spelling of descendant segments on case-sensitive disks.
  return pathAndAncestors(path)
    .flatMap((candidate) => index.prefixesByPath.get(candidate) ?? [])
    .sort((left, right) => {
      const segmentDelta = right.split("/").length - left.split("/").length;
      return segmentDelta || right.length - left.length;
    });
}

function rewritePrefixPath(from: string, to: string, path: string): string {
  const suffix = path.split("/").slice(from.split("/").length);
  return [to, ...suffix].join("/");
}

function applyAliasOnce(
  aliases: DocAliases,
  path: string,
  index: AliasSourceIndex,
  includeExact = true
): AppliedAlias | null {
  const exactSources = includeExact
    ? exactAliasSources(aliases, path, index)
    : [];
  if (exactSources.length > 1) return null;
  const exactSource = exactSources[0];
  if (exactSource) {
    return {
      path: aliases.exact[exactSource]!,
      key: `exact:${exactSource}`,
      kind: "exact",
    };
  }

  const matchingPrefixes = lexicalPrefixAliasSources(path, index);
  const prefix = matchingPrefixes[0];
  if (
    prefix &&
    matchingPrefixes[1] &&
    portablePathMatches(prefix, matchingPrefixes[1])
  ) return null;
  if (!prefix) return { path, key: null, kind: null };
  return {
    path: rewritePrefixPath(prefix, aliases.prefixes[prefix]!, path),
    key: `prefix:${prefix}`,
    kind: "prefix",
  };
}

function resolveDocAliasInMode(
  aliases: DocAliases,
  path: string,
  includeExact: boolean,
  index: AliasSourceIndex
): string | null {
  let current = path;
  const applied = new Set<string>();
  let previousKey: string | null = null;
  for (let hop = 0; hop < MAX_ALIAS_HOPS; hop++) {
    const exactSources = includeExact
      ? exactAliasSources(aliases, current, index)
      : [];
    if (exactSources.length > 1) return null;
    const exactSource = exactSources[0];
    const exactKey = exactSource ? `exact:${exactSource}` : null;
    let next: AppliedAlias;
    if (exactSource && exactKey) {
      if (applied.has(exactKey)) return null;
      next = {
        path: aliases.exact[exactSource]!,
        key: exactKey,
        kind: "exact",
      };
    } else {
      const matchingPrefixes = lexicalPrefixAliasSources(current, index);
      if (
        matchingPrefixes[0] &&
        matchingPrefixes[1] &&
        portablePathMatches(matchingPrefixes[0], matchingPrefixes[1])
      ) return null;
      const prefix = matchingPrefixes.find(
        (candidate) => !applied.has(`prefix:${candidate}`)
      );
      if (!prefix) {
        if (matchingPrefixes.length === 0) return current;
        // A single ancestor-move prefix may still match after its one rewrite.
        // Stop only when that same alias was the immediately previous step;
        // returning to an older applied alias after another step is a cycle.
        return `prefix:${matchingPrefixes[0]}` === previousKey ? current : null;
      }
      next = {
        path: rewritePrefixPath(
          prefix,
          aliases.prefixes[prefix]!,
          current
        ),
        key: `prefix:${prefix}`,
        kind: "prefix",
      };
    }
    applied.add(next.key!);
    previousKey = next.key;
    current = next.path;
  }
  return null;
}

/** Resolve exact aliases before longest-prefix aliases, with bounded cycle detection. */
export function resolveDocAliasIn(
  aliases: DocAliases,
  path: string
): string | null {
  const index = buildAliasSourceIndex(aliases);
  if (!prefixSourcesArePortableUnique(index)) return null;
  return resolveDocAliasInMode(
    aliases,
    path,
    true,
    index
  );
}

function aliasesResolveAcyclically(aliases: DocAliases): boolean {
  const index = buildAliasSourceIndex(aliases);
  if (!prefixSourcesArePortableUnique(index)) return false;
  const sources = [
    ...Object.keys(aliases.exact),
    ...Object.keys(aliases.prefixes),
  ];
  for (const from of Object.keys(aliases.exact)) {
    if (resolveDocAliasInMode(aliases, from, true, index) === null) return false;
  }
  for (const [from, to] of Object.entries(aliases.prefixes)) {
    if (to.startsWith(`${from}/`)) return false;
    if (resolveDocAliasInMode(aliases, from, true, index) === null) return false;
    // A suffix that cannot occur in a valid alias key reveals prefix cycles
    // that are otherwise shadowed by an ancestor-move alias matching twice.
    if (
      resolveDocAliasInMode(
        aliases,
        `${from}/\0alias-cycle-probe`,
        true,
        index
      ) === null
    ) {
      return false;
    }
    // Prefix cycles can depend on a real suffix. Probe every boundary where
    // this alias target can become another alias source after one rewrite.
    for (const candidate of [
      ...Object.keys(aliases.exact),
      ...Object.keys(aliases.prefixes),
    ]) {
      if (!candidate.startsWith(`${to}/`)) continue;
      const probe = `${from}${candidate.slice(to.length)}`;
      if (resolveDocAliasInMode(aliases, probe, true, index) === null) {
        return false;
      }
    }
  }
  const suffixes = new Set<string>();
  for (const path of [
    ...sources,
    ...Object.values(aliases.exact),
    ...Object.values(aliases.prefixes),
  ]) {
    const segments = path.split("/");
    for (let index = 0; index < segments.length; index++) {
      suffixes.add(segments.slice(index).join("/"));
    }
  }
  for (const source of sources) {
    for (const suffix of suffixes) {
      if (
        resolveDocAliasInMode(
          aliases,
          `${source}/${suffix}`,
          true,
          index
        ) === null
      ) {
        return false;
      }
    }
  }
  return true;
}

function hasDescendantExactAlias(
  path: string,
  index: AliasSourceIndex
): boolean {
  const pathKey = analyzeDocumentPath(path).comparisonKey;
  return index.exactSources.some((candidate) => {
    const candidatePath = candidate.path;
    if (candidatePath === path || candidatePath.startsWith(`${path}/`)) {
      return true;
    }
    return Boolean(
      pathKey &&
        candidate.comparisonKey &&
        (candidate.comparisonKey === pathKey ||
          candidate.comparisonKey.startsWith(`${pathKey}/`))
    );
  });
}

function compactPrefixTarget(
  aliases: DocAliases,
  path: string,
  index: AliasSourceIndex
): string | null {
  let current = path;
  const applied = new Set<string>();
  for (let hop = 0; hop < MAX_ALIAS_HOPS; hop++) {
    // Crossing this root would skip exact aliases for descendants that older
    // prefix aliases still need to reach.
    if (hasDescendantExactAlias(current, index)) return current;
    const next = applyAliasOnce(aliases, current, index, false);
    if (!next) return null;
    if (!next.key) return current;
    if (applied.has(next.key)) return null;
    applied.add(next.key);
    current = next.path;
  }
  return null;
}

export async function resolveDocAlias(
  spaceId: string,
  path: string
): Promise<{ path: string | null; error: string | null }> {
  const { aliases, error } = await readDocAliases(spaceId);
  if (!aliases) return { path: null, error };
  const resolved = resolveDocAliasIn(aliases, path);
  return resolved
    ? { path: resolved, error: null }
    : { path: null, error: "Document alias cycle or hop limit exceeded" };
}

/** Aliased paths, including every descendant of a prefix alias, are reserved. */
export function createDocAliasReservationLookup(
  aliases: DocAliases
): (path: string) => { kind: AliasKind; path: string } | null {
  const index = buildAliasSourceIndex(aliases);
  return (path) => {
    const exact = exactAliasSources(aliases, path, index)[0];
    if (exact) return { kind: "exact", path: exact };
    const prefix = portablePrefixAliasSources(path, index)[0];
    return prefix ? { kind: "prefix", path: prefix } : null;
  };
}

export function reservedByAliasIn(
  aliases: DocAliases,
  path: string
): { kind: AliasKind; path: string } | null {
  return createDocAliasReservationLookup(aliases)(path);
}

export async function docAliasReservationError(
  spaceId: string,
  path: string
): Promise<string | null> {
  const { aliases, error } = await readDocAliases(spaceId);
  if (!aliases) return error ?? "Document aliases are unavailable";
  const reserved = reservedByAliasIn(aliases, path);
  return reserved
    ? `Path is reserved by a document ${reserved.kind} alias: ${reserved.path}`
    : null;
}

function compactAliases(aliases: DocAliases): DocAliases | null {
  const index = buildAliasSourceIndex(aliases);
  const exact: Record<string, string> = Object.create(null);
  const prefixes: Record<string, string> = Object.create(null);
  for (const [from, to] of Object.entries(aliases.exact)) {
    const resolved = resolveDocAliasInMode(aliases, to, true, index);
    if (!resolved || resolved === from) return null;
    exact[from] = resolved;
  }
  for (const [from, to] of Object.entries(aliases.prefixes)) {
    // A prefix target represents a subtree root. Stop before any root with
    // descendant exact aliases so older paths can still reach those aliases.
    const resolved = compactPrefixTarget(aliases, to, index);
    if (!resolved || resolved === from || resolved.startsWith(`${from}/`)) return null;
    prefixes[from] = resolved;
  }
  return { exact, prefixes };
}

function serializeDocAliases(aliases: DocAliases): string {
  const file: DocAliasesFile = {
    type: "worktable.doc-aliases",
    version: 1,
    exact: aliases.exact,
    prefixes: aliases.prefixes,
  };
  const serialized = `${JSON.stringify(file, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > DOC_ALIASES_MAX_BYTES) {
    throw new Error("Document alias file exceeds its size limit");
  }
  return serialized
}

async function writeDocAliases(
  spaceId: string,
  aliases: DocAliases
): Promise<void> {
  const path = getDocAliasesPath(spaceId)
  const serialized = serializeDocAliases(aliases)
  await mkdir(dirname(path), { recursive: true });
  await atomicWriteText(path, serialized);
}

export async function withDocAliasLock<T>(spaceId: string, fn: () => Promise<T>): Promise<T> {
  const previous = aliasLocks.get(spaceId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  aliasLocks.set(spaceId, tail);
  await previous;
  try {
    assertWorkspaceAvailable()
    return await fn();
  } finally {
    release();
    if (aliasLocks.get(spaceId) === tail) aliasLocks.delete(spaceId);
  }
}

/** Prepare an exact-alias mutation without publishing it. */
export function prepareDocAliasBatch(
  aliases: DocAliases,
  entries: Array<{ from: string; to: string; kind: AliasKind }>
): string {
  const next: DocAliases = {
    exact: Object.assign(Object.create(null), aliases.exact),
    prefixes: Object.assign(Object.create(null), aliases.prefixes),
  }
  for (const { from, to, kind } of entries) {
    if (
      !isStoreCanonicalPath(from) ||
      !isStoreCanonicalPath(to) ||
      from === to
    ) {
      throw new Error("Document alias paths must be distinct canonical paths")
    }
    if (kind === "exact") next.exact[from] = to
    else next.prefixes[from] = to
  }
  const compacted = compactAliases(next)
  if (!compacted) throw new Error("Document alias update would create a cycle")
  return serializeDocAliases(compacted)
}

/**
 * Prepare the exact alias change for one document move. A destination exact
 * alias may be reclaimed only when it already resolves to this document; a
 * prefix alias still owns a whole subtree and therefore remains reserved.
 */
export function prepareDocAliasMove(
  aliases: DocAliases,
  from: string,
  to: string
): string {
  if (!isStoreCanonicalPath(from) || !isStoreCanonicalPath(to) || from === to) {
    throw new Error("Document alias paths must be distinct canonical paths")
  }

  const index = buildAliasSourceIndex(aliases)
  const prefix = portablePrefixAliasSources(to, index)[0]
  if (prefix) {
    throw new Error(`Target path is reserved by a document alias: ${to}`)
  }
  const exactSources = exactAliasSources(aliases, to, index)
  if (exactSources.length > 1) {
    throw new Error("Document aliases are ambiguous at the target path")
  }
  const exactSource = exactSources[0]
  if (exactSource) {
    const resolved = resolveDocAliasInMode(aliases, exactSource, true, index)
    if (!resolved || !portablePathMatches(resolved, from)) {
      throw new Error(`Target path is reserved by a document alias: ${to}`)
    }
  }

  const next: DocAliases = {
    exact: Object.assign(Object.create(null), aliases.exact),
    prefixes: Object.assign(Object.create(null), aliases.prefixes),
  }
  if (exactSource) delete next.exact[exactSource]
  next.exact[from] = to
  const compacted = compactAliases(next)
  if (!compacted) throw new Error("Document alias update would create a cycle")
  return serializeDocAliases(compacted)
}

/**
 * Prepare removal of exact aliases that resolve to a retiring document path.
 * Prefix aliases represent whole subtrees and cannot safely express a single
 * deleted descendant, so those cases fail closed until the folder lifecycle
 * can retire the subtree mapping as one operation.
 */
export function prepareDocAliasRetirement(
  aliases: DocAliases,
  target: string
): string | null {
  if (!isStoreCanonicalPath(target)) {
    throw new Error("Document alias retirement target must be canonical")
  }

  const index = buildAliasSourceIndex(aliases)
  const prefixTargets: string[] = []
  for (const from of Object.keys(aliases.prefixes)) {
    const resolvedRoot = compactPrefixTarget(
      aliases,
      aliases.prefixes[from]!,
      index
    )
    if (
      !resolvedRoot ||
      target === resolvedRoot ||
      target.startsWith(`${resolvedRoot}/`)
    ) {
      throw new Error(
        "Document cannot be deleted safely while a folder alias resolves to it"
      )
    }
    prefixTargets.push(aliases.prefixes[from]!)
  }

  const retired = Object.keys(aliases.exact).filter(
    (from) => resolveDocAliasInMode(aliases, from, true, index) === target
  )
  if (retired.length === 0) return null
  for (const from of retired) {
    if (
      Object.keys(aliases.prefixes).some(
        (prefix) => from === prefix || from.startsWith(`${prefix}/`)
      ) ||
      prefixTargets.some(
        (prefixTarget) =>
          from === prefixTarget || from.startsWith(`${prefixTarget}/`)
      )
    ) {
      throw new Error(
        "Document cannot be deleted safely while its exact alias is nested under a folder alias"
      )
    }
  }

  const next: DocAliases = {
    exact: Object.assign(Object.create(null), aliases.exact),
    prefixes: Object.assign(Object.create(null), aliases.prefixes),
  }
  for (const from of retired) delete next.exact[from]
  const compacted = compactAliases(next)
  if (!compacted) throw new Error("Document alias retirement would be unsafe")
  return serializeDocAliases(compacted)
}

/**
 * Retire aliases whose resolved destination belongs to a deleted subtree.
 * A prefix alias resolving to an ancestor of that subtree straddles deleted
 * and surviving generations, so the folder deletion must fail closed.
 */
export function prepareDocAliasPrefixRetirement(
  aliases: DocAliases,
  prefix: string
): string | null {
  const prefixKey = analyzeDocumentPath(prefix).comparisonKey
  if (!isStoreCanonicalPath(prefix) || !prefixKey) {
    throw new Error("Document alias retirement prefix must be canonical")
  }

  const index = buildAliasSourceIndex(aliases)
  const retiredExact = Object.keys(aliases.exact).filter((from) => {
    const resolved = resolveDocAliasInMode(aliases, from, true, index)
    const key = resolved ? analyzeDocumentPath(resolved).comparisonKey : null
    if (!key) throw new Error("Document alias retirement would be unsafe")
    return documentPathKeyIsAtOrBelow(key, prefixKey)
  })
  const retiredPrefixes: string[] = []
  for (const from of Object.keys(aliases.prefixes)) {
    const resolved = compactPrefixTarget(
      aliases,
      aliases.prefixes[from]!,
      index
    )
    const key = resolved ? analyzeDocumentPath(resolved).comparisonKey : null
    if (!key) throw new Error("Document alias retirement would be unsafe")
    if (documentPathKeyIsBelow(prefixKey, key)) {
      throw new Error(
        "Document folder cannot be deleted safely while a broader folder alias resolves across it"
      )
    }
    if (documentPathKeyIsAtOrBelow(key, prefixKey)) {
      retiredPrefixes.push(from)
    }
  }
  if (retiredExact.length === 0 && retiredPrefixes.length === 0) return null

  const next: DocAliases = {
    exact: Object.assign(Object.create(null), aliases.exact),
    prefixes: Object.assign(Object.create(null), aliases.prefixes),
  }
  for (const from of retiredExact) delete next.exact[from]
  for (const from of retiredPrefixes) delete next.prefixes[from]
  const compacted = compactAliases(next)
  if (!compacted) throw new Error("Document alias retirement would be unsafe")
  return serializeDocAliases(compacted)
}

export async function recordDocAlias(
  spaceId: string,
  from: string,
  to: string,
  kind: AliasKind
): Promise<void> {
  return recordDocAliasBatch(spaceId, [{ from, to, kind }]);
}

export async function recordDocAliasBatch(
  spaceId: string,
  entries: Array<{ from: string; to: string; kind: AliasKind }>
): Promise<void> {
  for (const { from, to } of entries) {
  if (!isStoreCanonicalPath(from) || !isStoreCanonicalPath(to) || from === to) {
    throw new Error("Document alias paths must be distinct canonical paths");
  }
  }
  await withDocAliasLock(spaceId, async () => {
    const { aliases, error } = await readDocAliases(spaceId);
    if (!aliases) throw new Error(error ?? "Document aliases are unavailable");
    for (const { from, to, kind } of entries) {
      if (kind === "exact") aliases.exact[from] = to;
      else aliases.prefixes[from] = to;
    }
    const compacted = compactAliases(aliases);
    if (!compacted) throw new Error("Document alias update would create a cycle");
    await writeDocAliases(spaceId, compacted);
  });
  notifyWorkspaceChange({ type: "docAliases", spaceId });
}

/** Explicitly retire one exact or prefix alias so its path may be reused. */
export async function retireDocAlias(
  spaceId: string,
  path: string,
  kind: AliasKind
): Promise<boolean> {
  let removed = false;
  await withDocAliasLock(spaceId, async () => {
    const { aliases, error } = await readDocAliases(spaceId);
    if (!aliases) throw new Error(error ?? "Document aliases are unavailable");
    const map = kind === "exact" ? aliases.exact : aliases.prefixes;
    if (Object.hasOwn(map, path)) {
      delete map[path];
      removed = true;
      await writeDocAliases(spaceId, aliases);
    }
  });
  if (removed) notifyWorkspaceChange({ type: "docAliases", spaceId });
  return removed;
}
