import { expect, it } from "bun:test"
import type { PersonalSetup } from "@worktable/types/setup"
import { homeTryNext } from "./try-next"

const at = "2026-11-16T12:00:00.000Z"
const ids = (
  setup: PersonalSetup,
  options = { canInvite: true, links: true }
) =>
  homeTryNext(setup, { doc: true, ...options })?.cards.map((card) =>
    card.done ? `${card.id} done` : card.id
  )

it("leads with the Getting Started steps still open, then the cards in order", () => {
  expect(ids({ items: { "invite-team": { at, skipped: true } } })).toEqual([
    "connect-agent",
    "agent-rules",
    "invite-team",
    "another-agent",
    "interactive-page",
    "share-link",
    "note-to-agent",
  ])
})

it("keeps done cards in place, counts them, and goes once all are done", () => {
  const setup: PersonalSetup = {
    items: { "connect-agent": { at }, "agent-instructions": { at } },
    helpEvidence: { "link-made": { at } },
  }
  // The rules line copied in Getting Started is the same card, done.
  expect(ids(setup, { canInvite: false, links: true })).toEqual([
    "another-agent",
    "interactive-page",
    "share-link done",
    "note-to-agent",
    "agent-rules done",
  ])
  expect(
    homeTryNext(setup, { canInvite: false, links: true, doc: true })
  ).toMatchObject({
    done: 2,
    total: 5,
  })
  // Without share links there is no link to make.
  expect(ids(setup, { canInvite: false, links: false })).not.toContain(
    "share-link done"
  )
  expect(
    homeTryNext(
      {
        ...setup,
        helpEvidence: {
          "another-agent": { at },
          "html-doc-made": { at },
          "note-to-agent": { at },
        },
      },
      { canInvite: false, links: false, doc: true }
    )
  ).toBeNull()
})
