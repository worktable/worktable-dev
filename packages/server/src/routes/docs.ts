import { requireScope, requireHumanWorkspaceOwner, restWriteActor } from "../auth.ts";
import { Hono } from "hono";
import { z } from "zod";
import {
  listDocs,
  listDocsByPrefix,
  listDocsDetailed,
  readDoc,
  readDocSourceSnapshot,
  writeDoc,
  deleteDoc,
  docExists,
  docStat,
  slugifyDocPath,
  deduplicateSlug,
  getDocArchiveInfo,
  getDocArchiveInfoMap,
  getDocProvenance,
  getDocCollaborationCacheEpoch,
  getDocCollaborationCacheEpochHistory,
  setDocArchived,
  setDocsArchivedByPrefix,
  suppressPath,
  unsuppressPath,
  getDocPath,
  listDocVersions,
  getDocVersion,
  restoreDocVersion,
  createManualDocCheckpoint,
  createDocReviewCheckpoint,
  convertDocToMarkdownStorage,
  sanitizeDocPath,
  type DocProvenance,
} from "../store.ts";
import { decorateDocsWithFreshness, evictFreshness, getDocFreshness } from "../freshness.ts";
import { decorateDocsWithBacklinkCounts, getDocLinks } from "../link-graph.ts";
import { wsManager } from "../ws.ts";
import { DocFormatTransitionConflictError, yjsManager } from "../yjs-manager.ts";
import { invalidateSearchIndex } from "../search-index.ts";
import { listDocAnnotations } from "../annotation-store.ts";
import { renameDocAndSync, renameDocsByPrefixAndSync } from "../doc-rename.ts";
import { docAliasReservationError, readDocAliases, resolveDocAlias, resolveDocAliasIn } from "../doc-aliases.ts";
import { extractHeadings, extractMarkdownHeadings, prepareMarkdownStorageConversion } from "../markdown.ts";
import { documentReferenceFallbackTitle, parseDocumentReference, type ResolvedDocumentReference } from "@worktable/types";
import { MermaidDocumentValidationError } from "../mermaid-document.ts";
import { getWorkspaceCollaborationEpoch } from "../collaboration-epoch.ts";

const WriteDocSchema = z.object({
  content: z.array(z.unknown()),
});

const RenameDocSchema = z.object({
  newPath: z.string().min(1),
  scope: z.enum(["document", "folder"]).optional(),
});

const CreateDocSchema = z.object({
  title: z.string().min(1),
  content: z.array(z.unknown()).optional(),
});

async function hasUnportableAnnotationAnchors(
  spaceId: string,
  docPath: string,
  blocks: unknown[]
): Promise<boolean> {
  const annotations = await listDocAnnotations(spaceId, docPath);

  const flattened: Array<{ id?: string; text: string }> = [];
  const collectBlocks = (values: unknown[]) => {
    for (const value of values) {
      if (!value || typeof value !== "object") continue;
      const block = value as Record<string, unknown>;
      const textFromContent = (content: unknown): string => {
        if (typeof content === "string") return content;
        if (!Array.isArray(content)) return "";
        return content
          .map((item) =>
            item && typeof item === "object"
              ? typeof (item as Record<string, unknown>).text === "string"
                ? String((item as Record<string, unknown>).text)
                : textFromContent((item as Record<string, unknown>).content)
              : ""
          )
          .join("");
      };
      flattened.push({
        id: typeof block.id === "string" ? block.id : undefined,
        text: textFromContent(block.content).replace(/\s+/g, " ").trim(),
      });
      if (Array.isArray(block.children)) collectBlocks(block.children);
    }
  };
  collectBlocks(blocks);

  return annotations.some(
    ({ target }) =>
      (target.type === "block" || target.type === "text") && (() => {
        const quote = target.quote?.replace(/\s+/g, " ").trim();
        if (!quote) return true;
        const matches = flattened.filter(({ text }) => text.includes(quote));
        return matches.length !== 1 || matches[0]?.id !== target.blockId;
      })()
  );
}

const ArchiveDocSchema = z.object({
  archivedBy: z.string().optional(),
  reason: z.string().optional(),
});

const CheckpointSchema = z.object({
  label: z.string().trim().optional(),
});

