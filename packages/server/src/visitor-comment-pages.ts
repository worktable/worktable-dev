import { createHash } from "node:crypto"
import { z } from "zod"
import { ShareCommentCursor } from "@worktable/hosted-contract"

const Cursor = z.strictObject({
  receivedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  id: z.string().regex(/^vc_[A-Za-z0-9_-]{22}$/),
  scope: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
})

/** A cursor selects an ordering boundary, never authority to read a row. */
export function visitorCommentPageScope(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("base64url")
}

export function readVisitorCommentCursor(
  raw: string | undefined,
  scope: string
): { before?: { receivedAt: number; id: string }; reset: boolean } | null {
  if (raw === undefined) return { reset: false }
  if (!ShareCommentCursor.safeParse(raw).success) return null
  try {
    const cursor = Cursor.parse(
      JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))
    )
    if (cursor.scope !== scope) return { reset: true }
    return {
      before: { receivedAt: cursor.receivedAt, id: cursor.id },
      reset: false,
    }
  } catch {
    return null
  }
}

export function nextVisitorCommentCursor(
  row: { received_at: number; id: string },
  scope: string
): string {
  return Buffer.from(
    JSON.stringify({ receivedAt: row.received_at, id: row.id, scope })
  ).toString("base64url")
}
