import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { setAppDirOverride } from "./app-storage.ts";
import { setWorkspaceRootOverride } from "./workspace.ts";
import {
  getServerSettings,
  invalidateServerSettingsCache,
  SETTINGS_DEFAULTS,
  updateServerSettings,
  updateServerSettingsWithResult,
} from "./settings-store.ts";
import { systemRouter } from "./routes/system.ts";
import { mcpBearerRequired, publicSurfaceAuthRequired, trustedLocalIdentity } from "./auth.ts";
import { createToken } from "./token-store.ts";
import { setOwnerPassword } from "./session-store.ts";

let appDir: string;
let workspaceDir: string;
const originalEnv = { ...process.env };

function settingsPath(): string {
  return join(appDir, "settings.json");
}

// Same identity stack the real server mounts on /api/*, so the owner gate runs
// exactly as in production.
function app() {
  const a = new Hono();
  a.use("/api/*", trustedLocalIdentity());
  a.route("/api/system", systemRouter);
  return a;
}

beforeEach(() => {
  appDir = mkdtempSync(join(tmpdir(), "wt-settings-app-"));
  workspaceDir = mkdtempSync(join(tmpdir(), "wt-settings-ws-"));
  setAppDirOverride(appDir);
  setWorkspaceRootOverride(workspaceDir);
  invalidateServerSettingsCache();
  delete process.env["WORKTABLE_REQUIRE_AUTH"];
  delete process.env["WORKTABLE_PUBLIC_URL"];
  delete process.env["HOST"];
});

afterEach(() => {
  setAppDirOverride(null);
  setWorkspaceRootOverride(null);
  invalidateServerSettingsCache();
  rmSync(appDir, { recursive: true, force: true });
  rmSync(workspaceDir, { recursive: true, force: true });
  process.env = { ...originalEnv };
});