const ResolveDocumentReferencesSchema = z.object({
  paths: z.array(z.unknown()).max(500),
});

export const docsRouter = new Hono();

docsRouter.onError((error, c) => {
  if (error instanceof MermaidDocumentValidationError) {
    return c.json({ error: error.message, ...error.toJSON() }, 422);
  }
  throw error;
});

/** Extract and decode the doc path from a raw request URL */
function extractDocPath(rawPath: string, spaceId: string, stripSuffix?: string): string {
  const prefix = `/api/spaces/${spaceId}/docs/`;
  let docPath = rawPath.slice(prefix.length);
  if (stripSuffix && docPath.endsWith(stripSuffix)) {
    docPath = docPath.slice(0, -stripSuffix.length);
  }
  return decodeURIComponent(docPath);
}

// GET /api/spaces/:spaceId/docs — list all doc paths
docsRouter.get("/", requireScope("docs:read"), async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  const includeArchived = c.req.query("includeArchived") === "true";
  if (!spaceId) {
    return c.json({ error: "Missing spaceId", code: "BAD_REQUEST" }, 400);
  }

  const docs = await decorateDocsWithBacklinkCounts(
    spaceId,
    await decorateDocsWithFreshness(spaceId, await listDocsDetailed(spaceId, { includeArchived }))
  );
  return c.json({ docs });
});

// One resolver for every record surface. It deliberately preserves the
// authored storedPath while following aliases only for display/navigation.
docsRouter.post("/resolve-references", requireScope("docs:read"), async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  const parsedBody = ResolveDocumentReferencesSchema.safeParse(await c.req.json().catch(() => null));
  if (!spaceId) return c.json({ error: "Missing spaceId", code: "VALIDATION_ERROR" }, 400);
  if (!parsedBody.success) return c.json({ error: parsedBody.error.message, code: "VALIDATION_ERROR" }, 400);

  const { aliases, error: aliasFileError } = await readDocAliases(spaceId);
  type PreparedReference =
    | { reference: ResolvedDocumentReference }
    | { storedPath: string; resolvedPath: string };
  const prepared = parsedBody.data.paths.map((input): PreparedReference => {
    const storedPath = typeof input === "string" ? input : String(input ?? "");
    const parsed = parseDocumentReference(input);
    if ("error" in parsed || parsed.path !== input) {
      return { reference: {
        storedPath,
        resolvedPath: null,
        title: storedPath || "Invalid document",
        state: "invalid",
        error: "error" in parsed ? parsed.error : `must use canonical document path ${parsed.path}`,
      } };
    }

    const resolvedPath = aliases ? resolveDocAliasIn(aliases, parsed.path) : null;
    if (!resolvedPath) {
      return { reference: {
        storedPath,
        resolvedPath: null,
        title: documentReferenceFallbackTitle(storedPath),
        state: "invalid",
        error: aliasFileError ?? "Document alias cycle or hop limit exceeded",
      } };
    }
    return { storedPath, resolvedPath };
  });
  const archiveInfo = await getDocArchiveInfoMap(
    spaceId,
    prepared.flatMap((entry) => "reference" in entry ? [] : [entry.resolvedPath])
  );
  const targetCache = new Map<string, Promise<Pick<ResolvedDocumentReference, "title" | "state">>>();
  const resolveTarget = (path: string) => {
    const cached = targetCache.get(path);
    if (cached) return cached;
    const pending = (async (): Promise<Pick<ResolvedDocumentReference, "title" | "state">> => {
      if (!(await docExists(spaceId, path))) {
        return { title: documentReferenceFallbackTitle(path), state: "missing" };
      }
      const readResult = await readDoc(spaceId, path);
      const headings = Array.isArray(readResult.data)
        ? extractHeadings(readResult.data)
        : typeof readResult.data === "string"
          ? extractMarkdownHeadings(readResult.data)
          : [];
      return {
        title: headings[0]?.trim() || documentReferenceFallbackTitle(path),
        state: archiveInfo.has(path) ? "archived" : "available",
      };
    })();
    targetCache.set(path, pending);
    return pending;
  };

  const references = await Promise.all(prepared.map(async (entry): Promise<ResolvedDocumentReference> => {
    if ("reference" in entry) return entry.reference;
    const target = await resolveTarget(entry.resolvedPath);
    return {
      storedPath: entry.storedPath,
      resolvedPath: entry.resolvedPath,
      ...target,
    };
  }));
  return c.json({ references });
});

