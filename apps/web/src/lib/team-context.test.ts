import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test"
import { QueryClient } from "@tanstack/react-query"
import type { SpaceView } from "./api"
import { registerTeamQueryClient } from "./team-access"
import { resetBrowserTeamContext } from "./team-context"
import { versionHistoryKeys } from "./version-history"

const realWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
const realIndexedDb = Object.getOwnPropertyDescriptor(globalThis, "indexedDB")
const realLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
const realSessionStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage")

function storage(entries: Record<string, string>) {
  const values = new Map(Object.entries(entries))
  return {
    values,
    api: new Proxy(
      {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => void values.set(key, value),
        removeItem: (key: string) => void values.delete(key),
      },
      { ownKeys: () => [...values.keys()], getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }) }
    ),
  }
}

function space(id: string, accessKey: string, edit = true): SpaceView {
  return {
    type: "worktable.space",
    version: 1,
    id,
    name: id,
    createdAt: "2026-10-14T00:00:00.000Z",
    updatedAt: "2026-10-14T00:00:00.000Z",
    createdBy: "test",
    settings: {},
    permissions: { edit, manage: false, accessKey },
  }
}

let replace: ReturnType<typeof jest.fn>
let deleted: string[]
let local: ReturnType<typeof storage>

beforeEach(() => {
  replace = jest.fn()
  deleted = []
  local = storage({
    "worktable:drawing-draft:ws/member:wt_a:mem_1/plan": "{}",
    "worktable:drawing-draft:ws/member:wt_b:mem_9/plan": "{}",
  })
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { pathname: "/spaces/research/documents/plan", replace },
      dispatchEvent: () => true,
    },
  })
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: local.api })
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage({}).api })
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      databases: async () => [
        { name: "worktable-team:wt_a%3Amem_1:research:plan-yjs-v1-e" },
        { name: "worktable-team:wt_a%3Amem_1:design:brief-yjs-v1-e" },
        { name: "worktable-team:wt_b%3Amem_9:research:plan-yjs-v1-e" },
        { name: "worktable-research-plan-yjs-v1-e" },
      ],
      deleteDatabase: (name: string) => void deleted.push(name),
    },
  })
})

afterEach(() => {
  resetBrowserTeamContext()
  for (const [name, descriptor] of [
    ["window", realWindow],
    ["indexedDB", realIndexedDb],
    ["localStorage", realLocalStorage],
    ["sessionStorage", realSessionStorage],
  ] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
})

describe("team context", () => {
  it("keeps the tab in place for other members' changes and drops only Spaces this member lost", async () => {
    const { acceptTeamContext, applySpaceAccess, initializeBrowserTeamContext } =
      await import("./team-context")
    const queryClient = new QueryClient()
    registerTeamQueryClient(queryClient)
    queryClient.setQueryData(["spaces", "research", "documents"], ["plan"])
    queryClient.setQueryData(["spaces", "design", "documents"], ["brief"])
    queryClient.setQueryData(["recent", {}], [])
    queryClient.setQueryData(["system", "version"], "1")
    const stale = (key: unknown[]) => queryClient.getQueryState(key)?.isInvalidated
    // The page's summary carries each Space's key, so the first spaces list
    // confirms them without refetching anything.
    initializeBrowserTeamContext({
      worktableId: "wt_a",
      memberId: "mem_1",
      policyRevision: 5,
      access: "fp-1",
      accessKeys: { research: "k-r", design: "k-d" },
    })
    const savedVersion = versionHistoryKeys.snapshot("doc", "research", "plan", "saved-v1")
    const savedHistory = versionHistoryKeys.list("doc", "research", "plan", "current-v2")
    const otherVersion = versionHistoryKeys.snapshot("html", "design", "brief", "saved-v1")
    queryClient.setQueryData(savedVersion, "previous plan")
    queryClient.setQueryData(savedHistory, ["saved-v1"])
    queryClient.setQueryData(otherVersion, "previous brief")
    applySpaceAccess([space("research", "k-r"), space("design", "k-d")])
    expect(queryClient.getQueryCache().findAll().some((query) => query.state.isInvalidated)).toBe(false)

    const sharingPage = ["spaces", "research", "document-page", "plan"]
    const ordinaryPage = ["spaces", "research", "document-page", "private"]
    const content = ["spaces", "research", "document-content", "plan", "v1"]
    const links = ["share-links", "research", "plan"]
    queryClient.setQueryData(sharingPage, { kind: "document", sharing: { activeLinks: 1, canCreate: true } })
    queryClient.setQueryData(ordinaryPage, { kind: "document" })
    queryClient.setQueryData(content, "Plan")
    queryClient.setQueryData(links, { links: [] })
    // Another member's access changed: the revision moves, this access doesn't.
    acceptTeamContext({ worktableId: "wt_a", memberId: "mem_1", policyRevision: 6, access: "fp-1" })
    // A replayed older response never moves the tab backwards.
    acceptTeamContext({ worktableId: "wt_a", memberId: "mem_1", policyRevision: 4, access: "fp-0" })
    expect(stale(sharingPage)).toBe(true)
    expect(stale(links)).toBe(true)
    expect(stale(ordinaryPage)).toBe(false)
    expect(stale(content)).toBe(false)
    expect(stale(savedHistory)).toBe(false)
    expect(replace).not.toHaveBeenCalled()
    expect(queryClient.getQueryData(["spaces", "research", "documents"])).toEqual(["plan"])
    expect(queryClient.getQueryData(versionHistoryKeys.snapshot("doc", "research", "plan", "saved-v1"))).toBe("previous plan")

    // This member loses the Space the tab is showing.
    applySpaceAccess([space("design", "k-d")])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(queryClient.getQueryData(["spaces", "research", "documents"])).toBeUndefined()
    expect(queryClient.getQueryData(savedVersion)).toBeUndefined()
    expect(queryClient.getQueryData(savedHistory)).toBeUndefined()
    expect(queryClient.getQueryData(otherVersion)).toBe("previous brief")
    expect(queryClient.getQueryData(["spaces", "design", "documents"])).toEqual(["brief"])
    // Lists spanning Spaces drop the lost Space's items at once; unrelated
    // queries stay as they are.
    expect(queryClient.getQueryData(["recent", {}])).toBeUndefined()
    expect(stale(["system", "version"])).toBe(false)
    expect(deleted).toEqual(["worktable-team:wt_a%3Amem_1:research:plan-yjs-v1-e"])
    expect(replace).toHaveBeenCalledWith("/")
  })

  it("clears one member's data without touching other Worktables or solo caches", async () => {
    const { clearTeamBrowserData } = await import("./team-context")
    await clearTeamBrowserData({ worktableId: "wt_a", memberId: "mem_1" })
    expect(deleted.sort()).toEqual([
      "worktable-team:wt_a%3Amem_1:design:brief-yjs-v1-e",
      "worktable-team:wt_a%3Amem_1:research:plan-yjs-v1-e",
    ])
    expect([...local.values.keys()]).toEqual([
      "worktable:drawing-draft:ws/member:wt_b:mem_9/plan",
    ])
  })
})
