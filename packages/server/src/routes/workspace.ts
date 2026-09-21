import { Hono } from "hono"
import type { Context } from "hono"
import {
  ensureWorkspaceManifest,
  getWorkspaceRoot,
  workspaceProvenanceMode,
  writeWorkspaceManifest,
  type WorkspaceManifest,
} from "../workspace.ts"
import { canManageUserSettings, isLocalOwner } from "../auth.ts"
import { hasScope } from "../token-store.ts"
import {
  appendWorkspaceImportChunk,
  createWorkspaceExportJob,
  createWorkspaceImportJob,
  getCurrentWorkspaceExportJob,
  getCurrentWorkspaceImportJob,
  getWorkspaceExportJob,
  getWorkspaceImportJob,
  openWorkspaceExportDownload,
  prepareWorkspaceImportJob,
  replaceWorkspaceImportJob,
  waitForWorkspaceExportJob,
  WORKSPACE_TRANSFER_CHUNK_BYTES,
  type WorkspaceTransferJob,
} from "../workspace-transfer-jobs.ts"
import type { WorkspaceExportHistoryPolicy } from "../workspace-transfer-v2.ts"

export const workspaceRouter = new Hono()

const MAX_NAME_LENGTH = 200
const LEGACY_EXPORT_WAIT_MS = 15_000
let legacyExportWaitMsForTests: number | null = null

export function setLegacyWorkspaceExportWaitMsForTests(
  milliseconds: number | null
): void {
  legacyExportWaitMsForTests = milliseconds
}

/**
 * The manifest fields the read/write surface exposes to clients. The
 * machine-local filesystem path (`root`) is owner + same-origin only: scoped
 * agent bearers and cross-origin wildcard-CORS reads get portable workspace
 * metadata, not the host's directory layout (which can leak usernames). The
 * owner Settings UI is the only consumer that needs it.
 */
function publicView(m: WorkspaceManifest, opts: { includeRoot: boolean }) {
  return {
    id: m.id,
    name: m.name,
    createdAt: m.createdAt,
    storageVersion: m.version,
    mode: workspaceProvenanceMode(m),
    provenance: m.provenance ?? null,
    onboarding: {
      status: m.onboarding?.status ?? "complete",
    },
    // `publicUrl` is deliberately absent: the configured public origin is
    // machine-local (settings-store `network.publicUrl`), not portable workspace
    // metadata. See GET/PUT /api/system/settings.
    root: opts.includeRoot ? getWorkspaceRoot() : null,
  }
}

function sameOriginOrNonBrowserRequest(c: Context): boolean {
  const fetchSite = c.req.header("Sec-Fetch-Site")?.trim().toLowerCase()
  if (fetchSite === "cross-site" || fetchSite === "same-site") return false
  const origin = c.req.header("Origin")?.trim()
  if (!origin) {
    if (fetchSite === "same-origin" || fetchSite === "none") return true
    // A real browser supplies Fetch Metadata on trustworthy HTTP(S) origins.
    // If only part of that provenance is present, fail closed; requests with
    // no browser metadata remain available to authenticated CLI/Desktop HTTP.
    return !c.req.header("Sec-Fetch-Mode") && !c.req.header("Sec-Fetch-Dest")
  }
  try {
    const originHost = new URL(origin).host
    const forwardedHost = c.req
      .header("X-Forwarded-Host")
      ?.split(",")[0]
      ?.trim()
    if (forwardedHost && originHost === forwardedHost) return true
    return originHost === new URL(c.req.url).host
  } catch {
    return false
  }
}

function hasExplicitBearerAuthorization(c: Context): boolean {
  const header = c.req.header("Authorization")
  return Boolean(
    header?.startsWith("Bearer ") &&
    header.slice("Bearer ".length).trim().length > 0
  )
}

function canReadWorkspaceRoot(c: Context): boolean {
  return isLocalOwner(c) && sameOriginOrNonBrowserRequest(c)
}

/**
 * Read-only workspace identity + provenance. `mode` is normalized (an absent or
 * unrecognized provenance block reports "daily"); `provenance` carries the detail
 * (source label/path, snapshotAt, one-way/disposable flags) for non-daily workspaces.
 */
workspaceRouter.get("/", (c) => {
  return c.json(
    publicView(ensureWorkspaceManifest(), {
      includeRoot: canReadWorkspaceRoot(c),
    })
  )
})