describe("settings-store", () => {
  it("returns defaults on first read", () => {
    const s = getServerSettings();
    expect(s).toEqual(SETTINGS_DEFAULTS);
    expect(s.updates.autoCheck).toBe(true);
    expect(s.editor.spellcheck).toBe(false);
  });

  it("patches, deep-merges, and re-reads persisted values", async () => {
    await updateServerSettings({ updates: { autoCheck: false } });
    // editor group untouched by an updates-only patch (deep merge, not replace).
    invalidateServerSettingsCache();
    const s = getServerSettings();
    expect(s.updates.autoCheck).toBe(false);
    expect(s.editor.spellcheck).toBe(false);

    await updateServerSettings({ editor: { spellcheck: true } });
    invalidateServerSettingsCache();
    const s2 = getServerSettings();
    expect(s2.updates.autoCheck).toBe(false); // preserved across a second group patch
    expect(s2.editor.spellcheck).toBe(true);
  });

  it("writes settings.json at mode 0600", async () => {
    await updateServerSettings({ updates: { autoCheck: false } });
    const mode = statSync(settingsPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("tolerates a partially-valid file, falling back per-field", () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({ version: 1, updates: { autoCheck: "nope" }, editor: { spellcheck: true }, extra: 1 }),
    );
    invalidateServerSettingsCache();
    const s = getServerSettings();
    expect(s.updates.autoCheck).toBe(true); // wrong type → default
    expect(s.editor.spellcheck).toBe(true); // valid → kept
    expect((s as unknown as Record<string, unknown>)["extra"]).toBeUndefined(); // unknown key dropped
  });

  it("quarantines corrupt JSON as .corrupt, resets to defaults, and fails closed", async () => {
    writeFileSync(settingsPath(), "{ this is not json ");
    invalidateServerSettingsCache();
    const s = getServerSettings(); // must not throw
    expect(s).toEqual(SETTINGS_DEFAULTS);
    expect(existsSync(`${settingsPath()}.corrupt`)).toBe(true);
    expect(readFileSync(`${settingsPath()}.corrupt`, "utf8")).toBe("{ this is not json ");
    expect(publicSurfaceAuthRequired()).toBe(true);
    expect(await mcpBearerRequired()).toBe(true);
    // The reset file is valid defaults JSON again.
    expect(JSON.parse(readFileSync(settingsPath(), "utf8"))).toEqual(SETTINGS_DEFAULTS);
    invalidateServerSettingsCache();
    expect(publicSurfaceAuthRequired()).toBe(true);

    await updateServerSettings({ updates: { autoCheck: false } });
    invalidateServerSettingsCache();
    expect(publicSurfaceAuthRequired()).toBe(false);
  });
});

describe("GET /api/system/settings", () => {
  it("returns full settings without an owner gate", async () => {
    const res = await app().fetch(new Request("http://localhost/api/system/settings"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SETTINGS_DEFAULTS);
  });
});

describe("PUT /api/system/settings", () => {
  function put(body: unknown, headers: Record<string, string> = {}): Request {
    return new Request("http://localhost/api/system/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  it("merges a valid patch and returns the result (owner on loopback)", async () => {
    const res = await app().fetch(put({ updates: { autoCheck: false } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof SETTINGS_DEFAULTS;
    expect(body.updates.autoCheck).toBe(false);
  });

  it("rejects an array group with 400 (arrays satisfy typeof object)", async () => {
    const res = await app().fetch(put({ updates: [] }));
    expect(res.status).toBe(400);
    const history = await app().fetch(put({ history: [] }));
    expect(history.status).toBe(400);
    const top = await app().fetch(put([]));
    expect(top.status).toBe(400);
  });

  it("rejects an unknown group with 400", async () => {
    const res = await app().fetch(put({ nope: true }));
    expect(res.status).toBe(400);
  });

  it("rejects an unknown field with 400", async () => {
    const res = await app().fetch(put({ editor: { fontSize: 12 } }));
    expect(res.status).toBe(400);
  });

  it("rejects a wrong-typed field with 400", async () => {
    const res = await app().fetch(put({ updates: { autoCheck: "yes" } }));
    expect(res.status).toBe(400);
  });

  it("forbids a non-owner (scoped token) with 403", async () => {
    const { token } = await createToken({ scopes: ["docs:read"] });
    const res = await app().fetch(
      put({ updates: { autoCheck: false } }, { Authorization: `Bearer ${token}` }),
    );
    expect(res.status).toBe(403);
  });

  it("rejects a bare request that tries to clear a configured public URL", async () => {
    await updateServerSettings({
      network: { publicUrl: "https://worktable.example.com" },
    });
    const res = await app().fetch(put({ network: { publicUrl: null } }));
    expect(res.status).toBe(401);
    expect(getServerSettings().network.publicUrl).toBe("https://worktable.example.com");
  });

  it("requires an owner password before enabling a public URL", async () => {
    const res = await app().fetch(
      put({ network: { publicUrl: "https://worktable.example.com" } }),
    );
    expect(res.status).toBe(409);
    expect(getServerSettings().network.publicUrl).toBeNull();
  });
});

describe("concurrent patches", () => {
  it("two simultaneous PUTs to different groups both survive", async () => {
    const [a, b] = await Promise.all([
      updateServerSettings({ updates: { autoCheck: false } }),
      updateServerSettings({ editor: { spellcheck: true } }),
    ]);
    // Regardless of completion order, the final persisted state has both.
    invalidateServerSettingsCache();
    const final = getServerSettings();
    expect(final.updates.autoCheck).toBe(false);
    expect(final.editor.spellcheck).toBe(true);
    // And the later return value already reflects the earlier write.
    const later = [a, b].find(
      (s) => s.updates.autoCheck === false && s.editor.spellcheck === true,
    );
    expect(later).toBeDefined();
  });

  it("a failing patch doesn't poison later writes", async () => {
    const bad = updateServerSettings({
      updates: { autoCheck: "nope" as unknown as boolean },
    });
    await expect(bad).rejects.toThrow(/must be a boolean/);
    const ok = await updateServerSettings({ updates: { autoCheck: false } });
    expect(ok.updates.autoCheck).toBe(false);
  });

  it("reports retention changes from the serialized previous state", async () => {
    await updateServerSettings({
      history: { retention: { mode: "count", maxPerDoc: 1 } },
    });

    const relax = updateServerSettingsWithResult({
      history: { retention: { mode: "count", maxPerDoc: 5 } },
    });
    const tighten = updateServerSettingsWithResult({
      history: { retention: { mode: "count", maxPerDoc: 1 } },
    });
    const [relaxed, tightened] = await Promise.all([relax, tighten]);

    expect(relaxed.previous.history.retention).toEqual({
      mode: "count",
      maxPerDoc: 1,
    });
    expect(relaxed.settings.history.retention).toEqual({
      mode: "count",
      maxPerDoc: 5,
    });
    expect(relaxed.retentionChanged).toBe(true);
    expect(tightened.previous.history.retention).toEqual({
      mode: "count",
      maxPerDoc: 5,
    });
    expect(tightened.settings.history.retention).toEqual({
      mode: "count",
      maxPerDoc: 1,
    });
    expect(tightened.retentionChanged).toBe(true);
  });
});

describe("network.publicUrl settings", () => {
  function put(body: unknown, headers: Record<string, string> = {}): Request {
    return new Request("http://localhost/api/system/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  it("defaults to null", () => {
    expect(getServerSettings().network.publicUrl).toBeNull();
  });

  it("GET includes the network group", async () => {
    const res = await app().fetch(new Request("http://localhost/api/system/settings"));
    const body = (await res.json()) as { network: { publicUrl: string | null } };
    expect(body.network.publicUrl).toBeNull();
  });

  it("normalizes a trailing-slash origin on write", async () => {
    await setOwnerPassword("owner-password");
    const res = await app().fetch(put({ network: { publicUrl: "https://x.com/" } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { network: { publicUrl: string | null } };
    expect(body.network.publicUrl).toBe("https://x.com");
    invalidateServerSettingsCache();
    expect(getServerSettings().network.publicUrl).toBe("https://x.com");
  });

  it("rejects a URL with a path", async () => {
    expect((await app().fetch(put({ network: { publicUrl: "https://x.com/wiki" } }))).status).toBe(400);
  });

  it("rejects a URL with a query string", async () => {
    expect((await app().fetch(put({ network: { publicUrl: "https://x.com/?a=1" } }))).status).toBe(400);
  });

  it("rejects a URL with a fragment", async () => {
    expect((await app().fetch(put({ network: { publicUrl: "https://x.com/#top" } }))).status).toBe(400);
  });

  it("rejects a non-http scheme", async () => {
    expect((await app().fetch(put({ network: { publicUrl: "ftp://x.com" } }))).status).toBe(400);
  });

  it("rejects a wrong-typed value (number)", async () => {
    expect((await app().fetch(put({ network: { publicUrl: 42 } }))).status).toBe(400);
  });

  it("rejects an array group with 400", async () => {
    expect((await app().fetch(put({ network: [] }))).status).toBe(400);
  });

  it("rejects an unknown network field with 400", async () => {
    expect((await app().fetch(put({ network: { nope: true } }))).status).toBe(400);
  });

  it("clears on empty string", async () => {
    await setOwnerPassword("owner-password");
    await app().fetch(put({ network: { publicUrl: "https://x.com" } }));
    const { token } = await createToken({ scopes: ["*"], agent: null });
    const res = await app().fetch(
      put({ network: { publicUrl: "" } }, { Authorization: `Bearer ${token}` }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { network: { publicUrl: string | null } };
    expect(body.network.publicUrl).toBeNull();
  });

  it("clears on null", async () => {
    await setOwnerPassword("owner-password");
    await app().fetch(put({ network: { publicUrl: "https://x.com" } }));
    const { token } = await createToken({ scopes: ["*"], agent: null });
    const res = await app().fetch(
      put({ network: { publicUrl: null } }, { Authorization: `Bearer ${token}` }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { network: { publicUrl: string | null } };
    expect(body.network.publicUrl).toBeNull();
  });

  it("tolerantly reads a garbage stored value as null", () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({ version: 1, network: { publicUrl: "not a url" } }),
    );
    invalidateServerSettingsCache();
    expect(getServerSettings().network.publicUrl).toBeNull();
  });

  it("tolerantly keeps a valid stored origin", () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({ version: 1, network: { publicUrl: "https://kept.example.com" } }),
    );
    invalidateServerSettingsCache();
    expect(getServerSettings().network.publicUrl).toBe("https://kept.example.com");
  });
});

describe("history.retention settings", () => {
  function put(body: unknown): Request {
    return new Request("http://localhost/api/system/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("defaults to keep-all", () => {
    expect(getServerSettings().history.retention).toEqual({ mode: "all" });
  });

  it("GET includes the history group", async () => {
    const res = await app().fetch(new Request("http://localhost/api/system/settings"));
    const body = (await res.json()) as { history: { retention: unknown } };
    expect(body.history.retention).toEqual({ mode: "all" });
  });

  it("roundtrips an age policy and preserves sibling groups", async () => {
    const res = await app().fetch(put({ history: { retention: { mode: "age", maxAgeDays: 30 } } }));
    expect(res.status).toBe(200);
    invalidateServerSettingsCache();
    const s = getServerSettings();
    expect(s.history.retention).toEqual({ mode: "age", maxAgeDays: 30 });
    expect(s.updates.autoCheck).toBe(true); // untouched
  });

  it("roundtrips a count policy", async () => {
    const res = await app().fetch(put({ history: { retention: { mode: "count", maxPerDoc: 50 } } }));
    expect(res.status).toBe(200);
    invalidateServerSettingsCache();
    expect(getServerSettings().history.retention).toEqual({ mode: "count", maxPerDoc: 50 });
  });

  it("rejects an unknown mode with 400", async () => {
    expect((await app().fetch(put({ history: { retention: { mode: "forever" } } }))).status).toBe(400);
  });

  it("rejects a non-integer numeric field with 400", async () => {
    expect(
      (await app().fetch(put({ history: { retention: { mode: "age", maxAgeDays: 3.5 } } }))).status,
    ).toBe(400);
  });

  it("rejects a non-positive numeric field with 400", async () => {
    expect(
      (await app().fetch(put({ history: { retention: { mode: "count", maxPerDoc: 0 } } }))).status,
    ).toBe(400);
  });

  it("rejects an over-cap numeric field with 400", async () => {
    expect(
      (await app().fetch(put({ history: { retention: { mode: "age", maxAgeDays: 4000 } } }))).status,
    ).toBe(400);
    expect(
      (await app().fetch(put({ history: { retention: { mode: "count", maxPerDoc: 20000 } } }))).status,
    ).toBe(400);
  });

  it("rejects an unknown retention field with 400", async () => {
    expect(
      (await app().fetch(put({ history: { retention: { mode: "age", maxAgeDays: 30, extra: 1 } } }))).status,
    ).toBe(400);
  });

  it("rejects an unknown history field with 400", async () => {
    expect((await app().fetch(put({ history: { nope: true } }))).status).toBe(400);
  });

  it("tolerantly falls back to keep-all for a stored invalid policy", () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({ version: 1, history: { retention: { mode: "age", maxAgeDays: -5 } } }),
    );
    invalidateServerSettingsCache();
    expect(getServerSettings().history.retention).toEqual({ mode: "all" });
  });

  it("tolerantly keeps a valid stored policy", () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({ version: 1, history: { retention: { mode: "count", maxPerDoc: 10 } } }),
    );
    invalidateServerSettingsCache();
    expect(getServerSettings().history.retention).toEqual({ mode: "count", maxPerDoc: 10 });
  });
});
