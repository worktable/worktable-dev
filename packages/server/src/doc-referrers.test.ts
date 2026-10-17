import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { ownerIdentity } from "./auth.ts"
import {
  openedDocumentPaths,
  peekDocReferrers,
  settleDocReferrers,
} from "./doc-referrers.ts"
import { writeManagedFixtureHtml as writeWidget } from "./fixtures/managed-content.ts"
import { recordsRouter } from "./routes/records.ts"
import { spacesRouter } from "./routes/spaces.ts"
import { buildWidgetFile } from "./widget-authoring.ts"
import { ensureWorkspaceManifest, setWorkspaceRootOverride } from "./workspace.ts"

const testDir = join(tmpdir(), `worktable-doc-referrers-${Date.now()}`)

function buildTestApp() {
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.set("identity", ownerIdentity())
    await next()
  })
  app.route("/api/spaces", spacesRouter)
  app.route("/api/spaces/:spaceId/records", recordsRouter)
  return app
}

async function post(app: Hono, path: string, body: unknown) {
  const response = await app.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  )
  expect(response.status).toBeLessThan(300)
  return response.json()
}

/** The first ask only starts the background read; answer once it lands. */
async function settled(path: string, current?: (path: string) => string) {
  peekDocReferrers("meta", path, current)
  await settleDocReferrers("meta")
  return peekDocReferrers("meta", path, current)
}

describe("records and HTML Docs that point at a Doc", () => {
  let app: Hono

  beforeEach(async () => {
    setWorkspaceRootOverride(testDir)
    ensureWorkspaceManifest()
    mkdirSync(join(testDir, "spaces"), { recursive: true })
    app = buildTestApp()
    await post(app, "/api/spaces", { name: "Meta" })
    await post(app, "/api/spaces/meta/records", {
      id: "okrs",
      name: "OKRs",
      fields: {
        title: { type: "string", required: true },
        plan: { type: "document", name: "Plan" },
        sources: { type: "document", many: true },
      },
    })
  })

  afterEach(() => {
    setWorkspaceRootOverride(null)
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
  })

  it("finds records by their document fields and HTML Docs by the docs they open", async () => {
    await post(app, "/api/spaces/meta/records/okrs", {
      data: { title: "Activation", plan: "okrs/q3", sources: ["notes/a", "/okrs/q3"] },
    })
    await post(app, "/api/spaces/meta/records/okrs", {
      data: { title: "Reliability", plan: "okrs/q4" },
    })
    const pulse = await writeWidget(
      "meta",
      buildWidgetFile({ id: "pulse", name: "Pulse", createdBy: "test", updatedBy: "test" }),
      `<button onclick="worktable.navigation.openDocument('okrs/q3')">Plan</button>`
    )
    pulse.release?.()

    expect(await settled("okrs/q3")).toEqual([
      {
        kind: "record",
        collectionId: "okrs",
        recordId: "activation",
        title: "Activation",
        collection: "OKRs",
        field: "Plan",
      },
      { kind: "html", path: "pulse" },
    ])
    // A doc that moved is found under the path it was pointed at.
    expect(
      (await settled("plans/q4", (path) => (path === "okrs/q4" ? "plans/q4" : path)))?.map(
        (referrer) => referrer.kind === "record" && referrer.title
      )
    ).toEqual(["Reliability"])
  })

  it("reads literal paths from openDocument calls only", () => {
    expect(
      openedDocumentPaths(`
        worktable.navigation.openDocument("plans/brief");
        worktable.navigation.openDocument( '/notes/a' );
        worktable.navigation.openDocument(\`specs/\${id}\`);
        worktable.navigation.openDocument(path);
      `)
    ).toEqual(["plans/brief", "notes/a"])
  })
})
