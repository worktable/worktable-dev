import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { AppChoices } from "@/lib/app-choices"
import { OfficialAppSteps } from "./chat-app-ways"

const CHATGPT = "https://chatgpt.com/oauth/client.json"
const choices = (worktable: NonNullable<AppChoices["apps"][number]["worktable"]>): AppChoices => ({
  apps: [
    {
      clientId: CHATGPT,
      name: "ChatGPT",
      family: "chatgpt",
      changeUrl: "https://cloud.example/gateway/worktables/app?app=chatgpt",
      worktable,
    },
  ],
  appsUrl: "https://cloud.example/gateway/worktables/apps",
})

function steps(
  data: AppChoices | null,
  autoReply?: "on" | "off",
  waiting = false
): string {
  const client = new QueryClient()
  client.setQueryData(["app-choices"], data)
  client.setQueryData(["system", "connection"], { mcpAuthMode: "local-token" })
  // The agent list's own query, which live participant changes refresh.
  client.setQueryData(["agent-connections", false], {
    connections: autoReply
      ? [
          {
            id: "acn_link_chatgpt",
            target: { kind: "mcp-client", clientId: CHATGPT },
            autoReply: { kind: "chat", state: autoReply },
          },
        ]
      : [],
  })
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ol>
          <OfficialAppSteps app="chatgpt" first={2} waiting={waiting} />
        </ol>
      </QueryClientProvider>
    )
  } finally {
    client.clear()
  }
}

test("ChatGPT's steps finish adding once Cloud knows it, and say where to paste the auto-reply line", () => {
  // Working in another Worktable: adding is done, and the auto-reply step
  // waits for Move Here, which the setup shows beside where it works.
  const elsewhere = steps(
    choices({ id: "wt_studio", name: "Studio", device: "office-mac", here: false })
  )
  expect(elsewhere).not.toContain("find Worktable in Apps")
  expect(elsewhere).not.toContain("Watch Worktable for comments")

  // Working here: the line to paste.
  const here = steps(choices({ id: "wl_notes", name: "Notes", here: true }), "off")
  expect(here).not.toContain("find Worktable in Apps")
  expect(here).toContain("Watch Worktable for comments")
  expect(here).toContain("a Work chat on chatgpt.com")

  // A watching chat seen before ChatGPT moved away doesn't count here.
  expect(
    steps(choices({ id: "wt_studio", name: "Studio", here: false }), "on")
  ).not.toContain("Auto-reply is on")

  // Once ChatGPT watches, the step is done.
  expect(steps(choices({ id: "wl_notes", name: "Notes", here: true }), "on")).toContain(
    "Auto-reply is on"
  )

  // When Cloud can't say, the steps show how to add it.
  const unknown = steps(null)
  expect(unknown).toContain("Add the Worktable app in ChatGPT")
  expect(unknown).toContain("find Worktable in Apps")
  expect(unknown).toContain('href="https://chatgpt.com/"')

  // Waiting for it says so until Cloud knows it.
  expect(steps(null, undefined, true)).toContain("Waiting for ChatGPT")
  expect(
    steps(choices({ id: "wl_notes", name: "Notes", here: true }), "off", true)
  ).not.toContain("Waiting for ChatGPT")
})
