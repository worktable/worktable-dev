import { ownerIdentity } from "./auth.ts";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { setWorkspaceRootOverride } from "./workspace.ts";
import { recordDocAlias } from "./doc-aliases.ts";
import { docAliasesRouter } from "./routes/doc-aliases.ts";

let root: string;
const app = new Hono();
  // Route behavior fixtures enter after the production identity boundary.
  app.use("*", async (c, next) => {
    c.set("identity", ownerIdentity());
    await next();
  });
app.route("/api/spaces/:spaceId/doc-aliases", docAliasesRouter);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-alias-routes-"));
  setWorkspaceRootOverride(root);
  await recordDocAlias("space", "old", "current", "exact");
});

afterEach(async () => {
  setWorkspaceRootOverride(null);
  await rm(root, { recursive: true, force: true });
});

describe("document alias routes", () => {
  it("lists portable aliases", async () => {
    const response = await app.request("/api/spaces/space/doc-aliases");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      aliases: { exact: { old: "current" }, prefixes: {} },
    });
  });

  it("requires an explicit warning acknowledgement before retirement", async () => {
    const path = "/api/spaces/space/doc-aliases/exact/old";
    expect((await app.request(path, { method: "DELETE" })).status).toBe(409);
    expect(
      (
        await app.request(`${path}?acknowledgeLinkRetargeting=true`, {
          method: "DELETE",
        })
      ).status
    ).toBe(200);
    expect(
      (
        await app.request(`${path}?acknowledgeLinkRetargeting=true`, {
          method: "DELETE",
        })
      ).status
    ).toBe(404);
  });
});
