import { expect, it } from "bun:test"
import { checklistFor, checklistProgress } from "./setup"

const owner = (items: Parameters<typeof checklistFor>[1]["items"]) => {
  const list = checklistFor("owner", { canInvite: true, items })
  return { ids: list.map((item) => item.id), ...checklistProgress(list, items) }
}

it("keeps the global rules step after an app's agent does the first task", () => {
  // Someone who starts from ChatGPT has a first task before their first
  // visit. Saying "in Worktable" once in ChatGPT's own instructions is still
  // their next step.
  const fromApp = owner({
    "connect-agent": { at: "2026-11-02T19:44:47.036Z" },
    "first-task": { at: "2026-11-02T19:44:48.553Z", spaceId: "travel-plans" },
  })
  expect(fromApp.ids).toContain("agent-instructions")
  expect(fromApp.next?.id).toBe("agent-instructions")

  // A list finished before the step existed isn't reopened for it.
  const finishedEarlier = owner({
    "connect-agent": { at: "2026-10-20T10:00:00.000Z" },
    "first-task": { at: "2026-10-20T10:05:00.000Z", spaceId: "atlas" },
    "invite-team": { at: "2026-10-20T10:06:00.000Z", skipped: true },
  })
  expect(finishedEarlier.ids).not.toContain("agent-instructions")
  expect(finishedEarlier.next).toBeNull()
})
