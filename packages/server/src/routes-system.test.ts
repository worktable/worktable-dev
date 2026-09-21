import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getDeploymentInfo,
  systemRouter,
  type DeploymentInfo,
} from "./routes/system.ts";
import { setAppDirOverride } from "./app-storage.ts";
import { readUpdateStatus, writeUpdateStatus } from "./update-runner.ts";
import { trustedLocalIdentity } from "./auth.ts";
import { createToken } from "./token-store.ts";

// Real temp dirs, no mocks: the version route's canUpdate is derived from an
// actual install.sh on disk plus the launcher env contract, so we exercise both.
const originalEnv = { ...process.env };
let releaseDir: string;
let appDir: string;

// Compose with the same identity middleware the real server mounts on /api/*,
// so the owner gate is exercised the way it actually runs.
function app() {
  const a = new Hono();
  a.use("/api/*", trustedLocalIdentity());
  a.route("/api/system", systemRouter);
  return a;
}

function routeApp() {
  return new Hono().route("/api/system", systemRouter);
}

beforeEach(() => {
  releaseDir = mkdtempSync(join(tmpdir(), "wt-release-"));
  appDir = mkdtempSync(join(tmpdir(), "wt-appdir-"));
  setAppDirOverride(appDir);
  process.env["WORKTABLE_RELEASE_DIR"] = releaseDir;
  delete process.env["WORKTABLE_LAUNCHER"];
  delete process.env["WORKTABLE_REQUIRE_AUTH"];
  delete process.env["HOST"];
});

afterEach(() => {
  setAppDirOverride(null);
  rmSync(releaseDir, { recursive: true, force: true });
  rmSync(appDir, { recursive: true, force: true });
  process.env = { ...originalEnv };
});

