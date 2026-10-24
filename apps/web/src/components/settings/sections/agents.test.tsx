import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { AccessTokensGroup, ConnectedAgentsGroup } from "./agents"

test("connected identity and disconnect remain available when OAuth inventory is unavailable", () => {
  for (const unavailableAuthKinds of [[], ["oauth"]]) {
    const client = new QueryClient()
    client.setQueryData(["system", "connection"], {
      mcpAuthMode: "oauth",
      agentPairing: false,
    })
    // OAuth inventories include the workspace's connections even when pairing is unavailable.
    client.setQueryData(["agent-connections", true], {
      unavailableAuthKinds,
      connections: [
        {
          id: "agent:openclaw",
          authKind: "agent-registration",
          displayName: "OpenClaw",
          target: {
            kind: "agent-adapter",
            adapter: "openclaw",
            installationId: "studio",
          },
          mode: "always-on",
          participant: { id: "person", kind: "agent", name: "Atlas" },
          machine: "studio-mac",
          scopes: ["threads:*"],
          connectedAt: null,
          lastSeenAt: null,
          permissionGroups: null,
        },
        // An app through Worktable Link is managed on Cloud, which holds
        // its sign-in.
        {
          id: "acn_link_chatgpt",
          authKind: "oauth",
          displayName: "ChatGPT",
          platform: "chatgpt",
          icon: null,
          access: null,
          target: { kind: "mcp-client", clientId: null },
          mode: "on-demand",
          participant: null,
          machine: null,
          scopes: [],
          connectedAt: "2026-10-24T10:00:00Z",
          lastSeenAt: "2026-10-24T10:00:00Z",
          permissionGroups: null,
          canManage: false,
          link: {
            manageUrl: "https://cloud.example/linked/agents?destinationId=d",
          },
        },
      ],
    })
    try {
      const html = renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <ConnectedAgentsGroup />
        </QueryClientProvider>
      )
      for (const label of [
        "OpenClaw",
        "Atlas",
        "studio-mac",
        "Always-on",
        "Disconnect",
      ])
        expect(html).toContain(label)
      expect(html.includes("Some details are unavailable")).toBe(
        unavailableAuthKinds.length > 0
      )
      expect(html).toContain("Worktable Link")
      expect(html).toContain(
        'href="https://cloud.example/linked/agents?destinationId=d"'
      )
      expect(html.split(">Disconnect<").length - 1).toBe(1)
    } finally {
      client.clear()
    }
  }
})

test("existing access tokens start collapsed, retain their identity, and omit revoked credentials", () => {
  const client = new QueryClient()
  const token = {
    id: "123456789abc",
    user: "owner",
    agent: "codex@studio-mac",
    scopes: ["docs:*"],
    workspace: "/tmp/worktable",
    createdAt: "2026-01-01T00:00:00Z",
    revokedAt: null,
    lastUsedAt: null,
  }
  client.setQueryData(
    ["tokens"],
    [
      token,
      {
        ...token,
        id: "revoked-token",
        agent: "RevokedAgent",
        revokedAt: "2026-01-02T00:00:00Z",
      },
    ]
  )
  try {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <AccessTokensGroup />
      </QueryClientProvider>
    )
    for (const label of [
      "1 active token",
      "ChatGPT / Codex",
      "studio-mac",
      "wt_1234",
    ])
      expect(html).toContain(label)
    expect(html).not.toContain("RevokedAgent")
    expect(html).toContain('aria-expanded="false"')
  } finally {
    client.clear()
  }
})
