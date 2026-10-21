import { createHash } from "node:crypto"
import type { Context } from "hono"
import { z } from "zod"
import { CanonicalIdSchema } from "@worktable/types"
import {
  SHARE_CAPABILITY_HEADER,
  SHARE_UNLOCK_HEADER,
} from "@worktable/hosted-contract"
import { sharingPreviewEnabled } from "./sharing-preview.ts"
import {
  resolveShareLinkView,
  shareLinkStillOpens,
} from "./share-link-views.ts"
import { ShareLinksStoreError } from "./share-links-store.ts"
import { canonicalJson } from "./link-grant-view.ts"
import { effectiveLinkGrant } from "./link-grant.ts"
import { queryRecordsForLink } from "./link-query.ts"
import { linkReadPool } from "./link-read-pool.ts"
import { linkReadMemo } from "./link-read-memo.ts"
import { linkChangeJournal } from "./link-change-journal.ts"
import { linkSchemaGeneration } from "./link-schema-generation.ts"
import { LinkToolChanged, readLinkTool } from "./link-tool.ts"
import { workspaceCacheKey } from "./workspace.ts"
import { recordIndex, recordIndexEnabled } from "./record-index.ts"
import { listRecords, readWidgetState } from "./record-store.ts"
import { workspaceGeneration, spaceGeneration } from "./workspace-read-model.ts"
import { runAsLinkVisitor, withLinkGrantRead } from "./team-policy.ts"

class LinkRecordsBusy extends Error {
  override name = "LinkRecordsBusy"
}

const Call = z.discriminatedUnion("op", [
  z.strictObject({ v: z.literal(1), op: z.literal("ping") }),
  z.strictObject({
    v: z.literal(1),
    op: z.literal("records.query"),
    collection: CanonicalIdSchema,
    query: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({ v: z.literal(1), op: z.literal("state.read") }),
  z.strictObject({
    v: z.literal(1),
    op: z.literal("changes"),
    since: z.string().max(256).optional(),
  }),
])
const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
}
function failure(
  code: string,
  status: number,
  message: string,
  retryAfter?: string
): Response {
  return new Response(JSON.stringify({ ok: false, error: { code, message } }), {
    status,
    headers: {
      ...HEADERS,
      ...(retryAfter ? { "Retry-After": retryAfter } : {}),
    },
  })
}
const unavailable = () =>
  failure("LINK_UNAVAILABLE", 404, "This link isn't available.")
const busy = () => failure("LINK_BUSY", 429, "Try again in a moment.", "1")
const invalid = () => failure("INVALID_QUERY", 400, "This request isn't valid.")

function shallowEnough(value: unknown): boolean {
  const pending: Array<[unknown, number]> = [[value, 0]]
  while (pending.length) {
    const [next, depth] = pending.pop()!
    if (depth > 32) return false
    if (next && typeof next === "object")
      for (const child of Object.values(next)) pending.push([child, depth + 1])
  }
  return true
}

async function readCall(
  request: Request,
  deadline: number
): Promise<z.infer<typeof Call> | null> {
  const reader = request.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let size = 0
  let expired = false
  const timer = setTimeout(
    () => {
      expired = true
      void reader.cancel().catch(() => undefined)
    },
    Math.max(0, deadline - Date.now())
  )
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (expired) return null
      if (done) break
      size += value.byteLength
      if (size > 16 * 1024) {
        void reader.cancel().catch(() => undefined)
        return null
      }
      chunks.push(value)
    }
    const body = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      body.set(chunk, offset)
      offset += chunk.byteLength
    }
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(body)
    )
    if (!shallowEnough(value)) return null
    const parsed = Call.safeParse(value)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    reader.releaseLock()
  }
}

