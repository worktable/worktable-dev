import { Hono } from "hono"
import { z } from "zod"
import {
  ThreadDeliveryStateSchema,
  ConversationIdentityIdSchema,
  type ThreadLocation,
  ThreadMessageIdSchema,
} from "@worktable/types"
import { hasScope } from "../token-store.ts"
import {
  assignResponseRequest,
  listThreadParticipants,
  listThreadSummaries,
  postThreadMessage,
  readThreadMessage,
  readThreadMessages,
  waitForThreadReply,
} from "../thread-service.ts"
import { ThreadError } from "../thread-store.ts"
import { ThreadParticipantError } from "../participant-store.ts"
import { ThreadDeliveryError } from "../thread-delivery-store.ts"

const PostThreadSchema = z.object({
  to: z.string().trim().min(1).optional(),
  body: z.string().min(1).max(100_000),
  idempotencyKey: z.string().trim().min(1).max(200),
  authorIdentityId: ConversationIdentityIdSchema.optional(),
  deliveryLeaseId: z
    .string()
    .regex(/^lease_[A-Za-z0-9_-]{12,}$/)
    .optional(),
  notifyIdentityIds: z.array(ConversationIdentityIdSchema).max(100).optional(),
  responseIdentityId: ConversationIdentityIdSchema.nullable().optional(),
  inReplyTo: ThreadMessageIdSchema.optional(),
  responseTo: ThreadMessageIdSchema.nullable().optional(),
  expectsReply: z.boolean().optional(),
  waitSeconds: z.number().min(0).max(25).optional(),
})

const AssignMessageSchema = z.object({
  identityId: ConversationIdentityIdSchema.nullable(),
})

function errorResponse(
  c: Parameters<Parameters<Hono["onError"]>[0]>[1],
  error: unknown
) {
  if (
    error instanceof ThreadError ||
    error instanceof ThreadParticipantError ||
    error instanceof ThreadDeliveryError
  ) {
    const status =
      error.code === "FORBIDDEN"
        ? 403
        : error.code === "THREAD_NOT_FOUND" ||
            error.code === "PARTICIPANT_NOT_FOUND"
          ? 404
          : error.code === "THREAD_STORE_INCOMPLETE"
            ? 503
            : error.code === "AMBIGUOUS_THREAD_LOCATION"
              ? 409
              : error.code === "LEASE_LOST"
                ? 409
                : 400
    return c.json({ error: error.message, code: error.code }, status)
  }
  throw error
}

function requireThreadScope(
  c: Parameters<Parameters<Hono["onError"]>[0]>[1],
  scope: "threads:read" | "threads:write"
) {
  if (!hasScope(c.get("identity").scopes, scope)) {
    return c.json(
      { error: "Forbidden", code: "FORBIDDEN", required: scope },
      403
    )
  }
  return null
}

export const threadsRouter = new Hono()

function routeLocation(
  c: Parameters<Parameters<Hono["onError"]>[0]>[1]
): ThreadLocation {
  const spaceId = c.req.param("spaceId")
  return spaceId ? { kind: "space", spaceId } : { kind: "worktable" }
}

function listLocation(
  c: Parameters<Parameters<Hono["onError"]>[0]>[1]
): { ok: true; location?: ThreadLocation } | { ok: false; error: string } {
  const routeSpaceId = c.req.param("spaceId")
  if (routeSpaceId) {
    return { ok: true, location: { kind: "space", spaceId: routeSpaceId } }
  }
  const location = c.req.query("location") ?? "all"
  const spaceId = c.req.query("spaceId")
  if (location === "all" && !spaceId) return { ok: true }
  if (location === "worktable" && !spaceId) {
    return { ok: true, location: { kind: "worktable" } }
  }
  if (location === "space" && spaceId) {
    return { ok: true, location: { kind: "space", spaceId } }
  }
  return {
    ok: false,
    error: "location must be all, worktable, or space; space requires spaceId",
  }
}

function managementResult(thread: { id: string; revision: number }) {
  return { threadId: thread.id, revision: thread.revision }
}

threadsRouter.get("/participants", async (c) => {
  const denied = requireThreadScope(c, "threads:read")
  if (denied) return denied
  return c.json({
    participants: await listThreadParticipants(c.get("identity")),
  })
})

threadsRouter.get("/", async (c) => {
  const denied = requireThreadScope(c, "threads:read")
  if (denied) return denied
  const parsedLocation = listLocation(c)
  if (!parsedLocation.ok) {
    return c.json(
      { error: parsedLocation.error, code: "VALIDATION_ERROR" },
      400
    )
  }
  const participantId = c.req.query("participantId")
  const parsedDeliveryState = ThreadDeliveryStateSchema.optional().safeParse(
    c.req.query("deliveryState")
  )
  if (!parsedDeliveryState.success) {
    return c.json(
      {
        error: parsedDeliveryState.error.message,
        code: "VALIDATION_ERROR",
      },
      400
    )
  }
  try {
    return c.json({
      threads: await listThreadSummaries(
        c.get("identity"),
        parsedLocation.location,
        participantId,
        parsedDeliveryState.data
      ),
    })
  } catch (error) {
    return errorResponse(c, error)
  }
})

