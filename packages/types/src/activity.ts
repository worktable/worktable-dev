import { z } from "zod"

// ============================================================
// Workspace activity
// ============================================================
//
// An append-only history of what people and agents did: created and edited
// docs, comments, thread messages, record changes, pins, and lifetime changes.
// Home and Space Home show it beside their content; the Activity page lists it
// in full. Events name their actor and target; readers resolve current names.

export const ActivityActorSchema = z.object({
  kind: z.enum(["person", "agent", "system"]),
  /** Stable principal key, e.g. "local:owner" or "local-token:<id>". */
  id: z.string().min(1),
  /** Name when the event was recorded; readers may substitute a current one. */
  name: z.string().optional(),
})

export const ActivityActionSchema = z.enum([
  "doc.created",
  "doc.edited",
  "doc.archived",
  "doc.restored",
  "doc.kept",
  "doc.madeTemporary",
  "doc.pinned",
  "doc.unpinned",
  "comment.created",
  "comment.replied",
  "comment.resolved",
  "thread.started",
  "thread.replied",
  "records.added",
  "records.updated",
  "records.removed",
])

export const ActivityTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("doc"),
    path: z.string().min(1),
    title: z.string().optional(),
    formatId: z.string().optional(),
  }),
  z.object({
    kind: z.literal("thread"),
    threadId: z.string().min(1),
    title: z.string().optional(),
  }),
  z.object({
    kind: z.literal("collection"),
    collectionId: z.string().min(1),
    name: z.string().optional(),
  }),
])

export const ActivityEventSchema = z.object({
  id: z.string().min(1),
  at: z.string(),
  /** Null for Worktable-level threads that belong to no Space. */
  spaceId: z.string().nullable(),
  action: ActivityActionSchema,
  actor: ActivityActorSchema,
  target: ActivityTargetSchema,
  /** Short excerpt, such as the text of a comment or instruction. */
  quote: z.string().max(280).optional(),
  /** Comment events: whether the comment asks an agent to act. */
  category: z.enum(["comment", "instruction"]).optional(),
  /** Number of items the event covers, such as records added. */
  count: z.number().int().positive().optional(),
})

export type ActivityActor = z.infer<typeof ActivityActorSchema>
export type ActivityAction = z.infer<typeof ActivityActionSchema>
export type ActivityTarget = z.infer<typeof ActivityTargetSchema>
export type ActivityEvent = z.infer<typeof ActivityEventSchema>

/** One row as shown to people: consecutive repeats on a day are combined. */
export interface ActivityEntry extends ActivityEvent {
  /** How many recorded events this entry combines. */
  repeats: number
}

export interface ActivityPage {
  entries: ActivityEntry[]
  nextCursor: string | null
}

// ============================================================
// Pending: things waiting on the person using Worktable
// ============================================================

export type PendingItem =
  | {
      kind: "threadRequest"
      id: string
      at: string
      spaceId: string | null
      threadId: string
      threadTitle: string
      messageId: string
      from: ActivityActor
      excerpt: string
    }
  | {
      kind: "commentReply"
      id: string
      at: string
      spaceId: string
      annotationId: string
      docPath: string
      docTitle?: string
      from: ActivityActor
      excerpt: string
    }
  | {
      kind: "deliveryFailed"
      id: string
      at: string
      spaceId: string | null
      threadId: string
      threadTitle: string
      agentName: string
    }

export interface PendingResult {
  items: PendingItem[]
}