function transferView(job: WorkspaceTransferJob) {
  const manifest = job.manifest
    ? {
        exportId: job.manifest.exportId,
        exportedAt: job.manifest.exportedAt,
        source: job.manifest.source,
        history: job.manifest.history,
        viewer: job.manifest.viewer,
        contentCheckpoint: job.manifest.integrity.contentCheckpoint,
        files: job.manifest.integrity.files.length,
        bytes: job.manifest.integrity.files.reduce(
          (sum, file) => sum + file.size,
          0
        ),
      }
    : undefined
  if (job.kind === "export") {
    const { manifest: _manifest, ...publicJob } = job
    void _manifest
    return { ...publicJob, manifest }
  }
  const {
    preparation: _preparation,
    prepared,
    manifest: _manifest,
    ...publicJob
  } = job
  void _preparation
  void _manifest
  return {
    ...publicJob,
    manifest,
    prepared: prepared
      ? {
          source: prepared.source,
          exportedAt: prepared.exportedAt,
          history: prepared.history,
          contentCheckpoint: prepared.contentCheckpoint,
          files: prepared.files,
          bytes: prepared.bytes,
        }
      : undefined,
  }
}

function transferOwner(c: Context): Response | null {
  return canManageUserSettings(c) &&
    c.get("identity")?.principal.type === "human" &&
    // A bare loopback request inherits the implicit owner identity. Browser
    // requests using that identity must be same-origin on every transfer
    // endpoint; explicit authenticated tooling remains usable cross-origin.
    (hasExplicitBearerAuthorization(c) || sameOriginOrNonBrowserRequest(c))
    ? null
    : c.json({ error: "Forbidden", required: "human owner" }, 403)
}

function workspaceExportReader(c: Context): Response | null {
  const identity = c.get("identity")
  return identity?.principal.type === "human" &&
    hasScope(identity.scopes, "workspace:export") &&
    (hasExplicitBearerAuthorization(c) || sameOriginOrNonBrowserRequest(c))
    ? null
    : c.json({ error: "Forbidden", required: "human + workspace:export" }, 403)
}

function transferError(c: Context, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error)
  const status = message.includes("not found")
    ? 404
    : message.includes("not ready") ||
        message.includes("not accepting") ||
        message.includes("has not been prepared")
      ? 409
      : 400
  return c.json({ error: message, code: "WORKSPACE_TRANSFER_FAILED" }, status)
}

function downloadDisposition(name: string): string {
  const fallback = name
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/["\\]/g, "_")
    .trim()
  return `attachment; filename="${fallback || "workspace.wtb"}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

function isBrowserNavigation(c: Context): boolean {
  if (hasExplicitBearerAuthorization(c)) return false
  return (
    c.req.header("Sec-Fetch-Mode")?.trim().toLowerCase() === "navigate" ||
    c.req
      .header("Accept")
      ?.split(",")
      .some((value) => value.trim().split(";")[0] === "text/html") === true
  )
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

function pendingWorkspaceExportNavigation(
  c: Context,
  nextUrl: string
): Response {
  const safeNextUrl = escapeHtmlAttribute(nextUrl)
  c.header("Retry-After", "1")
  c.header("Refresh", `1; url=${nextUrl}`)
  c.header("Cache-Control", "private, no-store")
  c.header("Referrer-Policy", "same-origin")
  c.header("X-Content-Type-Options", "nosniff")
  c.header(
    "Content-Security-Policy",
    "default-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  )
  return c.html(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="1; url=${safeNextUrl}">
<title>Preparing workspace export</title>
</head>
<body>
<main>
<h1>Preparing your workspace export</h1>
<p>Your download will start automatically. <a href="${safeNextUrl}">Try again</a> if it does not.</p>
</main>
</body>
</html>`,
    202
  )
}

