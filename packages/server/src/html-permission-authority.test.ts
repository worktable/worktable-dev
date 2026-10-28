import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { ownerIdentity } from "./auth.ts";
import { setAppDirOverride } from "./app-storage.ts";
import { dispatchOperation } from "./mcp/dispatcher.ts";
import { documentsRouter } from "./routes/documents.ts";
import { spacesRouter } from "./routes/spaces.ts";
import { widgetsRouter } from "./routes/widgets.ts";
import { isPersonWriter } from "./html-permission-authority.ts";
import type { TokenIdentity } from "./token-store.ts";
import { ensureWorkspaceManifest, setWorkspaceRootOverride } from "./workspace.ts";

const testDir = join(tmpdir(), `worktable-html-permissions-${Date.now()}`);
const appDir = join(tmpdir(), `worktable-html-permissions-app-${Date.now()}`);
const html = '<!doctype html><html><head></head><body><script>fetch("https://example.com/data.json").catch(() => {})</script></body></html>';

function agent(scopes: string[]): TokenIdentity {
  return {
    user: "owner",
    workspace: testDir,
    credentialClass: "resource",
    scopes,
    agent: "claude-code",
    principal: { id: "agent:claude-code", type: "agent", displayName: "Claude Code", authorizedBy: "local:owner" },
  };
}

