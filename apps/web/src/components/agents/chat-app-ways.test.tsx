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

function steps(data: AppChoices | null, autoReply?: "on" | "off"): string {
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
          <OfficialAppSteps app="chatgpt" first={2} />
        </ol>
      </QueryClientProvider>
    )
  } finally {
    client.clear()
  }
}

test("ChatGPT's steps say where it works, offer Move Here, and say where to paste the auto-reply line", () => {
  // Working in another Worktable: Move Here is the one action, and the
  // auto-reply step waits for it.
  const elsewhere = steps(
    choices({ id: "wt_studio", name: "Studio", device: "office-mac", here: false })
  )
  expect(elsewhere).toContain("ChatGPT works in Studio on office-mac.")
  expect(elsewhere).toContain(">Move Here<")
  expect(elsewhere).not.toContain("Watch Worktable for comments")
  expect(elsewhere).toContain('href="https://cloud.example/gateway/worktables/apps"')

  // Working here: the line to paste, and where it works.
  const here = steps(choices({ id: "wl_notes", name: "Notes", here: true }), "off")
  expect(here).toContain("ChatGPT works here")
  expect(here).not.toContain(">Move Here<")
  expect(here).toContain("Watch Worktable for comments")
  expect(here).toContain("a Work chat on chatgpt.com")

  // Once ChatGPT watches, the step is done.
  expect(steps(choices({ id: "wl_notes", name: "Notes", here: true }), "on")).toContain(
    "Auto-reply is on"
  )

  // When Cloud can't say, the steps read as they did before.
  const unknown = steps(null)
  expect(unknown).toContain("Add the official Worktable app in ChatGPT.")
  expect(unknown).not.toContain(">Move Here<")
  expect(unknown).not.toContain("All Apps")
})
