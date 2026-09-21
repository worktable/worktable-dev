import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  ThreadSchema,
  ThreadV3Schema,
  upgradeThreadToV3,
  type LegacyThreadMessage,
  type ParticipantRef,
  type ThreadLocation,
} from "@worktable/types"
import { getSpacesDir, getWorkspaceRoot } from "../workspace.ts"

export interface FixtureThreadDef {
  id: string
  title: string
  location: ThreadLocation
  participants: ParticipantRef[]
  messages: Array<
    Omit<LegacyThreadMessage, "sequence"> & {
      notifyParticipantIds?: string[]
    }
  >
}

/** Write a deterministic V3 thread into the active fixture workspace. */
export function fixtureThread(def: FixtureThreadDef): void {
  const notifyParticipantsByMessage = new Map(
    def.messages.map((message) => [
      message.id,
      message.notifyParticipantIds ?? [],
    ])
  )
  const messages = def.messages.map(
    ({ notifyParticipantIds: _notifyParticipantIds, ...message }, index) => ({
      ...message,
      sequence: index + 1,
    })
  )
  const legacyThread = ThreadSchema.parse({
    type: "worktable.thread",
    version: 2,
    location: def.location,
    id: def.id,
    title: def.title,
    participants: def.participants,
    revision: messages.length,
    messages,
    createdAt: messages[0]?.createdAt,
    updatedAt: messages.at(-1)?.createdAt,
  })
  const upgradedThread = upgradeThreadToV3(legacyThread)
  const identityByMemberId = new Map(
    upgradedThread.identities.map((identity) => [
      identity.memberId,
      identity.id,
    ])
  )
  const thread = ThreadV3Schema.parse({
    ...upgradedThread,
    messages: upgradedThread.messages.map((message) => {
      const notifyIdentityIds = (
        notifyParticipantsByMessage.get(message.id) ?? []
      ).map((participantId) => {
        const identityId = identityByMemberId.get(participantId)
        if (!identityId) {
          throw new Error(
            `Unknown notification participant ${participantId} in ${message.id}`
          )
        }
        return identityId
      })
      return {
        ...message,
        notifyIdentityIds,
        creationIntent: {
          ...message.creationIntent,
          notifyIdentityIds,
        },
      }
    }),
  })
  const dir =
    def.location.kind === "worktable"
      ? join(getWorkspaceRoot(), "threads")
      : join(getSpacesDir(), def.location.spaceId, "threads")
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${def.id}.json`),
    `${JSON.stringify(thread, null, 2)}\n`
  )
}