describe("system version routes", () => {
  it("suppresses installer and release-check state on Worktable Cloud", async () => {
    let hits = 0;
    const releaseHost = Bun.serve({
      port: 0,
      fetch: () => {
        hits += 1;
        return Response.json({ version: "9.9.9" });
      },
    });
    try {
      process.env["WORKTABLE_HOSTED"] = "1";
      process.env["WORKTABLE_VERSION"] = "0.0.1";
      process.env["WORKTABLE_RELEASE_BASE_URL"] =
        `http://127.0.0.1:${releaseHost.port}`;
      process.env["WORKTABLE_LAUNCHER"] = join(releaseDir, "worktable");
      writeFileSync(join(releaseDir, "install.sh"), "#!/bin/sh\n");
      writeFileSync(
        join(appDir, "update-check.json"),
        JSON.stringify({ latest: "8.8.8", checkedAt: new Date().toISOString() })
      );

      const res = await routeApp().fetch(
        new Request("http://localhost/api/system/version")
      );
      expect(await res.json()).toEqual({
        current: "0.0.1",
        canUpdate: false,
        hasEmbeddedInstaller: false,
        latest: null,
        updateAvailable: false,
        checkedAt: null,
        lastAttemptAt: null,
        checkTtlRemainingMs: null,
        checkStatus: "managed",
      });
      expect(hits).toBe(0);
    } finally {
      releaseHost.stop(true);
    }
  });

  it("reports the current version and cannot update without an embedded installer", async () => {
    const res = await app().fetch(
      new Request("http://localhost/api/system/version")
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      current: string;
      canUpdate: boolean;
      hasEmbeddedInstaller: boolean;
    };
    expect(typeof body.current).toBe("string");
    expect(body.hasEmbeddedInstaller).toBe(false);
    expect(body.canUpdate).toBe(false);
  });

  it("includes the newest published version from the release host", async () => {
    // A real local release host, the same override contract install.sh honors.
    const releaseHost = Bun.serve({
      port: 0,
      fetch: () => Response.json({ version: "9.9.9" }),
    });
    try {
      process.env["WORKTABLE_VERSION"] = "0.0.1";
      process.env["WORKTABLE_RELEASE_BASE_URL"] =
        `http://127.0.0.1:${releaseHost.port}`;
      const res = await app().fetch(
        new Request("http://localhost/api/system/version")
      );
      const body = (await res.json()) as {
        latest: string | null;
        updateAvailable: boolean;
        checkedAt: string | null;
        lastAttemptAt: string | null;
        checkTtlRemainingMs: number | null;
        checkStatus: string;
      };
      expect(body.latest).toBe("9.9.9");
      expect(body.updateAvailable).toBe(true);
      expect(typeof body.checkedAt).toBe("string");
      expect(typeof body.lastAttemptAt).toBe("string");
      expect(body.checkTtlRemainingMs).toBeGreaterThan(0);
      expect(body.checkTtlRemainingMs).toBeLessThanOrEqual(6 * 60 * 60_000);
      expect(body.checkStatus).toBe("fresh");
    } finally {
      releaseHost.stop(true);
    }
  });

  it("reports latest as unknown for source builds without calling the network", async () => {
    let hits = 0;
    const releaseHost = Bun.serve({
      port: 0,
      fetch: () => {
        hits += 1;
        return Response.json({ version: "9.9.9" });
      },
    });
    try {
      // No WORKTABLE_VERSION: a source checkout / test server never phones home.
      delete process.env["WORKTABLE_VERSION"];
      process.env["WORKTABLE_RELEASE_BASE_URL"] =
        `http://127.0.0.1:${releaseHost.port}`;
      const res = await app().fetch(
        new Request("http://localhost/api/system/version")
      );
      const body = (await res.json()) as {
        latest: string | null;
        updateAvailable: boolean;
      };
      expect(body.latest).toBeNull();
      expect(body.updateAvailable).toBe(false);
      expect(hits).toBe(0);
    } finally {
      releaseHost.stop(true);
    }
  });

  it("?cached=1 answers from the on-disk cache without contacting the release host", async () => {
    let hits = 0;
    const releaseHost = Bun.serve({
      port: 0,
      fetch: () => {
        hits += 1;
        return Response.json({ version: "9.9.9" });
      },
    });
    try {
      process.env["WORKTABLE_VERSION"] = "0.0.1";
      process.env["WORKTABLE_RELEASE_BASE_URL"] =
        `http://127.0.0.1:${releaseHost.port}`;
      // A cache old enough that the live path would refetch — the cached path
      // must return it as-is instead.
      const staleCheckedAt = new Date(
        Date.now() - 24 * 60 * 60_000
      ).toISOString();
      writeFileSync(
        join(appDir, "update-check.json"),
        JSON.stringify({ latest: "0.0.2", checkedAt: staleCheckedAt })
      );
      const res = await app().fetch(
        new Request("http://localhost/api/system/version?cached=1")
      );
      const body = (await res.json()) as {
        latest: string | null;
        updateAvailable: boolean;
        checkedAt: string | null;
        checkStatus: string;
      };
      expect(body.latest).toBe("0.0.2");
      expect(body.updateAvailable).toBe(true);
      expect(body.checkedAt).toBe(staleCheckedAt);
      expect(body.checkStatus).toBe("stale");
      expect(hits).toBe(0);
    } finally {
      releaseHost.stop(true);
    }
  });

  it("POST /version/check bypasses a fresh cache while GET remains passive", async () => {
    let published = "0.0.2";
    let hits = 0;
    const releaseHost = Bun.serve({
      port: 0,
      fetch: () => {
        hits += 1;
        return Response.json({ version: published });
      },
    });
    try {
      process.env["WORKTABLE_VERSION"] = "0.0.1";
      process.env["WORKTABLE_RELEASE_BASE_URL"] =
        `http://127.0.0.1:${releaseHost.port}`;
      let res = await app().fetch(
        new Request("http://localhost/api/system/version")
      );
      expect(((await res.json()) as { latest: string }).latest).toBe("0.0.2");
      published = "0.0.3";

      res = await app().fetch(
        new Request("http://localhost/api/system/version?force=1")
      );
      expect(((await res.json()) as { latest: string }).latest).toBe("0.0.2");
      expect(hits).toBe(1);

      res = await app().fetch(
        new Request("http://localhost/api/system/version/check", {
          method: "POST",
          headers: {
            Origin: "http://localhost",
            "Sec-Fetch-Site": "same-origin",
          },
        })
      );
      expect(((await res.json()) as { latest: string }).latest).toBe("0.0.3");
      expect(hits).toBe(2);
    } finally {
      releaseHost.stop(true);
    }
  });

  it("rejects forced release checks from scoped agent credentials", async () => {
    let hits = 0;
    const releaseHost = Bun.serve({
      port: 0,
      fetch: () => {
        hits += 1;
        return Response.json({ version: "9.9.9" });
      },
    });
    try {
      process.env["WORKTABLE_VERSION"] = "0.0.1";
      process.env["WORKTABLE_RELEASE_BASE_URL"] =
        `http://127.0.0.1:${releaseHost.port}`;
      const { token } = await createToken({
        scopes: ["docs:read"],
        agent: "ci",
      });

      const res = await app().fetch(
        new Request("http://localhost/api/system/version/check", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        })
      );

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: "Forbidden",
        required: "owner + same-origin",
      });
      expect(hits).toBe(0);
    } finally {
      releaseHost.stop(true);
    }
  });

  it("rejects cross-site browser requests before forcing a release check", async () => {
    let hits = 0;
    const releaseHost = Bun.serve({
      port: 0,
      fetch: () => {
        hits += 1;
        return Response.json({ version: "9.9.9" });
      },
    });
    try {
      process.env["WORKTABLE_VERSION"] = "0.0.1";
      process.env["WORKTABLE_RELEASE_BASE_URL"] =
        `http://127.0.0.1:${releaseHost.port}`;

      const res = await app().fetch(
        new Request("http://localhost/api/system/version/check", {
          method: "POST",
          headers: {
            Origin: "https://attacker.example",
            "Sec-Fetch-Site": "cross-site",
          },
        })
      );

      expect(res.status).toBe(401);
      expect(hits).toBe(0);

      const crossScheme = await app().fetch(
        new Request("http://localhost/api/system/version/check", {
          method: "POST",
          headers: { Origin: "https://localhost" },
        })
      );
      expect(crossScheme.status).toBe(401);
      expect(hits).toBe(0);
    } finally {
      releaseHost.stop(true);
    }
  });

  it("?cached=1 reports latest as unknown when nothing has been checked yet", async () => {
    let hits = 0;
    const releaseHost = Bun.serve({
      port: 0,
      fetch: () => {
        hits += 1;
        return Response.json({ version: "9.9.9" });
      },
    });
    try {
      process.env["WORKTABLE_VERSION"] = "0.0.1";
      process.env["WORKTABLE_RELEASE_BASE_URL"] =
        `http://127.0.0.1:${releaseHost.port}`;
      const res = await app().fetch(
        new Request("http://localhost/api/system/version?cached=1")
      );
      const body = (await res.json()) as {
        latest: string | null;
        updateAvailable: boolean;
      };
      expect(body.latest).toBeNull();
      expect(body.updateAvailable).toBe(false);
      expect(hits).toBe(0);
    } finally {
      releaseHost.stop(true);
    }
  });

  it("can update only when the embedded installer AND a launcher are present", async () => {
    // Installer alone is not enough — the server still needs a binary to spawn.
    writeFileSync(join(releaseDir, "install.sh"), "#!/bin/sh\n");
    let res = await app().fetch(
      new Request("http://localhost/api/system/version")
    );
    let body = (await res.json()) as {
      canUpdate: boolean;
      hasEmbeddedInstaller: boolean;
    };
    expect(body.hasEmbeddedInstaller).toBe(true);
    expect(body.canUpdate).toBe(false);

    process.env["WORKTABLE_LAUNCHER"] = join(releaseDir, "worktable");
    res = await app().fetch(new Request("http://localhost/api/system/version"));
    body = (await res.json()) as {
      canUpdate: boolean;
      hasEmbeddedInstaller: boolean;
    };
    expect(body.canUpdate).toBe(true);
  });
});

