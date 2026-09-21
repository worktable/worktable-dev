import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dispatchOperation } from "./mcp/dispatcher.ts"
import { readSpace } from "./store.ts"
import { setWorkspaceRootOverride } from "./workspace.ts"

let workspace: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "worktable-principal-"))
  setWorkspaceRootOverride(workspace)
})

afterEach(async () => {
  setWorkspaceRootOverride(null)
  await rm(workspace, { recursive: true, force: true })
})

describe("MCP principal attribution", () => {
  it("uses authenticated identity and ignores caller-supplied authorship", async () => {
    const principal = {
      id: "oauth:claude:user_1",
      type: "agent" as const,
      displayName: "Claude",
      authorizedBy: "workos:user_1",
    }
    const created = (await dispatchOperation(
      "spaces.create",
      { name: "Principals" },
      { principal }
    )) as { spaceId: string }
    expect((await readSpace(created.spaceId)).data?.createdBy).toBe(
      principal.id
    )

    const annotation = (await dispatchOperation(
      "annotations.create",
      {
        spaceId: created.spaceId,
        target: { type: "doc", docPath: "notes" },
        category: "comment",
        body: "Authenticated author",
        author: { type: "system", id: "spoofed", name: "Spoofed" },
      },
      { principal }
    )) as { annotation: { id: string; author: unknown } }
    expect(annotation.annotation.author).toEqual({
      type: "agent",
      id: principal.id,
      name: "Claude",
    })

    const resolved = (await dispatchOperation(
      "annotations.resolve",
      {
        spaceId: created.spaceId,
        annotationId: annotation.annotation.id,
        resolvedBy: "spoofed",
      },
      { principal }
    )) as { annotation: { resolution?: { resolvedBy: string } } }
    expect(resolved.annotation.resolution?.resolvedBy).toBe(principal.id)
  })
})