describe("who may grant an HTML Doc its permissions", () => {
  let app: Hono;
  let caller: TokenIdentity;
  const previousPreview = process.env["WORKTABLE_MCP_PREVIEW"];

  async function req(method: string, path: string, body?: unknown) {
    const res = await app.fetch(new Request(`http://localhost${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    }));
    const text = await res.text();
    const json = (res.headers.get("content-type") ?? "").includes("json") && text ? JSON.parse(text) : null;
    return { status: res.status, json, headers: res.headers };
  }

  async function opened(path: string) {
    const page = (await req("GET", `/api/spaces/meta/documents/page?path=${path}`)).json.page;
    const content = await req("GET", `/api/spaces/meta/widgets/${path}/content?rev=${page.revision}`);
    return {
      networkRequested: page.networkRequested === true,
      network: content.headers.get("content-security-policy")?.includes("https:") ?? false,
    };
  }

  beforeEach(async () => {
    process.env["WORKTABLE_MCP_PREVIEW"] = "0";
    setWorkspaceRootOverride(testDir);
    setAppDirOverride(appDir);
    ensureWorkspaceManifest();
    mkdirSync(join(testDir, "spaces"), { recursive: true });
    caller = ownerIdentity();
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("identity", caller);
      await next();
    });
    app.onError((err, c) => c.json({ error: err.message, code: "INTERNAL_ERROR" }, 500));
    app.route("/api/spaces", spacesRouter);
    app.route("/api/spaces/:spaceId/widgets", widgetsRouter);
    app.route("/api/spaces/:spaceId/documents", documentsRouter);
    await req("POST", "/api/spaces", { name: "Meta" });
  });

  afterEach(() => {
    if (previousPreview === undefined) delete process.env["WORKTABLE_MCP_PREVIEW"];
    else process.env["WORKTABLE_MCP_PREVIEW"] = previousPreview;
    setWorkspaceRootOverride(null);
    setAppDirOverride(null);
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    if (existsSync(appDir)) rmSync(appDir, { recursive: true, force: true });
  });

  it("keeps an agent's network request off until a person allows it, and asks again after the agent's next edit", async () => {
    const created = await dispatchOperation(
      "html.create",
      { spaceId: "meta", id: "feed", name: "Feed", html, permissions: { network: true } },
      { surface: "released" }
    ) as { warnings: Array<{ code: string }> };
    expect(created.warnings.map((warning) => warning.code)).toContain("network_requested");
    expect(await opened("feed")).toEqual({ networkRequested: true, network: false });

    const revision = async () => (await req("GET", "/api/spaces/meta/documents/page?path=feed")).json.page.revision as string;
    const allow = async (checked: string) => (await req("PATCH", "/api/spaces/meta/widgets/feed", { allowNetwork: true, revision: checked })).status;
    const seen = await revision();
    caller = agent(["*"]);
    expect(await allow(seen)).toBe(403);
    // A token is never a person, even without an agent label.
    caller = { ...agent(["*"]), agent: null, principal: { id: "local-token:abc", type: "human", displayName: "owner" } };
    expect(await allow(seen)).toBe(403);
    expect((await opened("feed")).network).toBe(false);

    // A person allows the code they saw, not code an agent wrote since.
    caller = ownerIdentity();
    await dispatchOperation("html.update", { spaceId: "meta", widgetId: "feed", html: `${html}<!-- newer -->` }, { surface: "released" });
    expect(await allow(seen)).toBe(409);
    expect(await allow(await revision())).toBe(200);
    expect(await opened("feed")).toEqual({ networkRequested: false, network: true });

    // A rename keeps the code the person allowed.
    await dispatchOperation("html.rename", { spaceId: "meta", widgetId: "feed", name: "Feed v2" }, { surface: "released" });
    expect((await opened("feed")).network).toBe(true);

    await dispatchOperation("html.update", { spaceId: "meta", widgetId: "feed", html: `${html}<!-- edit -->` }, { surface: "released" });
    expect(await opened("feed")).toEqual({ networkRequested: true, network: false });

    // Over REST too, an agent's write only asks.
    caller = agent(["*"]);
    expect((await req("PUT", "/api/spaces/meta/widgets/feed", { name: "Feed", html, permissions: { network: true } })).status).toBe(200);
    expect(await opened("feed")).toEqual({ networkRequested: true, network: false });
    // The notice names who asked.
    expect((await req("GET", "/api/spaces/meta/documents/page?path=feed")).json.page.networkRequestedBy).toBe("Claude Code");
  });

  it("counts people by how they signed in, not by a token's label", () => {
    const human = { agent: null, principal: { id: "member:sam", type: "human" as const, displayName: "Sam" } };
    expect(isPersonWriter(ownerIdentity())).toBe(true);
    expect(isPersonWriter({ ...human, credentialClass: "browser" })).toBe(true);
    expect(isPersonWriter({ ...human, credentialClass: "local", team: { worktableId: "w", memberId: "m" } })).toBe(true);
    expect(isPersonWriter({ ...human, credentialClass: "local", team: { worktableId: "w", memberId: "m", agentId: "a" } })).toBe(false);
    expect(isPersonWriter({ ...human, credentialClass: "local", principal: { ...human.principal, id: "local-token:abc" } })).toBe(false);
    expect(isPersonWriter({ ...human, credentialClass: "resource" })).toBe(false);
    expect(isPersonWriter(agent(["*"]))).toBe(false);
  });

  it("lets a write grant only the Record access its writer holds", async () => {
    const write = (scopes: string[], records: Record<string, Record<string, boolean>>) =>
      dispatchOperation(
        "html.create",
        { spaceId: "meta", id: "board", name: "Board", html, permissions: { records } },
        { surface: "released", scopes }
      );
    await expect(write(["widgets:write"], { "*": { read: true } })).rejects.toThrow("needs records:read");
    await expect(write(["widgets:write", "records:read"], { tasks: { read: true, update: true } })).rejects.toThrow("needs records:write");
    expect((await req("GET", "/api/spaces/meta/widgets/board")).status).toBe(404);
    await write(["widgets:write", "records:read"], { tasks: { read: true } });

    // Editing the code counts as granting the access the Doc keeps.
    caller = agent(["widgets:write"]);
    const edited = await req("PUT", "/api/spaces/meta/widgets/board", { name: "Board", html: `${html}<!-- edit -->` });
    expect(edited.status).toBe(403);
    expect(edited.json.missingScope).toBe("records:read");
  });


});