describe("GET /api/system/update", () => {
  it("reports idle when no update has run", async () => {
    const res = await app().fetch(
      new Request("http://localhost/api/system/update")
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { state: string }).state).toBe("idle");
  });

  it("reflects the on-disk marker", async () => {
    writeUpdateStatus({ state: "running", from: "0.0.1", to: "latest" });
    const res = await app().fetch(
      new Request("http://localhost/api/system/update")
    );
    expect(((await res.json()) as { state: string }).state).toBe("running");
  });
});

describe("POST /api/system/update", () => {
  it("reports fleet-managed updates as hosted-disabled", async () => {
    process.env["WORKTABLE_HOSTED"] = "1";
    const res = await routeApp().fetch(
      new Request("http://localhost/api/system/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "Software updates are managed by Worktable Cloud.",
      code: "HOSTED_DISABLED",
    });
  });

  it("refuses (409) on a build that cannot self-update, leaving status idle", async () => {
    // Loopback (un-exposed) → passes the owner gate, but no installer/launcher.
    const res = await app().fetch(
      new Request("http://localhost/api/system/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    );
    expect(res.status).toBe(409);
    expect(readUpdateStatus().state).toBe("idle");
  });

  it("refuses (409) when an update is already in progress", async () => {
    writeUpdateStatus({ state: "running", from: "0.0.1", to: "latest" });
    const res = await app().fetch(
      new Request("http://localhost/api/system/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    );
    expect(res.status).toBe(409);
  });

  it("rejects (401) on an exposed install with no owner session", async () => {
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1";
    const res = await app().fetch(
      new Request("http://localhost/api/system/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /api/system/deployment", () => {
  it("returns the self-managed capability matrix", async () => {
    const expected: DeploymentInfo = {
      mode: "self-managed",
      capabilities: {
        cloudAccount: false,
        workspaceName: true,
        workspacePath: true,
        workspaceUrl: true,
        workspacePortability: true,
        editorSettings: true,
        historySettings: true,
        softwareUpdates: true,
        updateChecks: true,
        documentSharing: false,
      },
    };
    expect(getDeploymentInfo()).toEqual(expected);
    const res = await routeApp().fetch(
      new Request("http://localhost/api/system/deployment")
    );
    expect(await res.json()).toEqual(expected);
  });

  it("returns the Cloud capability matrix", async () => {
    process.env["WORKTABLE_HOSTED"] = "1";
    const expected: DeploymentInfo = {
      mode: "cloud",
      capabilities: {
        cloudAccount: true,
        workspaceName: true,
        workspacePath: false,
        workspaceUrl: false,
        workspacePortability: true,
        editorSettings: true,
        historySettings: true,
        softwareUpdates: false,
        updateChecks: false,
        documentSharing: false,
      },
    };
    expect(getDeploymentInfo()).toEqual(expected);
    const res = await routeApp().fetch(
      new Request("http://localhost/api/system/deployment")
    );
    expect(await res.json()).toEqual(expected);
  });

  it("enables sharing only when both isolated Cloud origins are configured", () => {
    process.env["WORKTABLE_HOSTED"] = "1";
    process.env["WORKTABLE_CLOUD_WORKSPACE_ID"] = "ws_cloud";
    process.env["WORKTABLE_SHARE_BASE_URL"] = "https://share.worktable.cloud";
    process.env["WORKTABLE_HTML_SHARE_BASE_URL"] =
      "https://html.worktable-usercontent.com";

    expect(getDeploymentInfo().capabilities.documentSharing).toBe(true);
    delete process.env["WORKTABLE_HTML_SHARE_BASE_URL"];
    expect(getDeploymentInfo().capabilities.documentSharing).toBe(false);
  });
});