threadsRouter.post("/", async (c) => {
  const denied = requireThreadScope(c, "threads:write")
  if (denied) return denied
  const parsed = PostThreadSchema.safeParse(
    await c.req.json().catch(() => null)
  )
  if (!parsed.success) {
    return c.json(
      { error: parsed.error.message, code: "VALIDATION_ERROR" },
      400
    )
  }
  try {
    return c.json(
      await postThreadMessage(c.get("identity"), {
        ...parsed.data,
        location: routeLocation(c),
      }),
      201
    )
  } catch (error) {
    return errorResponse(c, error)
  }
})

threadsRouter.put("/:threadId/messages/:messageId/assignment", async (c) => {
  const denied = requireThreadScope(c, "threads:write")
  if (denied) return denied
  const parsed = AssignMessageSchema.safeParse(
    await c.req.json().catch(() => null)
  )
  if (!parsed.success) {
    return c.json(
      { error: parsed.error.message, code: "VALIDATION_ERROR" },
      400
    )
  }
  try {
    return c.json(
      managementResult(
        await assignResponseRequest(c.get("identity"), {
          location: routeLocation(c),
          threadId: c.req.param("threadId"),
          messageId: c.req.param("messageId"),
          identityId: parsed.data.identityId,
        })
      )
    )
  } catch (error) {
    return errorResponse(c, error)
  }
})

threadsRouter.get("/:threadId", async (c) => {
  const denied = requireThreadScope(c, "threads:read")
  if (denied) return denied
  const afterQuery = c.req.query("after")
  const beforeQuery = c.req.query("before")
  const after = afterQuery === undefined ? undefined : Number(afterQuery)
  const before = beforeQuery === undefined ? undefined : Number(beforeQuery)
  if (
    (after !== undefined && (!Number.isInteger(after) || after < 0)) ||
    (before !== undefined && (!Number.isInteger(before) || before <= 0))
  ) {
    return c.json(
      { error: "Invalid thread cursor", code: "VALIDATION_ERROR" },
      400
    )
  }
  if (after !== undefined && before !== undefined) {
    return c.json(
      { error: "Use after or before, not both", code: "VALIDATION_ERROR" },
      400
    )
  }
  try {
    return c.json(
      await readThreadMessages(c.get("identity"), c.req.param("threadId"), {
        location: routeLocation(c),
        after,
        before,
      })
    )
  } catch (error) {
    return errorResponse(c, error)
  }
})

threadsRouter.get("/:threadId/messages/:messageId", async (c) => {
  const denied = requireThreadScope(c, "threads:read")
  if (denied) return denied
  try {
    return c.json(
      await readThreadMessage(c.get("identity"), {
        location: routeLocation(c),
        threadId: c.req.param("threadId"),
        messageId: c.req.param("messageId"),
      })
    )
  } catch (error) {
    return errorResponse(c, error)
  }
})

threadsRouter.post("/:threadId/messages", async (c) => {
  const denied = requireThreadScope(c, "threads:write")
  if (denied) return denied
  const parsed = PostThreadSchema.safeParse(
    await c.req.json().catch(() => null)
  )
  if (!parsed.success) {
    return c.json(
      { error: parsed.error.message, code: "VALIDATION_ERROR" },
      400
    )
  }
  try {
    return c.json(
      await postThreadMessage(c.get("identity"), {
        ...parsed.data,
        location: routeLocation(c),
        threadId: c.req.param("threadId"),
      })
    )
  } catch (error) {
    return errorResponse(c, error)
  }
})

threadsRouter.get("/:threadId/wait", async (c) => {
  const denied = requireThreadScope(c, "threads:read")
  if (denied) return denied
  const after = Number(c.req.query("after") ?? 0)
  const activityRevision = Number(c.req.query("activityRevision") ?? -1)
  const waitSeconds = Number(c.req.query("waitSeconds") ?? 25)
  try {
    return c.json(
      await waitForThreadReply(c.get("identity"), {
        location: routeLocation(c),
        threadId: c.req.param("threadId"),
        after: Number.isFinite(after) && after >= 0 ? after : 0,
        activityRevision:
          Number.isFinite(activityRevision) && activityRevision >= -1
            ? activityRevision
            : -1,
        waitSeconds:
          Number.isFinite(waitSeconds) && waitSeconds >= 0
            ? Math.min(25, waitSeconds)
            : 25,
      })
    )
  } catch (error) {
    return errorResponse(c, error)
  }
})
