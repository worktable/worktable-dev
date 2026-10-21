// ============================================================
// Shared in-flight list reads
// ============================================================
//
// Identical list requests that arrive while one is being computed share its
// result instead of computing it again. A request joins only a computation
// for the same route, query, principal and scopes that started at the same
// workspace generation, so a request made after a write never receives a
// result computed before it.

import type { MiddlewareHandler } from "hono"
import type { TokenIdentity } from "./token-store.ts"
import { currentTeamWorktable } from "./team-database.ts"
import { memberAccess } from "./team-access.ts"
import { visitorCommentGeneration } from "./visitor-comment-store.ts"
import {
  noteWorkspaceActivity,
  workspaceGeneration,
} from "./workspace-read-model.ts"

const SHARED_READ_ROUTES = [
  /^\/api\/spaces\/?$/,
  /^\/api\/spaces\/[^/]+\/documents\/?$/,
  /^\/api\/recent\/?$/,
  /^\/api\/activity\/?$/,
  /^\/api\/pending\/?$/,
  /^\/api\/threads\/?$/,
]

interface SharedResponse {
  contentType: string | null
  body: string
}

const inFlight = new Map<string, Promise<SharedResponse | null>>()

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function sharedReadKey(url: URL, identity: TokenIdentity | undefined): string {
  // Reads are shared only within one principal: some responses are per
  // person. A member's access fingerprint, not the team-wide revision, fences
  // a read that started before their access changed.
  const memberId = identity?.team?.memberId
  const team = currentTeamWorktable()
  return JSON.stringify([
    workspaceGeneration(),
    // Private edits do not invalidate ordinary workspace reads. Pending for a
    // person must still fence a response computed before the private commit.
    /^\/api\/pending\/?$/.test(url.pathname) &&
    identity?.agent === null &&
    identity.principal.type === "human" &&
    !identity.operatorVerification
      ? visitorCommentGeneration()
      : null,
    team
      ? memberId && identity?.principal.type === "human"
        ? (memberAccess(memberId)?.fingerprint ?? team.policyRevision)
        : team.policyRevision
      : null,
    url.pathname,
    // Handlers read the first of repeated parameters, so keep their order.
    [...url.searchParams.entries()].sort(([a], [b]) => compare(a, b)),
    identity
      ? [
          identity.workspace,
          identity.user,
          identity.credentialClass ?? null,
          identity.agent,
          identity.principal,
          [...identity.scopes].sort(),
        ]
      : null,
  ])
}

/** Share concurrent identical list reads. Mount after identity resolution. */
export const shareInFlightReads: MiddlewareHandler = async (c, next) => {
  if (c.req.method !== "GET") return next()
  const url = new URL(c.req.url)
  if (!SHARED_READ_ROUTES.some((route) => route.test(url.pathname))) {
    return next()
  }
  const key = sharedReadKey(url, c.get("identity"))
  const running = inFlight.get(key)
  if (running) {
    const shared = await running
    // Only a successful read is shared; anything else is answered alone.
    if (!shared) return next()
    return c.body(
      shared.body,
      200,
      shared.contentType ? { "Content-Type": shared.contentType } : {}
    )
  }

  let settle!: (shared: SharedResponse | null) => void
  const result = new Promise<SharedResponse | null>((resolve) => {
    settle = resolve
  })
  inFlight.set(key, result)
  try {
    await next()
    settle(
      c.res.status === 200
        ? {
            contentType: c.res.headers.get("Content-Type"),
            body: await c.res.clone().text(),
          }
        : null
    )
  } catch (error) {
    settle(null)
    throw error
  } finally {
    if (inFlight.get(key) === result) inFlight.delete(key)
  }
}

/**
 * Writes over HTTP advance the workspace generation when they start and when
 * they finish, so no later read joins a computation that began before them.
 */
export const advanceGenerationOnWrite: MiddlewareHandler = async (c, next) => {
  const method = c.req.method
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return next()
  }
  // These capability calls read workspace data; POST carries a bounded body
  // or password rather than a mutation. Concurrent visitors share one generation.
  if (
    method === "POST" &&
    (c.req.path === "/public/share/bridge" ||
      c.req.path === "/public/share/unlock")
  )
    return next()
  if (
    c.req.path === "/public/share/comments" ||
    (method === "POST" &&
      /^\/api\/spaces\/[^/]+\/visitor-comments\/[^/]+\/(?:replies|done)$/.test(
        c.req.path
      )) ||
    (method === "DELETE" &&
      /^\/api\/spaces\/[^/]+\/visitor-comments\/[^/]+$/.test(c.req.path))
  )
    return next()
  noteWorkspaceActivity()
  try {
    await next()
  } finally {
    noteWorkspaceActivity()
  }
}
