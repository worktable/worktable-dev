import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test"
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import type { SpaceFile } from "@worktable/types"
import { ownerIdentity } from "./auth.ts"
import { setAppDirOverride } from "./app-storage.ts"
import {
  createRegisteredDocument,
  readRegisteredDocumentSource,
  replaceRegisteredDocument,
} from "./document-write-service.ts"
import { listDocumentGenerationsV2 } from "./document-version-store-v2.ts"
import { docsRouter } from "./routes/docs.ts"
import { writeSpace } from "./store.ts"
import { ensureWorkspaceManifest, setWorkspaceRootOverride } from "./workspace.ts"

const spaceId = "coalescing"
const T0 = Date.parse("2026-10-16T09:00:00.000Z")
const minutes = (count: number) => new Date(T0 + count * 60_000)

interface Version {
  id: string
  createdAt: string
  createdBy: string
  operation: string
  checkpoint?: { kind: string }
}

let root = ""
let appDir = ""
let app: Hono

function space(): SpaceFile {
  const now = new Date().toISOString()
  return {
    type: "worktable.space",
    version: 1,
    id: spaceId,
    name: "Coalescing",
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  }
}

function buildApp(): Hono {
  const hono = new Hono()
  // Each request writes as the agent its x-actor header names.
  hono.use("*", async (c, next) => {
    const actor = c.req.header("x-actor")
    c.set(
      "identity",
      actor
        ? {
            ...ownerIdentity(),
            principal: { id: actor, type: "agent", displayName: actor },
          }
        : ownerIdentity()
    )
    await next()
  })
  hono.route("/api/spaces/:spaceId/docs", docsRouter)
  return hono
}