function parseHistory(body: unknown): WorkspaceExportHistoryPolicy {
  if (!body || typeof body !== "object" || !("history" in body)) {
    return { mode: "all" }
  }
  const history = (body as { history?: unknown }).history
  if (!history || typeof history !== "object" || !("mode" in history)) {
    throw new Error("history policy is invalid")
  }
  const candidate = history as {
    mode?: unknown
    maxAgeDays?: unknown
    maxPerItem?: unknown
  }
  if (candidate.mode === "all" || candidate.mode === "none") {
    return { mode: candidate.mode }
  }
  if (
    candidate.mode === "age" &&
    Number.isInteger(candidate.maxAgeDays) &&
    Number(candidate.maxAgeDays) >= 1 &&
    Number(candidate.maxAgeDays) <= 36_500
  ) {
    return { mode: "age", maxAgeDays: Number(candidate.maxAgeDays) }
  }
  if (
    candidate.mode === "count" &&
    Number.isInteger(candidate.maxPerItem) &&
    Number(candidate.maxPerItem) >= 1 &&
    Number(candidate.maxPerItem) <= 10_000
  ) {
    return { mode: "count", maxPerItem: Number(candidate.maxPerItem) }
  }
  throw new Error("history policy is invalid")
}

async function readWorkspaceImportChunk(
  request: Request,
  expectedBytes: number
): Promise<Uint8Array> {
  const contentLength = request.headers.get("Content-Length")
  if (contentLength !== null) {
    if (
      !/^\d+$/.test(contentLength) ||
      Number(contentLength) !== expectedBytes
    ) {
      throw new Error("workspace import chunk length is invalid")
    }
  }
  if (!request.body) {
    throw new Error("workspace import chunk body is required")
  }

  const output = new Uint8Array(expectedBytes)
  const reader = request.body.getReader()
  let offset = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (offset + value.byteLength > expectedBytes) {
        await reader.cancel()
        throw new Error("workspace import chunk exceeds its declared range")
      }
      output.set(value, offset)
      offset += value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  if (offset !== expectedBytes) {
    throw new Error("workspace import chunk length is invalid")
  }
  return output
}

workspaceRouter.post("/transfers/exports", async (c) => {
  const forbidden = transferOwner(c)
  if (forbidden) return forbidden
  try {
    const body = await c.req.json().catch(() => ({}))
    const job = await createWorkspaceExportJob(parseHistory(body))
    return c.json(transferView(job), 202)
  } catch (error) {
    return transferError(c, error)
  }
})

workspaceRouter.get("/transfers/exports/current", async (c) => {
  const forbidden = transferOwner(c)
  if (forbidden) return forbidden
  try {
    const job = await getCurrentWorkspaceExportJob()
    return c.json({ job: job ? transferView(job) : null })
  } catch (error) {
    return transferError(c, error)
  }
})

workspaceRouter.get("/transfers/exports/:id", async (c) => {
  const forbidden = workspaceExportReader(c)
  if (forbidden) return forbidden
  try {
    return c.json(transferView(await getWorkspaceExportJob(c.req.param("id"))))
  } catch (error) {
    return transferError(c, error)
  }
})

