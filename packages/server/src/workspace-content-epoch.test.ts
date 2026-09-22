import { afterEach, beforeEach, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { setAppDirOverride } from "./app-storage.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"
import { getWorkspaceCollaborationEpoch } from "./collaboration-epoch.ts"
import { requireWorkspaceContentEpoch } from "./workspace-content-epoch.ts"

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-content-fence-"))
  setAppDirOverride(join(root, "app"))
  setWorkspaceRootOverride(join(root, "workspace"))
  ensureWorkspaceManifest()
})
afterEach(async () => {
  setAppDirOverride(null)
  setWorkspaceRootOverride(null)
  await rm(root, { recursive: true, force: true })
})

it("rejects old and missing browser epochs before admitting content mutations", async () => {
  let writes = 0
  const app = new Hono()
    .use("*", requireWorkspaceContentEpoch)
    .all("*", (c) => {
      writes++
      return c.json({ ok: true })
    })
  for (const path of [
    "/api/spaces",
    "/api/spaces/notes/docs/note",
    "/api/threads/t/messages",
    "/api/shares/link",
  ]) {
    for (const epoch of [undefined, "old-epoch"]) {
      const headers = {
        Origin: "http://localhost",
        ...(epoch ? { "X-Worktable-Content-Epoch": epoch } : {}),
      }
      const result = await app.request(path, { method: "POST", headers })
      expect(result.status).toBe(409)
      expect(await result.json()).toMatchObject({ code: "WORKSPACE_CHANGED" })
    }
  }
  expect(writes).toBe(0)
  const epoch = await getWorkspaceCollaborationEpoch()
  expect(
    (
      await app.request("/api/spaces", {
        method: "POST",
        headers: {
          Origin: "http://localhost",
          "X-Worktable-Content-Epoch": epoch,
        },
      })
    ).status
  ).toBe(200)
  expect((await app.request("/api/spaces", { method: "GET" })).status).toBe(200)
  expect(
    (
      await app.request("/api/spaces", {
        method: "POST",
        headers: { Authorization: "Bearer tool-token" },
      })
    ).status
  ).toBe(200)
  expect(
    (
      await app.request("/api/workspace/clear", {
        method: "POST",
        headers: { Origin: "http://localhost" },
      })
    ).status
  ).toBe(200)
  expect(writes).toBe(4)
})
