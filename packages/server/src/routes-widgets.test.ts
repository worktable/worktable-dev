import { ownerIdentity } from "./auth.ts";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { JSDOM } from "jsdom";
import { join } from "node:path";
import { Hono } from "hono";
import { ensureWorkspaceManifest, setWorkspaceRootOverride } from "./workspace.ts";
import { setAppDirOverride } from "./app-storage.ts";
import { spacesRouter } from "./routes/spaces.ts";
import { widgetsRouter } from "./routes/widgets.ts";
import { setDocumentLifecycleStepHookForTests } from "./document-lifecycle-journal.ts";
import { dispatchOperation } from "./mcp/dispatcher.ts";

function buildTestApp() {
  const app = new Hono();
  // Route behavior fixtures enter after the production identity boundary.
  app.use("*", async (c, next) => {
    c.set("identity", ownerIdentity());
    await next();
  });
  app.onError((err, c) => c.json({ error: err.message, code: "INTERNAL_ERROR" }, 500));
  app.route("/api/spaces", spacesRouter);
  app.route("/api/spaces/:spaceId/widgets", widgetsRouter);
  return app;
}

async function req(app: Hono, method: string, path: string, body?: unknown) {
  const res = await app.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  }));
  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  return { status: res.status, text, json: contentType.includes("json") && text ? JSON.parse(text) : null, headers: res.headers };
}

const testDir = join(tmpdir(), `worktable-widget-routes-${Date.now()}`);
const appDir = join(tmpdir(), `worktable-widget-routes-app-${Date.now()}`);