// POST /api/spaces/:spaceId/docs — create a new doc from a human title.
// The title is slugified per-segment into the canonical path (so spaces/case
// never reach the filesystem or the collab room). Agents create docs via MCP
// with an explicit slug path and don't use this route. Registered before the
// "/*" wildcard so it isn't swallowed by it.
docsRouter.post("/", requireScope("docs:write"), async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  if (!spaceId) {
    return c.json({ error: "Missing spaceId", code: "BAD_REQUEST" }, 400);
  }

  const body = await c.req.json().catch(() => null);
  if (!body) {
    return c.json({ error: "Invalid JSON body", code: "INVALID_BODY" }, 400);
  }

  const parsed = CreateDocSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.message, code: "VALIDATION_ERROR" }, 400);
  }

  const base = slugifyDocPath(parsed.data.title);
  if (!base) {
    return c.json({ error: "Title is empty after normalization", code: "VALIDATION_ERROR" }, 400);
  }

  const docPath = await deduplicateSlug(base, await listDocs(spaceId));

  const filePath = getDocPath(spaceId, docPath);
  suppressPath(filePath);
  try {
    const result = await writeDoc(spaceId, docPath, parsed.data.content ?? [], {
      updatedBy: restWriteActor(c),
      source: "rest-api",
      managedIdentity: true,
    });
    if (!result.ok) {
      return c.json({ error: result.error ?? "Write failed", code: "CONFLICT" }, 409);
    }
  } finally {
    setTimeout(() => unsuppressPath(filePath), 150);
  }

  await yjsManager.getOrCreateDoc(spaceId, docPath);

  const statResult = await docStat(spaceId, docPath);
  const provenance = await getDocProvenance(spaceId, docPath);
  invalidateSearchIndex();
  wsManager.broadcast(spaceId, {
    type: "doc_update",
    spaceId,
    docPath,
    data: {
      path: docPath,
      updatedAt: statResult?.updatedAt ?? Date.now(),
      provenance,
    },
  });

  return c.json(
    { path: docPath, updatedAt: statResult?.updatedAt ?? Date.now(), provenance },
    201
  );
});

