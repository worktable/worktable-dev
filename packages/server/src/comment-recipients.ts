// ============================================================
// Who a comment can be sent to
// ============================================================
//
// A comment goes to the same people and agents a Thread in its Space can
// address, named by participant ID or by name. Agents among them reply in the
// Doc; the request each one gets is recorded on the comment.

import type { AnnotationRecipient } from "@worktable/types"
import { resolveParticipant } from "./participant-store.ts"
import { listThreadParticipants } from "./thread-service.ts"
import type { TokenIdentity } from "./token-store.ts"
import type { CommentReplier } from "./annotation-requests.ts"
import { configuredMcpSurface } from "./mcp/surface.ts"

/** At most this many recipients on one comment or reply. */
export const MAX_COMMENT_RECIPIENTS = 10

export class CommentRecipientError extends Error {
  readonly code = "COMMENT_RECIPIENT"
}

type CommenterIdentity = Pick<
  TokenIdentity,
  "agent" | "credentialClass" | "principal" | "scopes"
>

/** Each named recipient, checked against who this Space can address. */
export async function commentRecipients(
  identity: CommenterIdentity,
  spaceId: string,
  names: readonly string[] | undefined
): Promise<AnnotationRecipient[]> {
  if (!names?.length) return []
  // Until agents are told about what reaches them, sending stays a preview.
  if (configuredMcpSurface() !== "preview") {
    throw new CommentRecipientError(
      "Sending comments requires Preview agent tools in Settings → Agents."
    )
  }
  if (names.length > MAX_COMMENT_RECIPIENTS) {
    throw new CommentRecipientError(
      `A comment can be sent to at most ${MAX_COMMENT_RECIPIENTS} people and agents`
    )
  }
  const offered = (
    await listThreadParticipants(identity, { kind: "space", spaceId }, false)
  ).filter((participant) => participant.kind !== "system")
  const recipients = new Map<string, AnnotationRecipient>()
  for (const name of names) {
    const needle = name.trim().toLocaleLowerCase()
    const byId = offered.find((participant) => participant.id === name)
    const byName = byId
      ? [byId]
      : offered.filter(
          (participant) => participant.name.toLocaleLowerCase() === needle
        )
    if (byName.length > 1) {
      throw new CommentRecipientError(
        `More than one person or agent here is named "${name}"; use their participant ID`
      )
    }
    const participant = byName[0]
    if (!participant) {
      throw new CommentRecipientError(
        `"${name}" can't be sent comments in this Space`
      )
    }
    recipients.set(participant.id, {
      id: participant.id,
      kind: participant.kind as "human" | "agent",
      name: participant.name,
    })
  }
  return [...recipients.values()]
}

/** Whoever is replying, so their own request on the comment closes. */
export async function commentReplier(
  identity: Pick<TokenIdentity, "agent" | "principal">
): Promise<CommentReplier> {
  const { participant } = await resolveParticipant(identity)
  return { participantId: participant.id, kind: participant.kind }
}
