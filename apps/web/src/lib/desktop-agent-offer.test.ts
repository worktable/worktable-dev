import { expect, test } from "bun:test"
import { presentAgentOffer } from "./desktop-agent-offer"

type Shown = {
  action: { onClick: () => void }
  onDismiss: () => void
}

test("the agent offer switches once at a time, comes back after a failed switch, and closing keeps agents", async () => {
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

  presentAgentOffer(
    { agentWorktable: "Alpha", worktable: "Beta" },
    answer,
    toasts as unknown as Parameters<typeof presentAgentOffer>[2]
  )
  expect(messages).toEqual(["Your agents still use Alpha."])

  // A second click, or closing, waits for the switch in flight.
  shown[0]!.action.onClick()
  shown[0]!.action.onClick()
  shown[0]!.onDismiss()
  expect(answers).toEqual([true])

  // A failed switch says so and offers it again.
  settle!.reject(new Error("save failed"))
  await Promise.resolve()
  await Promise.resolve()
  expect(messages.slice(1)).toEqual([
    "Couldn’t switch agents.",
    "Your agents still use Alpha.",
  ])

  // Retrying works, and closing afterwards keeps agents where they are.
  shown[1]!.action.onClick()
  expect(answers).toEqual([true, true])
  settle!.resolve()
  await Promise.resolve()
  await Promise.resolve()
  expect(messages.at(-1)).toBe("Agents now use Beta.")

  presentAgentOffer(
    { agentWorktable: "Alpha", worktable: "Beta" },
    answer,
    toasts as unknown as Parameters<typeof presentAgentOffer>[2]
  )
  shown.at(-1)!.onDismiss()
  expect(answers).toEqual([true, true, false])
})
