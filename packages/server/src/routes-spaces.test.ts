import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { ownerIdentity } from "./auth.ts"
import { spacesRouter } from "./routes/spaces.ts"
import { writeDoc } from "./store.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"

let root = ""

function app() {
  const instance = new Hono()
  instance.use("*", async (c, next) => {
    c.set("identity", ownerIdentity())
    return next()
  })
  instance.route("/api/spaces", spacesRouter)
  return instance
}

async function json(
  instance: Hono,
  path: string,
  method = "GET",
  body?: unknown
): Promise<Record<string, unknown>> {
  const response = await instance.request(path, {
    method,
    ...(body
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  })
  expect(response.ok).toBe(true)
  return (await response.json()) as Record<string, unknown>
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-spaces-route-"))
  setWorkspaceRootOverride(root)
  ensureWorkspaceManifest()
})

afterEach(async () => {
  setWorkspaceRootOverride(null)
  await rm(root, { recursive: true, force: true })
})

describe("spaces routes", () => {
  it("list every Space, archived ones included, without their documents", async () => {
    const instance = app()
    await json(instance, "/api/spaces", "POST", { name: "Plans" })
    await json(instance, "/api/spaces", "POST", { name: "Old work" })
    await writeDoc("plans", "notes/brief", "# Brief", {
      updatedBy: "test",
      source: "rest-api",
    })
    await json(instance, "/api/spaces/old-work/archive", "POST", {})

    const { spaces } = (await json(instance, "/api/spaces")) as {
      spaces: Array<Record<string, unknown> & { settings: object }>
    }
    expect(
      spaces
        .map((space) => ({
          id: space["id"],
          archived: "archive" in space.settings,
          fields: Object.keys(space).filter(
            (key) => key === "docs" || key === "widgets"
          ),
        }))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    ).toEqual([
      { id: "old-work", archived: true, fields: [] },
      { id: "plans", archived: false, fields: [] },
    ])

    expect(
      Object.keys(await json(instance, "/api/spaces/plans")).sort()
    ).toEqual(["pins", "space"])
  })
})
