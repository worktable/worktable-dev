import { describe, expect, it } from "bun:test"
import {
  AGENT_PERMISSION_GROUP_SCOPES,
  accessForScope,
  accessForStoredScopes,
  currentScopesForStored,
  scopesForAccess,
} from "./agent-connections"
import { DEFAULT_AGENT_TOKEN_SCOPES } from "./mcp-clients"

describe("agent access groups", () => {
  // Every connected agent with a group gets what the group grants here. When
  // this changes, add the table from before the change to
  // EARLIER_AGENT_PERMISSION_GROUP_SCOPES, and give a new kind of authority a
  // new group rather than widening one.
  it("grants exactly these scopes", () => {
    expect(AGENT_PERMISSION_GROUP_SCOPES).toEqual({
      conversations: ["threads:read", "threads:write", "threads:participate"],
      "workspace-read": [
        "annotations:read",
        "documents:read",
        "docs:read",
        "records:read",
        "search:read",
        "widgets:read",
      ],
      "workspace-write": [
        "annotations:read",
        "annotations:write",
        "documents:read",
        "documents:write",
        "docs:read",
        "docs:write",
        "records:read",
        "records:write",
        "search:read",
        "widgets:read",
        "widgets:write",
      ],
      export: ["workspace:export"],
    })
  })

  it("gives access stored as scopes what its groups grant today", () => {
    // Read and threads, stored before documents:* joined the groups.
    const august = [
      "threads:participate",
      "threads:read",
      "threads:write",
      "annotations:read",
      "docs:read",
      "records:read",
      "search:read",
      "widgets:read",
      "workspace:export",
    ]
    const access = { threads: true, read: true, edit: false }
    expect(accessForStoredScopes(august)).toEqual(access)
    expect(new Set(currentScopesForStored(august))).toEqual(
      new Set(scopesForAccess(access))
    )
    expect(currentScopesForStored(august)).toContain("documents:read")
    expect(currentScopesForStored(august)).not.toContain("docs:write")

    for (const chosen of [
      { threads: true, read: false, edit: false },
      { threads: false, read: true, edit: true },
    ])
      expect(accessForStoredScopes(scopesForAccess(chosen))).toEqual(chosen)
  })

  it("keeps any other scope list exactly as stored", () => {
    for (const scopes of [
      [...DEFAULT_AGENT_TOKEN_SCOPES],
      ["docs:read"],
      ["*"],
      [...scopesForAccess({ threads: true, read: true, edit: true }), "tokens:manage"],
    ]) {
      expect(accessForStoredScopes(scopes)).toBeNull()
      expect(currentScopesForStored(scopes)).toEqual(scopes)
    }
  })

  it("names the access that grants a scope", () => {
    expect(accessForScope("threads:participate")).toBe("threads")
    expect(accessForScope("documents:read")).toBe("read")
    expect(accessForScope("workspace:export")).toBe("read")
    expect(accessForScope("documents:write")).toBe("edit")
    expect(accessForScope("tokens:manage")).toBeNull()
  })
})
