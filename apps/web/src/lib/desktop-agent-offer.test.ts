import { expect, test } from "bun:test"
import { presentAgentOffer } from "./desktop-agent-offer"

type Shown = {
  action: { label: string; onClick: () => void }
  onDismiss: () => void
}

test("the agent offer follows this Worktable's name, switches once at a time, comes back after a failed switch, and closing keeps agents", async () => {
  const shown: Shown[] = []
  const messages: string[] = []
  const toasts = {
    info: (message: string, options: Shown) => {
      messages.push(message)
      shown.push(options)
      return "desktop-agent-offer"
    },
    success: (message: string) => {
      messages.push(message)
      return ""
    },
    error: (message: string) => {
      messages.push(message)
      return ""
    },
  }
  const answers: boolean[] = []
  let settle: { resolve: () => void; reject: (error: Error) => void } | null =
    null
  const answer = (switchAgents: boolean) => {
    answers.push(switchAgents)
    return new Promise<void>((resolve, reject) => {
      settle = { resolve, reject }
    })
  }

  // Desktop named the new Worktable before setup renamed it.
  const offer = presentAgentOffer(
    { agentWorktable: "Alpha", worktable: "Local Workspace" },
    answer,
    toasts as unknown as Parameters<typeof presentAgentOffer>[2]
  )
  offer.rename("Beta")
  offer.rename("Beta")
  expect(messages).toEqual([
    "Your agents still use Alpha.",
    "Your agents still use Alpha.",
  ])
  expect(shown.map((options) => options.action.label)).toEqual([
    "Switch them to Local Workspace",
    "Switch them to Beta",
  ])

  // A second click, or closing, waits for the switch in flight.
  shown[1]!.action.onClick()
  shown[1]!.action.onClick()
  shown[1]!.onDismiss()
  expect(answers).toEqual([true])

  // A failed switch says so and offers it again.
  settle!.reject(new Error("save failed"))
  await Promise.resolve()
  await Promise.resolve()
  expect(messages.slice(2)).toEqual([
    "Couldn’t switch agents.",
    "Your agents still use Alpha.",
  ])

  // Retrying works. A rename meanwhile doesn't show the offer again, and
  // the result names the Worktable as it is now. Closing afterwards keeps
  // agents where they are.
  shown[2]!.action.onClick()
  expect(answers).toEqual([true, true])
  offer.rename("Beta Notes")
  expect(shown).toHaveLength(3)
  settle!.resolve()
  await Promise.resolve()
  await Promise.resolve()
  expect(messages.at(-1)).toBe("Agents now use Beta Notes.")
  offer.rename("Beta")
  expect(shown).toHaveLength(3)

  presentAgentOffer(
    { agentWorktable: "Alpha", worktable: "Beta" },
    answer,
    toasts as unknown as Parameters<typeof presentAgentOffer>[2]
  )
  shown.at(-1)!.onDismiss()
  expect(answers).toEqual([true, true, false])
})