// POST /api/spaces/:spaceId/docs/*/{rename,convert}
// Must be before the wildcard GET to avoid conflicts
docsRouter.post("/*", requireScope("docs:write"), async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  const rawPath = c.req.path;

  if (!spaceId) {
    return c.json({ error: "Missing spaceId", code: "BAD_REQUEST" }, 400);
  }

  const routePrefix = `/api/spaces/${spaceId}/docs/`;
  const relativeMutationPath = decodeURIComponent(rawPath.slice(routePrefix.length));
  const guardedDocPath = relativeMutationPath
    .replace(/\/(?:rename|archive|restore|review|convert|convert-to-markdown)$/, "")
    .replace(/\/versions\/(?:checkpoint|[^/]+\/restore)$/, "");
  if (guardedDocPath !== relativeMutationPath) {
    const aliasError = await docAliasReservationError(
      spaceId,
      sanitizeDocPath(guardedDocPath)
    );
    if (aliasError) {
      return c.json({ error: aliasError, code: "CONFLICT" }, 409);
    }
  }

  // ── /rename handler ──
  if (rawPath.endsWith("/rename")) {
    const docPath = extractDocPath(rawPath, spaceId, "/rename");
    if (!docPath) {
      return c.json({ error: "Missing doc path", code: "BAD_REQUEST" }, 400);
    }

    const body = await c.req.json().catch(() => null);
    if (!body) {
      return c.json({ error: "Invalid JSON body", code: "INVALID_BODY" }, 400);
    }

    const parsed = RenameDocSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message, code: "VALIDATION_ERROR" }, 400);
    }

    // Slugify the human-entered target per-segment so renames produce canonical
    // paths (matching create). Internal/MCP callers pass exact paths directly.
    const newPath = slugifyDocPath(parsed.data.newPath);
    if (!newPath) {
      return c.json({ error: "New name is empty after normalization", code: "VALIDATION_ERROR" }, 400);
    }

    const explicitlySelectedFolder = parsed.data.scope === "folder";
    if (explicitlySelectedFolder) {
      const folderDocuments = await listDocsByPrefix(spaceId, docPath);
      const descendantPrefix = `${sanitizeDocPath(docPath)}/`;
      if (!folderDocuments.some((path) => path.startsWith(descendantPrefix))) {
        return c.json({ error: `Folder not found: ${docPath}`, code: "NOT_FOUND" }, 404);
      }
    }
    const documentExists = explicitlySelectedFolder
      ? false
      : await docExists(spaceId, docPath);
    const renameAsDocument =
      parsed.data.scope === "document" || documentExists;

    if (renameAsDocument) {
      // A title that normalizes to the current path (e.g. "My Doc" → "my-doc"
      // while already at "my-doc") is a no-op, not a self-collision. Checked
      // here (after existence) so a non-existent path still 404s below.
      if (documentExists && newPath === docPath) {
        return c.json({ ok: true, renamed: [{ from: docPath, to: docPath }], count: 1 });
      }

      const outcome = await renameDocAndSync(spaceId, docPath, newPath);
      if (outcome.error) {
        const error = outcome.error;
        const status = error.includes("not found") ? 404 : 409;
        return c.json({ error, code: status === 404 ? "NOT_FOUND" : "CONFLICT" }, status);
      }

      return c.json({ ok: true, renamed: outcome.renamed, count: outcome.renamed.length });
    }

    const outcome = await renameDocsByPrefixAndSync(spaceId, docPath, newPath);
    if (outcome.error) {
      const error = outcome.error;
      const status = error.includes("not found") ? 404 : 409;
      return c.json(
        {
          error,
          code: status === 404 ? "NOT_FOUND" : "CONFLICT",
          renamed: outcome.renamed,
          count: outcome.renamed.length,
        },
        status
      );
    }

    return c.json({ ok: true, renamed: outcome.renamed, count: outcome.renamed.length });
  }

  // ── /archive handler ──
  if (rawPath.endsWith("/archive")) {
    const docPath = extractDocPath(rawPath, spaceId, "/archive");
    if (!docPath) {
      return c.json({ error: "Missing doc path", code: "BAD_REQUEST" }, 400);
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = ArchiveDocSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message, code: "VALIDATION_ERROR" }, 400);
    }

    const exists = await docExists(spaceId, docPath);
    const result = exists
      ? await setDocArchived(
          spaceId,
          docPath,
          true,
          restWriteActor(c, parsed.data.archivedBy),
          parsed.data.reason
        )
      : await setDocsArchivedByPrefix(
          spaceId,
          docPath,
          true,
          restWriteActor(c, parsed.data.archivedBy),
          parsed.data.reason
        );
    if (result.error) {
      return c.json({ error: result.error, code: "NOT_FOUND" }, 404);
    }

    invalidateSearchIndex();

    if ("paths" in result) {
      for (const path of result.paths) {
        wsManager.broadcast(spaceId, {
          type: "doc_update",
          spaceId,
          docPath: path,
          data: {
            path,
            archived: await getDocArchiveInfo(spaceId, path),
          },
        });
      }
      return c.json({ ok: true, count: result.count, paths: result.paths });
    }

    wsManager.broadcast(spaceId, {
      type: "doc_update",
      spaceId,
      docPath,
      data: {
        path: docPath,
        archived: result.archived,
      },
    });

    return c.json({ ok: true, archived: result.archived });
  }

  // ── /versions/:versionId/restore handler ──
  const restoreVersionMatch = rawPath.match(new RegExp(`^/api/spaces/${spaceId}/docs/(.*)/versions/([^/]+)/restore$`));
  if (restoreVersionMatch) {
    const docPath = decodeURIComponent(restoreVersionMatch[1]);
    const versionId = restoreVersionMatch[2];
    const restored = await restoreDocVersion(spaceId, docPath, versionId, { updatedBy: restWriteActor(c) });
    if (!restored.ok) {
      return c.json(
        { error: restored.error, code: restored.errorCode },
        restored.errorCode === "NOT_FOUND" ? 404 : 409
      );
    }
    wsManager.broadcast(spaceId, {
      type: "doc_update",
      spaceId,
      docPath,
      data: {
        path: docPath,
        updatedAt: restored.updatedAt,
        provenance: restored.provenance,
      },
    });
    return c.json(restored);
  }

  // ── /restore handler ──
  if (rawPath.endsWith("/restore")) {
    const docPath = extractDocPath(rawPath, spaceId, "/restore");
    if (!docPath) {
      return c.json({ error: "Missing doc path", code: "BAD_REQUEST" }, 400);
    }

    const exists = await docExists(spaceId, docPath);
    const result = exists
      ? await setDocArchived(spaceId, docPath, false)
      : await setDocsArchivedByPrefix(spaceId, docPath, false);
    if (result.error) {
      return c.json({ error: result.error, code: "NOT_FOUND" }, 404);
    }

    invalidateSearchIndex();

    if ("paths" in result) {
      for (const path of result.paths) {
        wsManager.broadcast(spaceId, {
          type: "doc_update",
          spaceId,
          docPath: path,
          data: {
            path,
            archived: null,
          },
        });
      }
      return c.json({ ok: true, count: result.count, paths: result.paths });
    }

    wsManager.broadcast(spaceId, {
      type: "doc_update",
      spaceId,
      docPath,
      data: {
        path: docPath,
        archived: null,
      },
    });

    return c.json({ ok: true });
  }

  // ── /versions/checkpoint handler ──
  if (rawPath.endsWith("/versions/checkpoint")) {
    const denied = await requireHumanWorkspaceOwner()(c, async () => {});
    if (denied) return denied;
    const docPath = extractDocPath(rawPath, spaceId, "/versions/checkpoint");
    if (!docPath) {
      return c.json({ error: "Missing doc path", code: "BAD_REQUEST" }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = CheckpointSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message, code: "VALIDATION_ERROR" }, 400);
    }
    const provenance = await createManualDocCheckpoint(spaceId, docPath, parsed.data.label, "user");
    if (!provenance) return c.json({ error: "Document not found", code: "NOT_FOUND" }, 404);
    evictFreshness(spaceId, docPath);
    return c.json({ ok: true, provenance });
  }

  // ── /review handler — records a human review checkpoint. REST-only on
  // purpose: review is the human trust anchor, so it is never exposed over
  // MCP where an agent could mark its own writes as reviewed. ──
  if (rawPath.endsWith("/review")) {
    const denied = await requireHumanWorkspaceOwner()(c, async () => {});
    if (denied) return denied;
    const docPath = extractDocPath(rawPath, spaceId, "/review");
    if (!docPath) {
      return c.json({ error: "Missing doc path", code: "BAD_REQUEST" }, 400);
    }
    const provenance = await createDocReviewCheckpoint(spaceId, docPath, "user");
    if (!provenance) return c.json({ error: "Document not found", code: "NOT_FOUND" }, 404);
    evictFreshness(spaceId, docPath);
    const freshness = await getDocFreshness(spaceId, docPath, { provenance });
    wsManager.broadcast(spaceId, {
      type: "doc_update",
      spaceId,
      docPath,
      data: { path: docPath, provenance, freshness },
    });
    return c.json({ ok: true, provenance, freshness });
  }

  // ── /convert handler (markdown → BlockNote) ──
  if (rawPath.endsWith("/convert")) {
    const docPath = extractDocPath(rawPath, spaceId, "/convert");
    if (!docPath) {
      return c.json({ error: "Missing doc path", code: "BAD_REQUEST" }, 400);
    }

    const snapshot = await readDocSourceSnapshot(spaceId, docPath);
    const result = snapshot.result;
    if (result.error || result.data === null) {
      return c.json({ error: result.error ?? "Not found", code: "NOT_FOUND" }, 404);
    }

    if (result.storedAs !== "md" || !snapshot.revision) {
      return c.json({ error: "Document is already in BlockNote format", code: "ALREADY_JSON" }, 400);
    }

    const { markdownToBlocks } = await import("../markdown.ts");
    const blocks = await markdownToBlocks(result.data as string);

    const filePath = getDocPath(spaceId, docPath);
    suppressPath(filePath);
    try {
      const writeResult = await writeDoc(spaceId, docPath, blocks, {
        updatedBy: restWriteActor(c),
        source: "rest-api",
        reason: "Converted markdown document to BlockNote",
        sourceRevision: snapshot.revision,
        managedIdentity: true,
      });
      if (!writeResult.ok) {
        return c.json({ error: writeResult.error ?? "Write failed", code: "CONFLICT" }, 409);
      }
    } finally {
      setTimeout(() => unsuppressPath(filePath), 150);
    }

    await yjsManager.getOrCreateDoc(spaceId, docPath);

    const statResult = await docStat(spaceId, docPath);
    const provenance = await getDocProvenance(spaceId, docPath);
    wsManager.broadcast(spaceId, {
      type: "doc_update",
      spaceId,
      docPath,
      data: { path: docPath, updatedAt: statResult?.updatedAt ?? Date.now(), provenance },
    });

    return c.json({
      ok: true,
      path: docPath,
      format: "blocknote",
      storedAs: "json",
      blockCount: blocks.length,
      updatedAt: statResult?.updatedAt ?? Date.now(),
      provenance,
    });
  }

  // ── /convert-to-markdown handler (BlockNote → markdown) ──
  if (rawPath.endsWith("/convert-to-markdown")) {
    const docPath = extractDocPath(rawPath, spaceId, "/convert-to-markdown");
    if (!docPath) {
      return c.json({ error: "Missing doc path", code: "BAD_REQUEST" }, 400);
    }

    if (await getDocArchiveInfo(spaceId, docPath)) {
      return c.json({ error: "Archived docs cannot be converted", code: "ARCHIVED" }, 409);
    }

    const convertedState: {
      complete: boolean;
      updatedAt: number;
      provenance: DocProvenance | undefined;
    } = { complete: false, updatedAt: 0, provenance: undefined };
    const conversion = await yjsManager
      .withDocFormatTransition(spaceId, docPath, () =>
        convertDocToMarkdownStorage(spaceId, docPath, {
          updatedBy: restWriteActor(c),
          source: "rest-api",
          reason: "Converted rich doc to Markdown",
          managedIdentity: true,
          validateBeforeCommit: async (blocks) =>
            !(await getDocArchiveInfo(spaceId, docPath)) &&
            !(await hasUnportableAnnotationAnchors(
              spaceId,
              docPath,
              blocks
            )),
          onConverted: async () => {
            convertedState.complete = true;
            convertedState.updatedAt = Date.now();
            try {
              await yjsManager.deleteState(spaceId, docPath);
            } catch (error) {
              // The portable Markdown file and rotated browser cache are the
              // canonical state. A stale machine-local Yjs file is rejected by
              // its snapshot identity when this doc is edited again.
              console.error(
                `[docs] failed to remove Yjs state after converting ${spaceId}/${docPath}:`,
                error
              );
            }
            try {
              invalidateSearchIndex();
              evictFreshness(spaceId, docPath);
            } catch (error) {
              console.error(
                `[docs] failed to invalidate derived state after converting ${spaceId}/${docPath}:`,
                error
              );
            }
            const statResult = await docStat(spaceId, docPath);
            const provenance = await getDocProvenance(spaceId, docPath);
            convertedState.updatedAt = statResult?.updatedAt ?? Date.now();
            convertedState.provenance = provenance;
            try {
              wsManager.broadcast(spaceId, {
                type: "doc_update",
                spaceId,
                docPath,
                data: {
                  path: docPath,
                  format: "markdown",
                  storedAs: "md",
                  updatedAt: convertedState.updatedAt,
                  provenance,
                },
              });
            } catch (error) {
              console.error(
                `[docs] failed to broadcast Markdown conversion for ${spaceId}/${docPath}:`,
                error
              );
            }
          },
        })
      )
      .catch((error: unknown) => {
        if (error instanceof DocFormatTransitionConflictError) return null;
        throw error;
      });

    if (!conversion) {
      return c.json(
        { error: "Doc is already changing format", code: "CONFLICT" },
        409
      );
    }

    if (!conversion.ok) {
      if (conversion.errorCode === "NOT_FOUND") {
        return c.json(
          { error: conversion.error ?? "Doc not found", code: "NOT_FOUND" },
          404
        );
      }
      const incompatible = Boolean(conversion.lossyFields?.length);
      return c.json(
        {
          error: conversion.error ?? "Doc could not be converted to Markdown",
          code: incompatible ? "MARKDOWN_INCOMPATIBLE" : "CONFLICT",
        },
        incompatible ? 422 : 409
      );
    }

    if (!convertedState.complete) {
      throw new Error("Markdown conversion completed without transition state");
    }

    return c.json({
      ok: true,
      path: docPath,
      format: "markdown",
      storedAs: "md",
      updatedAt: convertedState.updatedAt,
      provenance: convertedState.provenance,
    });
  }

  return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
});