workspaceRouter.get("/transfers/exports/:id/download", async (c) => {
  const forbidden = workspaceExportReader(c)
  if (forbidden) return forbidden
  try {
    const id = c.req.param("id")
    const job = await getWorkspaceExportJob(id)
    if (
      isBrowserNavigation(c) &&
      (job.state === "queued" || job.state === "running")
    ) {
      return pendingWorkspaceExportNavigation(
        c,
        `/api/workspace/transfers/exports/${encodeURIComponent(id)}/download`
      )
    }
    const download = await openWorkspaceExportDownload(id)
    return new Response(download.body, {
      headers: {
        "Content-Type": "application/vnd.worktable.workspace+zip",
        "Content-Length": String(download.job.bytes),
        "Content-Disposition": downloadDisposition(
          download.job.downloadName ?? "workspace.wtb"
        ),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    })
  } catch (error) {
    return transferError(c, error)
  }
})

workspaceRouter.post("/transfers/imports", async (c) => {
  const forbidden = transferOwner(c)
  if (forbidden) return forbidden
  try {
    const body = (await c.req.json()) as {
      fileName?: unknown
      bytes?: unknown
      resumeFingerprint?: unknown
      sha256?: unknown
    }
    if (
      typeof body.fileName !== "string" ||
      typeof body.bytes !== "number" ||
      (body.resumeFingerprint !== undefined &&
        typeof body.resumeFingerprint !== "string") ||
      (body.sha256 !== undefined && typeof body.sha256 !== "string")
    ) {
      throw new Error(
        "fileName, bytes, and optional resumeFingerprint and sha256 are required"
      )
    }
    const job = await createWorkspaceImportJob({
      fileName: body.fileName,
      bytes: body.bytes,
      ...(body.resumeFingerprint
        ? { resumeFingerprint: body.resumeFingerprint }
        : {}),
      ...(body.sha256 ? { sha256: body.sha256 } : {}),
    })
    return c.json(
      {
        ...transferView(job),
        chunkBytes: WORKSPACE_TRANSFER_CHUNK_BYTES,
      },
      201
    )
  } catch (error) {
    return transferError(c, error)
  }
})

workspaceRouter.get("/transfers/imports/current", async (c) => {
  const forbidden = transferOwner(c)
  if (forbidden) return forbidden
  try {
    const job = await getCurrentWorkspaceImportJob()
    return c.json({
      job: job
        ? {
            ...transferView(job),
            chunkBytes: WORKSPACE_TRANSFER_CHUNK_BYTES,
          }
        : null,
    })
  } catch (error) {
    return transferError(c, error)
  }
})

workspaceRouter.put("/transfers/imports/:id/content", async (c) => {
  const forbidden = transferOwner(c)
  if (forbidden) return forbidden
  try {
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
      c.req.header("Content-Range") ?? ""
    )
    if (!range) throw new Error("a valid Content-Range header is required")
    const start = Number(range[1])
    const end = Number(range[2])
    const total = Number(range[3])
    const declaredBytes = end - start + 1
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      !Number.isSafeInteger(total) ||
      start < 0 ||
      end < start ||
      total < 1 ||
      end >= total ||
      declaredBytes < 1 ||
      declaredBytes > WORKSPACE_TRANSFER_CHUNK_BYTES
    ) {
      throw new Error("workspace import chunk range is invalid")
    }
    const bytes = await readWorkspaceImportChunk(c.req.raw, declaredBytes)
    const job = await appendWorkspaceImportChunk({
      id: c.req.param("id"),
      start,
      total,
      bytes,
    })
    return c.json(transferView(job))
  } catch (error) {
    return transferError(c, error)
  }
})

workspaceRouter.get("/transfers/imports/:id", async (c) => {
  const forbidden = transferOwner(c)
  if (forbidden) return forbidden
  try {
    return c.json(transferView(await getWorkspaceImportJob(c.req.param("id"))))
  } catch (error) {
    return transferError(c, error)
  }
})

workspaceRouter.post("/transfers/imports/:id/prepare", async (c) => {
  const forbidden = transferOwner(c)
  if (forbidden) return forbidden
  try {
    const job = await prepareWorkspaceImportJob(c.req.param("id"))
    return c.json(transferView(job))
  } catch (error) {
    return transferError(c, error)
  }
})

workspaceRouter.post("/transfers/imports/:id/replace", async (c) => {
  const forbidden = transferOwner(c)
  if (forbidden) return forbidden
  try {
    const body = (await c.req.json().catch(() => null)) as {
      confirmation?: unknown
    } | null
    if (body?.confirmation !== "replace") {
      throw new Error('confirmation must be exactly "replace"')
    }
    const job = await replaceWorkspaceImportJob(c.req.param("id"))
    return c.json(transferView(job), 202)
  } catch (error) {
    return transferError(c, error)
  }
})