async function call(
  method: string,
  path: string,
  options: { actor?: string; body?: unknown } = {}
): Promise<any> {
  const response = await app.fetch(
    new Request(`http://localhost/api/spaces/${spaceId}/docs/${path}`, {
      method,
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(options.actor ? { "x-actor": options.actor } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    })
  )
  const json = await response.json()
  expect({ status: response.status, json }).toMatchObject({ status: 200 })
  return json
}

function save(at: Date, actor: string, text: string): Promise<unknown> {
  setSystemTime(at)
  return call("PUT", "notes", {
    actor,
    body: {
      content: [
        { type: "paragraph", content: [{ type: "text", text, styles: {} }] },
      ],
    },
  })
}

async function history(): Promise<Version[]> {
  return (await call("GET", "notes/versions?all=true")).versions
}

async function contentOf(versionId: string): Promise<string> {
  const blocks = (await call("GET", `notes/versions/${versionId}`)).version
    .after.content as Array<{ content: Array<{ text: string }> }>
  return blocks
    .map((block) => block.content.map((inline) => inline.text).join(""))
    .join("\n")
}

/** File identity of every published version, as a backup classifies it. */
function versionFiles(): Map<string, string> {
  const documents = join(root, "versions", spaceId, "documents")
  const identities = new Map<string, string>()
  for (const documentId of readdirSync(documents)) {
    for (const generation of readdirSync(join(documents, documentId))) {
      if (generation.startsWith(".")) continue
      const info = statSync(join(documents, documentId, generation, "manifest.json"))
      identities.set(
        generation,
        [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(":")
      )
    }
  }
  return identities
}

describe("rapid edits coalesce into one version", () => {
  beforeEach(async () => {
    root = join(tmpdir(), `worktable-coalescing-${crypto.randomUUID()}`)
    appDir = join(tmpdir(), `worktable-coalescing-app-${crypto.randomUUID()}`)
    setWorkspaceRootOverride(root)
    setAppDirOverride(appDir)
    ensureWorkspaceManifest()
    mkdirSync(join(root, "spaces"), { recursive: true })
    await writeSpace(space())
    app = buildApp()
  })

  afterEach(() => {
    setSystemTime()
    setWorkspaceRootOverride(null)
    setAppDirOverride(null)
    rmSync(root, { recursive: true, force: true })
    rmSync(appDir, { recursive: true, force: true })
  })

  it("keeps one version per actor until they pause for ten minutes", async () => {
    await save(minutes(0), "writer", "draft 0")
    await save(minutes(1), "writer", "draft 1")
    const first = versionFiles()
    await save(minutes(2), "writer", "draft 2")
    // Nine minutes after the previous save: still the same version.
    await save(minutes(11), "writer", "draft 3")

    let versions = await history()
    expect(versions.map((version) => version.operation)).toEqual([
      "update",
      "create",
    ])
    const open = versions[0]!
    expect(open.createdAt).toBe(minutes(1).toISOString())
    expect(await contentOf(open.id)).toBe("draft 3")
    // Each save published the open version as a new generation directory of
    // its own and retired the one it replaced. Published files never change.
    const files = versionFiles()
    expect([...files.keys()].sort()).toEqual(
      versions.map((version) => version.id).sort()
    )
    const creation = versions[1]!.id
    expect(files.get(creation)).toBe(first.get(creation)!)
    expect(first.has(open.id)).toBe(false)

    // More than ten minutes without a save by them starts a new version.
    await save(minutes(21.5), "writer", "draft 4")
    versions = await history()
    expect(versions).toHaveLength(3)
    expect(versions[1]!.id).toBe(open.id)
    const sealed = versionFiles().get(open.id)

    await save(minutes(22), "writer", "draft 5")
    versions = await history()
    expect(versions.map((version) => version.createdAt)).toEqual([
      minutes(21.5).toISOString(),
      minutes(1).toISOString(),
      minutes(0).toISOString(),
    ])
    expect(await contentOf(versions[0]!.id)).toBe("draft 5")
    expect(await contentOf(versions[1]!.id)).toBe("draft 3")
    expect(versionFiles().get(open.id)).toBe(sealed!)
  })

  it("starts a new version after someone else's edit and after a restore", async () => {
    await save(minutes(0), "writer", "draft 0")
    await save(minutes(1), "writer", "mine")
    await save(minutes(2), "reviewer", "theirs")
    await save(minutes(3), "writer", "mine again")
    let versions = await history()
    expect(versions.map((version) => version.createdBy)).toEqual([
      "agent:writer",
      "agent:reviewer",
      "agent:writer",
      "agent:writer",
    ])

    setSystemTime(minutes(4))
    await call("POST", `notes/versions/${versions[2]!.id}/restore`, {
      actor: "writer",
    })
    await save(minutes(5), "writer", "after restore")
    versions = await history()
    expect(versions).toHaveLength(6)
    expect(versions[1]!.checkpoint?.kind).toBe("restore")
    expect(await contentOf(versions[1]!.id)).toBe("mine")
    expect(await contentOf(versions[0]!.id)).toBe(
      "after restore"
    )
  })

  it("coalesces saves through the document writer", async () => {
    setSystemTime(minutes(0))
    const created = await createRegisteredDocument({
      spaceId,
      path: "plan",
      format: { id: "worktable.markdown", sourceVersion: 1 },
      bytes: new TextEncoder().encode("# Plan\n"),
      createdBy: "writer",
      source: "rest-api",
    })
    let revision = created.sourceRevision
    for (const [minute, text] of [
      [1, "one"],
      [2, "two"],
    ] as const) {
      setSystemTime(minutes(minute))
      revision = (
        await replaceRegisteredDocument({
          spaceId,
          path: "plan",
          bytes: new TextEncoder().encode(`# Plan\n\n${text}\n`),
          expectedRevision: revision,
          updatedBy: "writer",
          source: "rest-api",
        })
      ).sourceRevision
    }
    const generations = await listDocumentGenerationsV2({
      workspaceRoot: root,
      spaceId,
      documentId: created.documentId,
    })
    expect(generations.map((generation) => generation.operation)).toEqual([
      "update",
      "create",
    ])
    expect(generations[0]).toMatchObject({
      createdAt: minutes(1).toISOString(),
      updatedAt: minutes(2).toISOString(),
    })
    expect(
      new TextDecoder().decode(
        (await readRegisteredDocumentSource({ spaceId, path: "plan" })).bytes
      )
    ).toBe("# Plan\n\ntwo\n")
  })
})