// GET /api/spaces/:spaceId/docs/* — read doc
docsRouter.get("/*", requireScope("docs:read"), async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  if (!spaceId) {
    return c.json({ error: "Missing spaceId", code: "BAD_REQUEST" }, 400);
  }

  const rawDocPath = extractDocPath(c.req.path, spaceId);

  if (rawDocPath.endsWith("/versions")) {
    const docPath = rawDocPath.slice(0, -"/versions".length);
    const checkpointsOnly = c.req.query("all") !== "true";
    const versions = await listDocVersions(spaceId, docPath, { checkpointsOnly });
    return c.json({ versions });
  }

  const versionMatch = rawDocPath.match(/^(.*)\/versions\/([^/]+)$/);
  if (versionMatch) {
    const [, docPath, versionId] = versionMatch;
    const version = await getDocVersion(spaceId, docPath, versionId);
    if (!version) return c.json({ error: "Version not found", code: "NOT_FOUND" }, 404);
    return c.json({ version });
  }

  const aliasResolution = await resolveDocAlias(
    spaceId,
    sanitizeDocPath(rawDocPath)
  );
  if (!aliasResolution.path) {
    return c.json(
      { error: aliasResolution.error ?? "Document alias resolution failed", code: "CONFLICT" },
      409
    );
  }
  const docPath = aliasResolution.path;

  if (!docPath) {
    return c.json({ error: "Missing doc path", code: "BAD_REQUEST" }, 400);
  }

  // For markdown export, flush any pending live (Yjs) edit first — otherwise
  // a copy clicked right after typing would return the previous debounce's
  // content instead of what the editor shows.
  if (c.req.query("format") === "markdown") {
    await yjsManager.flushPersist(spaceId, docPath);
  }

  const result = await readDoc(spaceId, docPath);
  if (result.error || result.data === null) {
    return c.json({ error: result.error ?? "Not found", code: "NOT_FOUND" }, 404);
  }

  // ?format=markdown — export the doc as a markdown string regardless of how
  // it is stored (md docs pass through; BlockNote docs convert lossily).
  if (c.req.query("format") === "markdown") {
    let markdown: string | null;
    if (result.storedAs === "md") {
      markdown = String(result.data ?? "");
    } else {
      const { blocksToMarkdownSafe } = await import("../markdown.ts");
      markdown = await blocksToMarkdownSafe(Array.isArray(result.data) ? result.data : []);
    }
    if (markdown === null) {
      return c.json(
        { error: "Document could not be converted to markdown", code: "CONVERSION_FAILED" },
        422
      );
    }
    return c.json({ path: docPath, markdown });
  }

  const statResult = await docStat(spaceId, docPath);
  const archived = await getDocArchiveInfo(spaceId, docPath);
  const provenance = await getDocProvenance(spaceId, docPath);
  const freshness = await getDocFreshness(spaceId, docPath, { provenance });
  const { links, backlinks } = await getDocLinks(spaceId, docPath);
  const collaborationEpoch = await getWorkspaceCollaborationEpoch();
  const collaborationCacheEpoch = await getDocCollaborationCacheEpoch(
    spaceId,
    docPath
  );
  const collaborationCacheEpochHistory =
    await getDocCollaborationCacheEpochHistory(spaceId, docPath);
  const markdownCompatible =
    result.storedAs === "json" &&
    Array.isArray(result.data) &&
    (await prepareMarkdownStorageConversion(result.data)).safe &&
    !(await hasUnportableAnnotationAnchors(spaceId, docPath, result.data));

  return c.json({
    path: docPath,
    content: result.data,
    format: result.format,
    storedAs: result.storedAs,
    updatedAt: statResult?.updatedAt ?? Date.now(),
    archived,
    provenance,
    freshness,
    collaborationEpoch,
    collaborationCacheEpoch,
    collaborationCacheEpochHistory,
    markdownCompatible,
    links,
    backlinks,
  });
});