/** Download the same standard ZIP package the local CLI writes. Human + explicit scope. */
workspaceRouter.get("/export", async (c) => {
  const identity = c.get("identity")
  if (
    identity.principal.type !== "human" ||
    !hasScope(identity.scopes, "workspace:export") ||
    // Bare loopback requests inherit the implicit owner identity for local
    // compatibility. They must still be same-origin (or non-browser) before
    // receiving the whole workspace; an explicit bearer remains usable by
    // authorized cross-origin tooling.
    (!hasExplicitBearerAuthorization(c) && !sameOriginOrNonBrowserRequest(c))
  ) {
    return c.json(
      { error: "Forbidden", required: "human + workspace:export" },
      403
    )
  }
  try {
    const created = await createWorkspaceExportJob({ mode: "all" })
    const job = await waitForWorkspaceExportJob(created.id, {
      timeoutMs: legacyExportWaitMsForTests ?? LEGACY_EXPORT_WAIT_MS,
    })
    if (job.state === "queued" || job.state === "running") {
      const statusUrl = `/api/workspace/transfers/exports/${encodeURIComponent(job.id)}`
      const downloadUrl = `${statusUrl}/download`
      c.header("Location", statusUrl)
      c.header("Retry-After", "1")
      c.header("Cache-Control", "private, no-store")
      if (isBrowserNavigation(c)) {
        return pendingWorkspaceExportNavigation(c, downloadUrl)
      }
      return c.json(
        {
          ...transferView(job),
          statusUrl,
          downloadUrl,
        },
        202
      )
    }
    if (job.state !== "complete") {
      throw new Error(job.error ?? "workspace export failed")
    }
    const download = await openWorkspaceExportDownload(job.id)
    return new Response(download.body, {
      headers: {
        "Content-Type": "application/vnd.worktable.workspace+zip",
        "Content-Length": String(job.bytes),
        "Content-Disposition": downloadDisposition(
          job.downloadName ?? "workspace.wtb"
        ),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    })
  } catch (err) {
    return c.json({ error: (err as Error).message, code: "EXPORT_FAILED" }, 422)
  }
})

/**
 * Update portable workspace metadata. Owner-only (same gate as
 * POST /api/system/update). Accepts a partial `{ name? }`; every other manifest
 * field (id, createdAt, provenance, cloud, …) is preserved byte-for-byte because
 * we merge into the full manifest before writing.
 *
 * `name` — non-empty trimmed string, max 200 chars.
 *
 * The public origin is NOT set here — it is machine-local
 * (PUT /api/system/settings, `network.publicUrl`), not portable workspace
 * metadata. An unknown key (e.g. a stale `publicUrl`) is simply ignored.
 *
 * No workspace-level change event exists in the watcher/ws path today (ws.ts
 * emits space/doc/widget/record/annotation events only, keyed by spaceId — the
 * manifest is not a spaces-tree entry). Rather than invent an ad-hoc signal,
 * rename consumers refetch GET /api/workspace on demand.
 */
// Serialize manifest read→merge→write: two close-together PUTs would otherwise
// both merge from the same snapshot and the later write would revert the other's
// field. Same pattern as settings-store; a rejected predecessor must not poison
// the chain.
let manifestWriteChain: Promise<unknown> = Promise.resolve()

function chainManifestWrite<T>(fn: () => Promise<T> | T): Promise<T> {
  const run = manifestWriteChain.then(
    () => fn(),
    () => fn()
  )
  manifestWriteChain = (run as Promise<unknown>).catch(() => undefined)
  return run
}

workspaceRouter.put("/", async (c) => {
  if (!canManageUserSettings(c)) {
    return c.json({ error: "Forbidden", required: "owner" }, 403)
  }

  const body = (await c.req.json().catch(() => null)) as {
    name?: unknown
    onboarding?: unknown
  } | null
  if (!body || typeof body !== "object") {
    return c.json({ error: "Expected a JSON object body" }, 400)
  }

  return chainManifestWrite(() => applyWorkspacePatch(c, body))
})

function applyWorkspacePatch(
  c: Context,
  body: { name?: unknown; onboarding?: unknown }
) {
  const current = ensureWorkspaceManifest()
  const next: WorkspaceManifest = { ...current }

  if (body.name !== undefined) {
    if (typeof body.name !== "string") {
      return c.json({ error: "name must be a string" }, 400)
    }
    const trimmed = body.name.trim()
    if (trimmed === "") {
      return c.json({ error: "name must not be empty" }, 400)
    }
    if (trimmed.length > MAX_NAME_LENGTH) {
      return c.json(
        { error: `name must be at most ${MAX_NAME_LENGTH} characters` },
        400
      )
    }
    next.name = trimmed
  }

  if (body.onboarding !== undefined) {
    if (
      !body.onboarding ||
      typeof body.onboarding !== "object" ||
      Array.isArray(body.onboarding) ||
      (body.onboarding as Record<string, unknown>)["status"] !== "complete"
    ) {
      return c.json({ error: 'onboarding.status must be "complete"' }, 400)
    }
    next.onboarding = {
      version: 1,
      status: "complete",
      completedAt: current.onboarding?.completedAt ?? new Date().toISOString(),
    }
  }

  writeWorkspaceManifest(next)
  // Hosted browser owners may rename but never receive the filesystem root.
  // Local owners retain the existing owner-gated PUT response.
  return c.json(publicView(next, { includeRoot: isLocalOwner(c) }))
}