/** Only bearer-link authority is read. Cookies and member credentials have no role. */
export function linkBridge(getShareOrigin: () => string | null) {
  return async (c: Context): Promise<Response> => {
    const origin = getShareOrigin()
    if (!origin || !sharingPreviewEnabled()) return unavailable()
    // The authenticated gateway checks browser Origin before forwarding. Direct
    // browser attempts to this closed surface still cannot widen that origin.
    if (c.req.header("Origin") && c.req.header("Origin") !== origin)
      return unavailable()
    if (
      (c.req.header("Content-Type") ?? "")
        .split(";", 1)[0]
        ?.trim()
        .toLowerCase() !== "application/json"
    )
      return invalid()
    let release: (() => void) | null = null
    try {
      const view = await resolveShareLinkView(
        c.req.header(SHARE_CAPABILITY_HEADER) ?? "",
        { unlock: c.req.header(SHARE_UNLOCK_HEADER), revision: false }
      )
      if (view === "password-required")
        return failure(
          "PASSWORD_REQUIRED",
          401,
          "This document needs a password."
        )
      if (!view || typeof view === "string" || !view.link.grant)
        return unavailable()
      release = await linkReadPool.acquire(view.link.id)
      if (!release) return busy()
      const deadline = Date.now() + 1500
      const call = await readCall(c.req.raw, deadline)
      if (!call) return Date.now() >= deadline ? busy() : invalid()
      if (!sharingPreviewEnabled()) return unavailable()
      let result: unknown = {}
      let refused: Response | null = null
      let changed = false
      if (call.op !== "ping") {
        const generation = workspaceGeneration()
        const tool = await readLinkTool(view)
        if (!tool || !tool.permissions) return unavailable()
        const policy = view.policy
        const grant = effectiveLinkGrant(
          view.link.grant,
          tool.permissions,
          policy
        )
        const authorization = createHash("sha256")
          .update(
            canonicalJson([
              view.link.grantRevision,
              view.link.passwordRevision,
              view.policyRevision,
              tool.permissions,
              [...tool.schemas],
            ])
          )
          .digest("hex")
        linkChangeJournal.touch({
          id: view.link.id,
          spaceId: view.link.spaceId,
          authorization,
          grant,
          schemas: tool.schemas,
          key: tool.key,
        })
        const key = createHash("sha256")
          .update(
            canonicalJson([
              workspaceCacheKey(),
              view.link.id,
              view.link.grantRevision,
              view.link.passwordRevision,
              generation,
              tool.schemaGeneration,
              policy,
              call,
            ])
          )
          .digest("hex")
        if (call.op === "records.query") {
          const response = await queryRecordsForLink(
            {
              linkId: view.link.id,
              spaceId: view.link.spaceId,
              path: view.path,
              grant: view.link.grant,
              linkKey: tool.key,
            },
            call.collection,
            call.query,
            {
              policy,
              permissions: tool.permissions,
              schemas: tool.schemas,
              loadRows: async (collection) => {
                if (!recordIndexEnabled())
                  return listRecords(view.link.spaceId, collection, {
                    includeArchived: false,
                  })
                const rows = recordIndex.listCollection(
                  view.link.spaceId,
                  collection,
                  false
                )
                if (rows === null) throw new LinkRecordsBusy()
                return rows
              },
              memo: (load, rows) => linkReadMemo.read(`${key}:${rows}`, load),
            }
          )
          if (response.status !== 200)
            refused = failure(
              response.body.code === "LINK_LIMIT"
                ? "LINK_QUERY_BUDGET"
                : response.body.code,
              response.status,
              response.body.error,
              response.headers?.["Retry-After"]
            )
          else {
            result = response.body
            linkChangeJournal.served(
              view.link.id,
              call.collection,
              response.body
            )
          }
        } else if (call.op === "state.read") {
          if (grant.state !== "team-read")
            refused = failure(
              "LINK_FORBIDDEN",
              403,
              "This link can't read that."
            )
          else
            result = {
              state: await linkReadMemo.read(key, () =>
                runAsLinkVisitor(() =>
                  withLinkGrantRead(view.link.spaceId, () =>
                    readWidgetState(view.link.spaceId, view.path)
                  )
                )
              ),
            }
        } else {
          result = linkChangeJournal.changes(view.link.id, call.since)
        }
        changed =
          workspaceGeneration() !== generation ||
          spaceGeneration(view.link.spaceId) !== tool.generation ||
          linkSchemaGeneration(view.link.spaceId) !== tool.schemaGeneration
      }
      if (
        !sharingPreviewEnabled() ||
        !shareLinkStillOpens(view.link, view.policyRevision)
      )
        return unavailable()
      if (changed || Date.now() > deadline) return busy()
      if (refused) return refused
      const body = JSON.stringify({ ok: true, result })
      return Buffer.byteLength(body) > 1024 * 1024
        ? failure("LINK_BUSY", 503, "This result is too large.", "1")
        : new Response(body, { headers: HEADERS })
    } catch (error) {
      if (error instanceof LinkToolChanged) return busy()
      if (error instanceof ShareLinksStoreError) return unavailable()
      if (error instanceof LinkRecordsBusy)
        return failure("LINK_BUSY", 503, "Try again in a moment.", "1")
      console.error(
        "[share-bridge] read failed",
        error instanceof Error ? error.name : "error"
      )
      return failure("LINK_BUSY", 503, "Try again in a moment.", "1")
    } finally {
      release?.()
    }
  }
}