// PUT /api/spaces/:spaceId/docs/* — create/update doc
docsRouter.put("/*", requireScope("docs:write"), async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  if (!spaceId) {
    return c.json({ error: "Missing spaceId", code: "BAD_REQUEST" }, 400);
  }

  const docPath = extractDocPath(c.req.path, spaceId);

  if (!docPath) {
    return c.json({ error: "Missing doc path", code: "BAD_REQUEST" }, 400);
  }

  const body = await c.req.json().catch(() => null);
  if (!body) {
    return c.json({ error: "Invalid JSON body", code: "INVALID_BODY" }, 400);
  }

  const parsed = WriteDocSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.message, code: "VALIDATION_ERROR" }, 400);
  }

  const filePath = getDocPath(spaceId, docPath);
  suppressPath(filePath);
  try {
    const result = await writeDoc(spaceId, docPath, parsed.data.content, {
      updatedBy: restWriteActor(c),
      source: "rest-api",
      managedIdentity: true,
    });
    if (!result.ok) {
      return c.json({ error: result.error ?? "Write failed", code: "CONFLICT" }, 409);
    }
  } finally {
    setTimeout(() => unsuppressPath(filePath), 150);
  }

  // Update in-memory Y.Doc if loaded (broadcasts to connected editors via Yjs).
  // Sync from the CANONICAL on-disk blocks, not the raw request content —
  // writeDoc canonicalizes (ids, default props), and pushing the raw blocks
  // would give the live doc a different id set than the file, detaching
  // annotation anchors and forcing a spurious follow-up persist.
  if (Array.isArray(parsed.data.content)) {
    const written = await readDoc(spaceId, docPath);
    if (!written.error && Array.isArray(written.data)) {
      await yjsManager.replaceContent(spaceId, docPath, written.data);
    }
  }

  // Pre-warm Yjs state for new docs not yet loaded in memory
  if (!yjsManager.isLoaded(spaceId, docPath)) {
    await yjsManager.getOrCreateDoc(spaceId, docPath);
  }

  const statResult = await docStat(spaceId, docPath);
  const provenance = await getDocProvenance(spaceId, docPath);

  // Broadcast doc_update via space WS for sidebar list awareness
  // (content sync is handled by Yjs, this is just for doc list refresh)
  wsManager.broadcast(spaceId, {
    type: "doc_update",
    spaceId,
    docPath,
    data: {
      path: docPath,
      updatedAt: statResult?.updatedAt ?? Date.now(),
      provenance,
    },
  });

  return c.json({
    path: docPath,
    updatedAt: statResult?.updatedAt ?? Date.now(),
    archived: await getDocArchiveInfo(spaceId, docPath),
    provenance,
  });
});

// DELETE /api/spaces/:spaceId/docs/* — delete doc
docsRouter.delete("/*", requireScope("docs:write"), async (c) => {
  const spaceId = c.req.param("spaceId") ?? "";
  if (!spaceId) {
    return c.json({ error: "Missing spaceId", code: "BAD_REQUEST" }, 400);
  }

  const docPath = extractDocPath(c.req.path, spaceId);

  if (!docPath) {
    return c.json({ error: "Missing doc path", code: "BAD_REQUEST" }, 400);
  }

  const filePath = getDocPath(spaceId, docPath);
  suppressPath(filePath);
  try {
    const deleteResult = await deleteDoc(spaceId, docPath);
    if (deleteResult.error) {
      return c.json({ error: deleteResult.error, code: "CONFLICT" }, 409);
    }
    if (deleteResult.notFound) {
      return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    }
  } finally {
    setTimeout(() => unsuppressPath(filePath), 150);
  }

  // Broadcast deletion via WS
  wsManager.broadcast(spaceId, {
    type: "doc_deleted",
    spaceId,
    docPath,
  });

  return c.json({ ok: true });
});