describe("widget REST routes", () => {
  let app: Hono;

  beforeEach(async () => {
    const spacesDir = join(testDir, "spaces");
    setWorkspaceRootOverride(testDir);
    setAppDirOverride(appDir);
    ensureWorkspaceManifest();
    mkdirSync(spacesDir, { recursive: true });
    app = buildTestApp();
    await req(app, "POST", "/api/spaces", { name: "Meta" });
  });

  afterEach(() => {
    setDocumentLifecycleStepHookForTests(null);
    setWorkspaceRootOverride(null);
    setAppDirOverride(null);
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    if (existsSync(appDir)) rmSync(appDir, { recursive: true, force: true });
  });

  it("creates, lists, reads, and serves sandboxed HTML widgets", async () => {
    const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>:root{--ad-bg:#fff;--ad-surface:#fff;--ad-text:#111;--ad-muted:#666;--ad-border:#ddd;--ad-accent:#2563eb}html[data-theme="dark"]{--ad-bg:#111;--ad-surface:#222;--ad-text:#fff;--ad-muted:#aaa;--ad-border:#333;--ad-accent:#8ab4ff}body{background:var(--ad-bg);color:var(--ad-text)}</style></head><body><button>Open</button><script>document.body.dataset.ready='yes'</script></body></html>`;
    const createRes = await req(app, "POST", "/api/spaces/meta/widgets", {
      id: "open-items",
      name: "Open Items",
      description: "Tracks open work.",
      html,
    });

    expect(createRes.status).toBe(201);
    expect(createRes.json.widgetId).toBe("open-items");

    const yaml = await readFile(join(testDir, "spaces", "meta", "widgets", "open-items", "widget.yaml"), "utf8");
    expect(yaml).toContain('kind: "worktable.widget"');
    expect(await readFile(join(testDir, "spaces", "meta", "widgets", "open-items", "index.html"), "utf8")).toBe(html);

    const listRes = await req(app, "GET", "/api/spaces/meta/widgets");
    expect(listRes.status).toBe(200);
    expect(listRes.json.widgets).toHaveLength(1);

    const contentRes = await req(app, "GET", "/api/spaces/meta/widgets/open-items/content?theme=dark");
    expect(contentRes.status).toBe(200);
    expect(contentRes.text).toContain('data-theme="dark"');
    expect(contentRes.headers.get("content-security-policy")).toContain("connect-src 'self';");
    expect(contentRes.text).toContain("window.worktable");
    expect(contentRes.text).toContain('data-worktable-runtime="host-smoothness"');
    expect(contentRes.text).toContain('data-worktable-runtime="sdk"');
    expect(contentRes.text).toContain("__worktableDiagnostics");
  });

  it("surfaces smoothness warnings for brittle widget patterns without blocking creation", async () => {
    const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>:root{--ad-bg:#fff;--ad-surface:#fff;--ad-text:#111;--ad-muted:#666;--ad-border:#ddd;--ad-accent:#2563eb}html[data-theme="dark"]{--ad-bg:#111;--ad-surface:#222;--ad-text:#fff;--ad-muted:#aaa;--ad-border:#333;--ad-accent:#8ab4ff}</style></head><body><form><input name="title"><button>Save</button></form><script>localStorage.setItem('x','y'); fetch('/api/spaces/meta/records/tasks')</script></body></html>`;
    const createRes = await req(app, "POST", "/api/spaces/meta/widgets", {
      id: "brittle-patterns",
      name: "Brittle Patterns",
      html,
    });

    expect(createRes.status).toBe(201);
    const warningCodes = createRes.json.warnings.map((issue: { code: string }) => issue.code);
    expect(warningCodes).toContain("form_submit_sandbox");
    expect(warningCodes).toContain("browser_storage");
    expect(warningCodes).toContain("direct_worktable_api_fetch");
  });

  it("suggests missing record permissions inferred from worktable.records usage", async () => {
    const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>:root{--ad-bg:#fff;--ad-surface:#fff;--ad-text:#111;--ad-muted:#666;--ad-border:#ddd;--ad-accent:#2563eb}html[data-theme="dark"]{--ad-bg:#111;--ad-surface:#222;--ad-text:#fff;--ad-muted:#aaa;--ad-border:#333;--ad-accent:#8ab4ff}</style></head><body><button id="load">Load</button><script>document.getElementById('load').addEventListener('click', async () => { await worktable.records.query("tasks"); await worktable.records.create("tasks", { title: "Review" }); });</script></body></html>`;
    const createRes = await req(app, "POST", "/api/spaces/meta/widgets", {
      id: "record-permission-hints",
      name: "Record Permission Hints",
      html,
      permissions: { records: { tasks: { read: true } } },
    });

    expect(createRes.status).toBe(201);
    const permissionWarnings = createRes.json.warnings.filter((issue: { code: string }) => issue.code === "missing_record_permission");
    expect(permissionWarnings).toHaveLength(1);
    expect(permissionWarnings[0].message).toContain("tasks");
    expect(permissionWarnings[0].message).toContain("create");
    expect(permissionWarnings[0].hint).toContain("permissions.records.tasks.create");
    expect(permissionWarnings[0].suggestedPermissions.records.tasks.create).toBe(true);

    const updateRes = await req(app, "PUT", "/api/spaces/meta/widgets/record-permission-hints", {
      name: "Record Permission Hints",
      html,
      permissions: { records: { tasks: { read: true, create: true } } },
    });
    expect(updateRes.status).toBe(200);
    expect(updateRes.json.warnings.some((issue: { code: string }) => issue.code === "missing_record_permission")).toBe(false);
  });

  it("classifies polish-only validation feedback as hints", async () => {
    const createRes = await req(app, "POST", "/api/spaces/meta/widgets", {
      id: "polish-hints",
      name: "Polish Hints",
      html: "<!doctype html><html><head></head><body><button onclick=\"alert('hi')\">Hi</button></body></html>",
    });

    expect(createRes.status).toBe(201);
    const severitiesByCode = Object.fromEntries(createRes.json.warnings.map((issue: { code: string; severity: string }) => [issue.code, issue.severity]));
    expect(severitiesByCode.missing_viewport).toBe("hint");
    expect(severitiesByCode.inline_event_handler).toBe("hint");
    expect(severitiesByCode.missing_dark_theme).toBe("hint");
  });

  it("injects a runtime that prevents unsafe form navigation and reports diagnostics", async () => {
    const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>:root{--ad-bg:#fff;--ad-surface:#fff;--ad-text:#111;--ad-muted:#666;--ad-border:#ddd;--ad-accent:#2563eb}html[data-theme="dark"]{--ad-bg:#111;--ad-surface:#222;--ad-text:#fff;--ad-muted:#aaa;--ad-border:#333;--ad-accent:#8ab4ff}</style></head><body><form id="task-form"><input name="title"><button>Save</button></form></body></html>`;
    await req(app, "POST", "/api/spaces/meta/widgets", {
      id: "runtime-form",
      name: "Runtime Form",
      html,
    });

    const contentRes = await req(app, "GET", "/api/spaces/meta/widgets/runtime-form/content?theme=light");
    expect(contentRes.status).toBe(200);
    const dom = new JSDOM(contentRes.text, { url: "http://localhost/api/spaces/meta/widgets/runtime-form/content", runScripts: "dangerously" } as ConstructorParameters<typeof JSDOM>[1]);
    const form = dom.window.document.querySelector("form");
    expect(form).not.toBeNull();
    const event = new dom.window.Event("submit", { bubbles: true, cancelable: true });
    form!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    const runtime = dom.window as unknown as { worktable: unknown; agentdash: unknown };
    expect(runtime.worktable).toBeDefined();
    expect(runtime.agentdash).toBe(runtime.worktable);
    const diagnostics = (dom.window as unknown as { __worktableDiagnostics: Array<{ code: string }> }).__worktableDiagnostics;
    expect(diagnostics.some((diagnostic) => diagnostic.code === "form_submit_intercepted")).toBe(true);
  });

  it("reports exact missing widget permissions from runtime API failures", async () => {
    const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>:root{--ad-bg:#fff;--ad-surface:#fff;--ad-text:#111;--ad-muted:#666;--ad-border:#ddd;--ad-accent:#2563eb}html[data-theme="dark"]{--ad-bg:#111;--ad-surface:#222;--ad-text:#fff;--ad-muted:#aaa;--ad-border:#333;--ad-accent:#8ab4ff}</style></head><body></body></html>`;
    await req(app, "POST", "/api/spaces/meta/widgets", {
      id: "runtime-permissions",
      name: "Runtime Permissions",
      html,
      permissions: { records: { tasks: { read: true } } },
    });

    const forbidden = await req(app, "DELETE", "/api/spaces/meta/widgets/runtime-permissions/records/tasks/example-task");
    expect(forbidden.status).toBe(403);
    expect(forbidden.json.missingPermission).toBe("permissions.records.tasks.delete");
    expect(forbidden.json.suggestedPermissions.records.tasks.delete).toBe(true);

    const contentRes = await req(app, "GET", "/api/spaces/meta/widgets/runtime-permissions/content?theme=light");
    const dom = new JSDOM(contentRes.text, {
      url: "http://localhost/api/spaces/meta/widgets/runtime-permissions/content",
      runScripts: "dangerously",
      beforeParse(window: Window) {
        // The runtime brokers API calls through the parent window via postMessage
        // (the sandboxed iframe can't fetch /api directly when exposed). Simulate
        // the parent broker: answer worktable.api.request with the 403 response.
        const win = window as unknown as {
          addEventListener: Window["addEventListener"];
          dispatchEvent: Window["dispatchEvent"];
          parent: Window;
          MessageEvent: typeof MessageEvent;
        };
        win.addEventListener("message", (event: MessageEvent) => {
          const data = event.data as { type?: string; id?: string } | undefined;
          if (data?.type !== "worktable.api.request" || typeof data.id !== "string") return;
          // Deliver the response with source=parent (as a real browser does for a
          // cross-frame post); the runtime only trusts responses from window.parent.
          // JSDOM's window.postMessage sets source=null, so construct the event.
          win.dispatchEvent(
            new win.MessageEvent("message", {
              data: { type: "worktable.api.response", id: data.id, ok: false, status: 403, body: forbidden.json },
              source: win.parent as unknown as MessageEventSource,
            })
          );
        });
      },
    } as ConstructorParameters<typeof JSDOM>[1]);

    await expect((dom.window as unknown as { worktable: { records: { delete: (collectionId: string, recordId: string) => Promise<unknown> } } }).worktable.records.delete("tasks", "example-task")).rejects.toThrow("Widget lacks delete permission");
    const diagnostics = (dom.window as unknown as { __worktableDiagnostics: Array<{ code: string; hint?: string; detail?: { missingPermission?: string } }> }).__worktableDiagnostics;
    expect(diagnostics.some((diagnostic) => diagnostic.code === "missing_widget_permission" && diagnostic.hint?.includes("permissions.records.tasks.delete") && diagnostic.detail?.missingPermission === "permissions.records.tasks.delete")).toBe(true);
  });

  it("allows external links but rejects external widget assets", async () => {
    const linkRes = await req(app, "POST", "/api/spaces/meta/widgets", {
      name: "Linked Widget",
      html: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><a href="https://example.com/reference">External reference</a></body></html>`,
    });

    expect(linkRes.status).toBe(201);

    const createRes = await req(app, "POST", "/api/spaces/meta/widgets", {
      name: "Bad Widget",
      html: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><script src="https://example.com/app.js"></script></head><body></body></html>`,
    });

    expect(createRes.status).toBe(400);
    expect(createRes.json.code).toBe("external_script");
    expect(createRes.json.warnings.some((issue: { code: string }) => issue.code === "external_script")).toBe(true);
  });

  it("patches, archives, restores, and deletes widgets without rewriting HTML", async () => {
    const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>:root{--ad-bg:#fff;--ad-surface:#fff;--ad-text:#111;--ad-muted:#666;--ad-border:#ddd;--ad-accent:#2563eb}html[data-theme="dark"]{--ad-bg:#111;--ad-surface:#222;--ad-text:#fff;--ad-muted:#aaa;--ad-border:#333;--ad-accent:#8ab4ff}body{background:var(--ad-bg);color:var(--ad-text)}</style></head><body><h1>Original</h1></body></html>`;
    await req(app, "POST", "/api/spaces/meta/widgets", {
      id: "lifecycle",
      name: "Lifecycle",
      html,
    });

    const patchRes = await req(app, "PATCH", "/api/spaces/meta/widgets/lifecycle", {
      name: "Lifecycle Renamed",
      description: "Updated metadata only.",
    });
    expect(patchRes.status).toBe(200);
    expect(patchRes.json.widget.name).toBe("Lifecycle Renamed");
    expect(await readFile(join(testDir, "spaces", "meta", "widgets", "lifecycle", "index.html"), "utf8")).toBe(html);

    const archiveRes = await req(app, "POST", "/api/spaces/meta/widgets/lifecycle/archive", { reason: "done" });
    expect(archiveRes.status).toBe(200);
    expect(archiveRes.json.widget.archive.reason).toBe("done");

    const defaultList = await req(app, "GET", "/api/spaces/meta/widgets");
    expect(defaultList.json.widgets).toHaveLength(0);
    const allList = await req(app, "GET", "/api/spaces/meta/widgets?includeArchived=true");
    expect(allList.json.widgets).toHaveLength(1);

    const restoreRes = await req(app, "POST", "/api/spaces/meta/widgets/lifecycle/restore");
    expect(restoreRes.status).toBe(200);
    expect(restoreRes.json.widget.archive).toBeNull();

    const deleteRes = await req(app, "DELETE", "/api/spaces/meta/widgets/lifecycle");
    expect(deleteRes.status).toBe(200);
    expect((await req(app, "GET", "/api/spaces/meta/widgets/lifecycle")).status).toBe(404);
    const contentRes = await req(app, "GET", "/api/spaces/meta/widgets/lifecycle/content");
    expect(contentRes.status).toBe(404);
    expect((await req(app, "DELETE", "/api/spaces/meta/widgets/lifecycle")).status).toBe(404);
    expect((await req(app, "DELETE", "/api/spaces/missing/widgets/lifecycle")).status).toBe(404);
  });

  it("does not let queued bundle writers recreate a deleted generation", async () => {
    const generationHtml = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>:root{--ad-bg:#fff;--ad-surface:#fff;--ad-text:#111;--ad-muted:#666;--ad-border:#ddd;--ad-accent:#2563eb}html[data-theme="dark"]{--ad-bg:#111;--ad-surface:#222;--ad-text:#fff;--ad-muted:#aaa;--ad-border:#333;--ad-accent:#8ab4ff}</style></head><body><p>generation</p></body></html>`;
    const created = await req(app, "POST", "/api/spaces/meta/widgets", {
      id: "lifecycle-race",
      name: "Lifecycle race",
      html: generationHtml,
    });
    expect(created.status).toBe(201);
    const versions = await req(
      app,
      "GET",
      "/api/spaces/meta/widgets/lifecycle-race/versions?all=true"
    );
    const versionId = versions.json.versions[0].id as string;

    let reachedDeletePreApply!: () => void;
    const deletePreApply = new Promise<void>((resolve) => {
      reachedDeletePreApply = resolve;
    });
    let continueDeletion!: () => void;
    const deletionCanContinue = new Promise<void>((resolve) => {
      continueDeletion = resolve;
    });
    setDocumentLifecycleStepHookForTests((step) => {
      if (step !== "share-revoked") return;
      reachedDeletePreApply();
      return deletionCanContinue;
    });

    const deletion = req(
      app,
      "DELETE",
      "/api/spaces/meta/widgets/lifecycle-race"
    );
    await deletePreApply;
    const stateWrite = req(
      app,
      "PUT",
      "/api/spaces/meta/widgets/lifecycle-race/state",
      { state: { stale: true } }
    );
    const archiveWrite = req(
      app,
      "POST",
      "/api/spaces/meta/widgets/lifecycle-race/archive",
      {}
    );
    const restUpdate = req(
      app,
      "PUT",
      "/api/spaces/meta/widgets/lifecycle-race",
      {
        name: "Stale REST update",
        html: generationHtml.replace("generation", "stale REST update"),
      }
    );
    const versionRestore = req(
      app,
      "POST",
      `/api/spaces/meta/widgets/lifecycle-race/versions/${versionId}/restore`,
      {}
    );
    const mcpUpdate = dispatchOperation("html.update", {
      spaceId: "meta",
      widgetId: "lifecycle-race",
      name: "Stale MCP update",
      html: generationHtml.replace("generation", "stale MCP update"),
    }).then(
      () => null,
      (error: unknown) => error
    );
    // Request-body parsing is asynchronous. Give every independent mutator one
    // event-loop turn to reach the generation lock before deletion continues.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    continueDeletion();

    const [deleted, state, archived, rest, restored, mcpError] = await Promise.all([
      deletion,
      stateWrite,
      archiveWrite,
      restUpdate,
      versionRestore,
      mcpUpdate,
    ]);
    expect(deleted.status).toBe(200);
    expect(state.status).toBe(404);
    expect(archived.status).toBe(404);
    expect(rest.status).toBe(404);
    expect(restored.status).toBe(404);
    expect((mcpError as Error | null)?.message).toMatch(/not found/i);
    expect(
      (await req(app, "GET", "/api/spaces/meta/widgets/lifecycle-race"))
        .status
    ).toBe(404);
  });

  it("widens widget CSP connect-src only when the network permission is granted", async () => {
    await req(app, "POST", "/api/spaces/meta/widgets", {
      id: "offline-widget",
      name: "Offline",
      html: "<!doctype html><html><head></head><body></body></html>",
    });
    await req(app, "POST", "/api/spaces/meta/widgets", {
      id: "online-widget",
      name: "Online",
      html: "<!doctype html><html><head></head><body></body></html>",
      permissions: { network: true },
    });

    const offline = await req(app, "GET", "/api/spaces/meta/widgets/offline-widget/content");
    const online = await req(app, "GET", "/api/spaces/meta/widgets/online-widget/content");
    const offlineCsp = offline.headers.get("content-security-policy") ?? "";
    const onlineCsp = online.headers.get("content-security-policy") ?? "";

    expect(offlineCsp).toContain("connect-src 'self';");
    expect(offlineCsp).not.toContain("https:");
    expect(onlineCsp).toContain("connect-src 'self' ws: wss: https:");
  });

  it("strips legacy workspace permissions sent by older clients instead of failing", async () => {
    const res = await req(app, "POST", "/api/spaces/meta/widgets", {
      id: "legacy-perms",
      name: "Legacy",
      html: "<!doctype html><html><head></head><body></body></html>",
      permissions: { workspaceRead: true, workspaceWrite: true, records: {} },
    });
    expect(res.status).toBe(201);
    const yaml = await readFile(join(testDir, "spaces", "meta", "widgets", "legacy-perms", "widget.yaml"), "utf8");
    expect(yaml).not.toContain("workspaceRead");
    expect(yaml).not.toContain("workspaceWrite");
  });
});
