import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Hono } from "hono";
import type { SpaceFile } from "@worktable/types";
import { setAppDirOverride } from "./app-storage.ts";
import {
  listAgentConnections,
  upsertAgentConnection,
} from "./agent-connection-store.ts";
import { setWorkspaceRootOverride } from "./workspace.ts";
import {
  pairingRouter,
  resetPairingRateLimitForTests,
} from "./routes/pairing.ts";
import { authSessionRouter } from "./routes/auth-session.ts";
import { SESSION_COOKIE_NAME, setOwnerPassword } from "./session-store.ts";
import { createPairingSession, remoteMcpUrl } from "./pairing-store.ts";
import { listParticipantBindings } from "./participant-store.ts";
import { writeSpace } from "./store.ts";
import {
  createToken,
  listTokens,
  revokeToken,
  tokenIdFromToken,
  verifyToken,
} from "./token-store.ts";

// The pairing router carries two trust surfaces: owner-gated create/status
// (tokens-style stack) and code-authenticated redeem/progress that must work
// with NO cookie and NO bearer — that asymmetry is the core behavior under
// test, alongside the full pair -> redeem -> mint -> progress lifecycle.

function buildApp() {
  const app = new Hono();
  app.route("/auth", authSessionRouter);
  app.route("/api/pairing", pairingRouter);
  return app;
}

function jsonReq(
  method: string,
  path: string,
  opts: { cookie?: string; bearer?: string; body?: unknown } = {}
): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.cookie) headers["Cookie"] = opts.cookie;
  if (opts.bearer) headers["Authorization"] = `Bearer ${opts.bearer}`;
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

function cookieFrom(res: Response): string | null {
  const setCookie = res.headers.get("Set-Cookie");
  if (!setCookie) return null;
  const m = setCookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
  return m ? `${SESSION_COOKIE_NAME}=${m[1]}` : null;
}

async function loginCookie(app: Hono, password: string): Promise<string> {
  const res = await app.fetch(
    new Request("http://localhost/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    })
  );
  const cookie = cookieFrom(res);
  if (!cookie) throw new Error(`login failed (${res.status})`);
  return cookie;
}

interface CreateResponse {
  id: string;
  code: string;
  expiresAt: string;
  mcpUrl: string;
  client: string | null;
  scopes: string[];
  originSource: string;
  serverOrigin: string;
  target:
    | { kind: "mcp-client"; client: string | null }
    | {
        kind: "agent-adapter";
        adapter: string;
        participantName: string;
        defaultSpaceId?: string;
      };
}

async function createPairing(
  app: Hono,
  body: Record<string, unknown> = {},
  opts: { cookie?: string; bearer?: string } = {}
): Promise<CreateResponse> {
  const res = await app.fetch(
    jsonReq("POST", "/api/pairing", { ...opts, body })
  );
  if (res.status !== 201) throw new Error(`create failed (${res.status})`);
  return (await res.json()) as CreateResponse;
}

const SAVED_ENV_KEYS = [
  "WORKTABLE_REQUIRE_AUTH",
  "HOST",
  "WORKTABLE_PUBLIC_URL",
  "WORKTABLE_HOSTED",
  "WORKTABLE_RESOURCE_URL",
] as const;

let appDir: string;
let workspaceDir: string;
let savedEnv: Record<string, string | undefined>;
let app: Hono;

beforeEach(() => {
  appDir = mkdtempSync(join(tmpdir(), "worktable-pairing-routes-app-"));
  workspaceDir = mkdtempSync(join(tmpdir(), "worktable-pairing-routes-ws-"));
  setAppDirOverride(appDir);
  setWorkspaceRootOverride(workspaceDir);
  savedEnv = {};
  for (const key of SAVED_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  resetPairingRateLimitForTests();
  app = buildApp();
});

afterEach(() => {
  for (const key of SAVED_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  setAppDirOverride(null);
  setWorkspaceRootOverride(null);
  for (const dir of [appDir, workspaceDir]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe("create (owner surface)", () => {
  it("pairs and records OpenClaw without a default Space", async () => {
    const created = await createPairing(app, {
      target: {
        kind: "agent-adapter",
        adapter: "openclaw",
        participantName: "Atlas",
      },
    });
    expect(created.target).toEqual({
      kind: "agent-adapter",
      adapter: "openclaw",
      participantName: "Atlas",
    });

    const redeemed = await app.fetch(
      jsonReq("POST", "/api/pairing/redeem", {
        body: {
          code: created.code,
          hostname: "worktable-host",
          installationId: "oci_worktable_install",
        },
      })
    );
    expect(redeemed.status).toBe(200);
    const payload = (await redeemed.json()) as {
      token: string;
      participantName: string;
      defaultSpaceId?: string;
    };
    expect(payload.participantName).toBe("Atlas");
    expect(payload).not.toHaveProperty("defaultSpaceId");

    const completed = await app.fetch(
      jsonReq("POST", "/api/pairing/complete", {
        bearer: payload.token,
        body: { code: created.code },
      })
    );
    expect(completed.status).toBe(200);
    const bindings = await listParticipantBindings();
    expect(bindings).toMatchObject([
      {
        participant: { kind: "agent", name: "Atlas" },
      },
    ]);
    expect(bindings[0]).not.toHaveProperty("defaultSpaceId");
    expect(bindings[0]).not.toHaveProperty("threadLocationVersion");
    expect(await listAgentConnections()).toMatchObject([
      {
        target: {
          kind: "agent-adapter",
          adapter: "openclaw",
          installationId: "oci_worktable_install",
        },
        mode: "always-on",
        participant: { name: "Atlas" },
        machine: "worktable-host",
        lastSeenAt: expect.any(String),
      },
    ]);
  });

  it("creates with defaults on bare loopback: content scopes, /mcp endpoint", async () => {
    const created = await createPairing(app, { client: "codex" });
    expect(created.code).toMatch(
      /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/
    );
    expect(created.client).toBe("codex");
    expect(created.scopes).toEqual([
      "documents:read",
      "documents:write",
      "docs:*",
      "widgets:*",
      "records:*",
      "annotations:*",
      "threads:read",
      "threads:write",
      "search:read",
    ]);
    expect(created.mcpUrl).toBe("http://localhost/mcp");
    expect(created.originSource).toBe("request");
  });

  it("rejects unknown clients and owner-power scopes", async () => {
    const badClient = await app.fetch(
      jsonReq("POST", "/api/pairing", { body: { client: "emacs" } })
    );
    expect(badClient.status).toBe(400);

    const extensionOnly = await app.fetch(
      jsonReq("POST", "/api/pairing", { body: { client: "claude-desktop" } })
    );
    expect(extensionOnly.status).toBe(400);

    // Anything GRANTING tokens:manage is refused, not just the literals —
    // "tokens:*" satisfies hasScope(..., "tokens:manage") too.
    for (const scope of ["*", "tokens:manage", "tokens:*"]) {
      const res = await app.fetch(
        jsonReq("POST", "/api/pairing", { body: { scopes: [scope] } })
      );
      expect(res.status).toBe(400);
    }
  });

  it("401s bare create when exposed, but accepts the owner cookie", async () => {
    await setOwnerPassword("correct-horse-battery");
    const cookie = await loginCookie(app, "correct-horse-battery");
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1";

    const bare = await app.fetch(jsonReq("POST", "/api/pairing", { body: {} }));
    expect(bare.status).toBe(401);

    const created = await createPairing(
      app,
      { client: "claude-code" },
      { cookie }
    );
    expect(created.client).toBe("claude-code");

    // Status polling sits behind the same gate.
    const bareStatus = await app.fetch(
      jsonReq("GET", `/api/pairing/${created.id}`)
    );
    expect(bareStatus.status).toBe(401);
    const status = await app.fetch(
      jsonReq("GET", `/api/pairing/${created.id}`, { cookie })
    );
    expect(status.status).toBe(200);
  });

  it("403s a bearer without tokens:manage (pairing creation is token minting)", async () => {
    const { token } = await createToken({ scopes: ["docs:read"], agent: null });
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1";
    const res = await app.fetch(
      jsonReq("POST", "/api/pairing", { bearer: token, body: {} })
    );
    expect(res.status).toBe(403);
  });

  it("prefers the canonical resource URL, then hosted /api/mcp path", async () => {
    const { token } = await createToken({
      scopes: ["tokens:manage"],
      agent: null,
    });

    process.env["WORKTABLE_RESOURCE_URL"] =
      "https://tenant.example.com/api/mcp";
    const canonical = await createPairing(app, {}, { bearer: token });
    expect(canonical.mcpUrl).toBe("https://tenant.example.com/api/mcp");

    delete process.env["WORKTABLE_RESOURCE_URL"];
    process.env["WORKTABLE_HOSTED"] = "1";
    // Hosted pairing is intentionally unavailable, and hosted auth rejects
    // local bearers. Exercise the shared URL authority directly for its
    // fallback instead of bypassing that production posture in this unit.
    expect(remoteMcpUrl("http://localhost")).toBe("http://localhost/api/mcp");
  });

  it("creates a typed OpenClaw adapter pairing with fixed thread-only scopes", async () => {
    const now = new Date().toISOString();
    const homeSpace: SpaceFile = {
      type: "worktable.space",
      version: 1,
      id: "connected-agents",
      name: "Connected Agents",
      createdAt: now,
      updatedAt: now,
      createdBy: "test",
      settings: {},
    };
    await writeSpace(homeSpace);

    const created = await createPairing(app, {
      target: {
        kind: "agent-adapter",
        adapter: "openclaw",
        participantName: "Atlas",
        defaultSpaceId: homeSpace.id,
      },
    });

    expect(created.client).toBeNull();
    expect(created.scopes).toEqual(["threads:*"]);
    expect(created.target).toEqual({
      kind: "agent-adapter",
      adapter: "openclaw",
      participantName: "Atlas",
      defaultSpaceId: "connected-agents",
    });
    expect(created.serverOrigin).toBe("http://localhost");

    const redeemed = await app.fetch(
      jsonReq("POST", "/api/pairing/redeem", {
        body: {
          code: created.code,
          hostname: "personal",
          installationId: "oci_personal_install",
        },
      })
    );
    expect(redeemed.status).toBe(200);
    const payload = (await redeemed.json()) as {
      token: string;
      participantName: string;
      defaultSpaceId: string;
      client: string | null;
    };
    expect(payload.participantName).toBe("Atlas");
    expect(payload.defaultSpaceId).toBe("connected-agents");
    expect(payload.client).toBeNull();

    const identity = await verifyToken(payload.token);
    expect(identity?.agent).toBe("openclaw@oci_personal_install");
    expect(identity?.scopes).toEqual(["threads:*"]);
    const bindings = await listParticipantBindings();
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      participant: { kind: "agent", name: "Atlas" },
      defaultSpaceId: "connected-agents",
    });
    expect(bindings[0]).not.toHaveProperty("threadLocationVersion");

    const adapterToken = (await listTokens()).find(
      (token) =>
        token.agent === "openclaw@oci_personal_install" && !token.revokedAt
    );
    expect(adapterToken).toBeDefined();
    await revokeToken(adapterToken!.id);
    expect(await listParticipantBindings()).toHaveLength(0);
  });

  it("keeps agent-adapter pairing provider-neutral while validating adapter ids", async () => {
    const now = new Date().toISOString();
    await writeSpace({
      type: "worktable.space",
      version: 1,
      id: "portable-agents",
      name: "Portable Agents",
      createdAt: now,
      updatedAt: now,
      createdBy: "test",
      settings: {},
    });

    const created = await createPairing(app, {
      target: {
        kind: "agent-adapter",
        adapter: "future-agent",
        participantName: "Ada",
        defaultSpaceId: "portable-agents",
      },
    });
    expect(created.target).toMatchObject({
      adapter: "future-agent",
      participantName: "Ada",
    });
    const redeemed = await app.fetch(
      jsonReq("POST", "/api/pairing/redeem", {
        body: {
          code: created.code,
          hostname: "portable-host",
          installationId: "oci_portable_install",
        },
      })
    );
    expect(redeemed.status).toBe(200);
    const identity = await verifyToken(
      ((await redeemed.json()) as { token: string }).token
    );
    expect(identity?.agent).toBe("future-agent@oci_portable_install");

    const rejected = await app.fetch(
      jsonReq("POST", "/api/pairing", {
        body: {
          target: {
            kind: "agent-adapter",
            adapter: "../openclaw",
            participantName: "Unsafe",
            defaultSpaceId: "portable-agents",
          },
        },
      })
    );
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).code).toBe("BAD_REQUEST");
  });

  it("requires adapter-owned install identity and keeps same-host installations distinct", async () => {
    const now = new Date().toISOString();
    await writeSpace({
      type: "worktable.space",
      version: 1,
      id: "adapter-identities",
      name: "Adapter Identities",
      createdAt: now,
      updatedAt: now,
      createdBy: "test",
      settings: {},
    });
    const pairingTarget = {
      kind: "agent-adapter" as const,
      adapter: "openclaw",
      participantName: "Atlas",
      defaultSpaceId: "adapter-identities",
    };

    const missingIdentity = await createPairing(app, {
      target: pairingTarget,
    });
    const rejected = await app.fetch(
      jsonReq("POST", "/api/pairing/redeem", {
        body: {
          code: missingIdentity.code,
          hostname: "shared-container-host",
        },
      })
    );
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({
      code: "BAD_REQUEST",
    });

    const redeemAdapter = async (
      installationId: string,
      target: {
        kind: "agent-adapter";
        adapter: string;
        participantName: string;
        defaultSpaceId?: string;
      } = pairingTarget
    ) => {
      const created = await createPairing(app, { target });
      const response = await app.fetch(
        jsonReq("POST", "/api/pairing/redeem", {
          body: {
            code: created.code,
            hostname: "shared-container-host",
            installationId,
          },
        })
      );
      expect(response.status).toBe(200);
      const token = ((await response.json()) as { token: string }).token;
      const completed = await app.fetch(
        jsonReq("POST", "/api/pairing/complete", {
          bearer: token,
          body: { code: created.code },
        })
      );
      expect(completed.status).toBe(200);
      return token;
    };

    const firstToken = await redeemAdapter("oci_installation_alpha");
    const secondToken = await redeemAdapter("oci_installation_beta");
    const initialConnections = await listAgentConnections();
    const initialFirst = initialConnections.find(
      (connection) =>
        connection.target.kind === "agent-adapter" &&
        connection.target.installationId === "oci_installation_alpha"
    )!;
    expect(initialConnections).toHaveLength(2);

    expect((await verifyToken(firstToken))?.agent).toBe(
      "openclaw@oci_installation_alpha"
    );
    expect((await verifyToken(secondToken))?.agent).toBe(
      "openclaw@oci_installation_beta"
    );
    expect(await listParticipantBindings()).toHaveLength(2);

    const rotatedFirst = await redeemAdapter("oci_installation_alpha", {
      kind: "agent-adapter",
      adapter: "openclaw",
      participantName: "Atlas",
    });
    expect(await verifyToken(firstToken)).toBeNull();
    expect((await verifyToken(rotatedFirst))?.agent).toBe(
      "openclaw@oci_installation_alpha"
    );
    expect(await verifyToken(secondToken)).not.toBeNull();
    const rotatedBindings = await listParticipantBindings();
    expect(rotatedBindings).toHaveLength(2);
    expect(
      rotatedBindings.filter(
        (binding) => binding.defaultSpaceId === "adapter-identities"
      )
    ).toHaveLength(1);
    expect(
      rotatedBindings.filter((binding) => binding.defaultSpaceId === undefined)
    ).toHaveLength(1);
    const rotatedConnections = await listAgentConnections();
    const rotatedConnection = rotatedConnections.find(
      (connection) =>
        connection.target.kind === "agent-adapter" &&
        connection.target.installationId === "oci_installation_alpha"
    )!;
    expect(rotatedConnections).toHaveLength(2);
    expect(rotatedConnection.id).toBe(initialFirst.id);
    expect(rotatedConnection.connectedAt).toBe(initialFirst.connectedAt);
    expect(await verifyToken(firstToken)).toBeNull();
    expect(await verifyToken(rotatedFirst)).not.toBeNull();
  });

  it("does not consume an adapter pairing when its home Space was deleted", async () => {
    const now = new Date().toISOString();
    const homeSpace: SpaceFile = {
      type: "worktable.space",
      version: 1,
      id: "deleted-before-redeem",
      name: "Deleted Before Redeem",
      createdAt: now,
      updatedAt: now,
      createdBy: "test",
      settings: {},
    };
    await writeSpace(homeSpace);
    const created = await createPairing(app, {
      target: {
        kind: "agent-adapter",
        adapter: "openclaw",
        participantName: "Atlas",
        defaultSpaceId: homeSpace.id,
      },
    });
    rmSync(join(workspaceDir, "spaces", homeSpace.id), {
      recursive: true,
      force: true,
    });

    const unavailable = await app.fetch(
      jsonReq("POST", "/api/pairing/redeem", {
        body: {
          code: created.code,
          hostname: "personal",
          installationId: "oci_deleted_home_space",
        },
      })
    );
    expect(unavailable.status).toBe(409);
    expect(await unavailable.json()).toMatchObject({
      code: "PAIRING_TARGET_UNAVAILABLE",
    });
    expect(await listTokens()).toHaveLength(0);
    expect(await listParticipantBindings()).toHaveLength(0);

    await writeSpace(homeSpace);
    const retried = await app.fetch(
      jsonReq("POST", "/api/pairing/redeem", {
        body: {
          code: created.code,
          hostname: "personal",
          installationId: "oci_deleted_home_space",
        },
      })
    );
    expect(retried.status).toBe(200);
  });

  it("revokes an undelivered adapter token when participant setup fails", async () => {
    const now = new Date().toISOString();
    const homeSpace: SpaceFile = {
      type: "worktable.space",
      version: 1,
      id: "ambiguous-agents",
      name: "Ambiguous Agents",
      createdAt: now,
      updatedAt: now,
      createdBy: "test",
      settings: {},
    };
    await writeSpace(homeSpace);
    const fingerprint = `pid_${createHash("sha256")
      .update("agent:openclaw@oci_ambiguous_install")
      .digest("base64url")}`;
    const directory = join(workspaceDir, "spaces", homeSpace.id, "threads");
    mkdirSync(directory, { recursive: true });
    for (const [index, participantId] of [
      "ptc_ambiguous_one",
      "ptc_ambiguous_two",
    ].entries()) {
      const suffix = String(index + 1).padStart(2, "0");
      const threadId = `thr_ambiguous_${suffix}`;
      writeFileSync(
        join(directory, `${threadId}.json`),
        `${JSON.stringify(
          {
            type: "worktable.thread",
            version: 1,
            id: threadId,
            spaceId: homeSpace.id,
            title: `Ambiguous portable identity ${index + 1}`,
            participants: [
              {
                id: "ptc_portable_owner",
                kind: "human",
                name: "Owner",
              },
              {
                id: participantId,
                kind: "agent",
                name: "Atlas",
                identityFingerprint: fingerprint,
              },
            ],
            revision: 1,
            messages: [
              {
                id: `msg_ambiguous_${suffix}`,
                sequence: 1,
                authorId: "ptc_portable_owner",
                recipientIds: [participantId],
                body: "Portable participant evidence.",
                expectsReply: false,
                idempotencyKey: `ambiguous-${index + 1}`,
                createdAt: now,
              },
            ],
            createdAt: now,
            updatedAt: now,
          },
          null,
          2
        )}\n`,
        "utf8"
      );
    }

    const created = await createPairing(app, {
      target: {
        kind: "agent-adapter",
        adapter: "openclaw",
        participantName: "Atlas",
        defaultSpaceId: homeSpace.id,
      },
    });
    const redeemed = await app.fetch(
      jsonReq("POST", "/api/pairing/redeem", {
        body: {
          code: created.code,
          hostname: "ambiguous",
          installationId: "oci_ambiguous_install",
        },
      })
    );

    expect(redeemed.status).toBe(409);
    expect(await redeemed.json()).toMatchObject({
      code: "PARTICIPANT_SETUP_FAILED",
    });
    const token = (await listTokens()).find(
      (candidate) => candidate.agent === "openclaw@oci_ambiguous_install"
    );
    expect(token?.revokedAt).not.toBeNull();
    const status = await app.fetch(
      new Request(`http://localhost/api/pairing/${created.id}`)
    );
    expect(await status.json()).toMatchObject({
      status: "failed",
      outcome: "failed",
    });
  });
});

describe("redeem (code surface)", () => {
  it("resolves the selected target without consuming its code", async () => {
    const created = await createPairing(app, { client: "codex" });
    const target = await app.fetch(
      jsonReq("POST", "/api/pairing/target", { body: { code: created.code } })
    );
    expect(target.status).toBe(200);
    expect(await target.json()).toEqual({ client: "codex" });

    const redeemed = await app.fetch(
      jsonReq("POST", "/api/pairing/redeem", {
        body: { code: created.code, hostname: "devbox" },
      })
    );
    expect(redeemed.status).toBe(200);
  });

  it("does not consume an adapter code when MCP client overrides are rejected", async () => {
    const now = new Date().toISOString();
    await writeSpace({
      type: "worktable.space",
      version: 1,
      id: "connected-agents",
      name: "Connected Agents",
      createdAt: now,
      updatedAt: now,
      createdBy: "test",
      settings: {},
    });
    const created = await createPairing(app, {
      target: {
        kind: "agent-adapter",
        adapter: "openclaw",
        participantName: "Atlas",
        defaultSpaceId: "connected-agents",
      },
    });

    const rejected = await app.fetch(
      jsonReq("POST", "/api/pairing/redeem", {
        body: {
          code: created.code,
          hostname: "personal",
          installationId: "oci_override_install",
          client: "codex",
        },
      })
    );
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).code).toBe("BAD_REQUEST");

    const retried = await app.fetch(
      jsonReq("POST", "/api/pairing/redeem", {
        body: {
          code: created.code,
          hostname: "personal",
          installationId: "oci_override_install",
        },
      })
    );
    expect(retried.status).toBe(200);
  });

  it("redeems with no cookie and no bearer even when exposed, and mints a working scoped token", async () => {
    await setOwnerPassword("correct-horse-battery");
    const cookie = await loginCookie(app, "correct-horse-battery");
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1";
    const created = await createPairing(app, { client: "codex" }, { cookie });

    const res = await app.fetch(
      jsonReq("POST", "/api/pairing/redeem", {
        body: { code: created.code, hostname: "devbox" },
      })
    );
    expect(res.status).toBe(200);
    const redeemed = (await res.json()) as {
      mcpUrl: string;
      token: string;
      client: string | null;
      scopes: string[];
      workspaceName: string;
    };
    expect(redeemed.mcpUrl).toBe(created.mcpUrl);
    expect(redeemed.client).toBe("codex");
    expect(redeemed.workspaceName).toBe(basename(workspaceDir));

    const identity = await verifyToken(redeemed.token);
    expect(identity).not.toBeNull();
    expect(identity!.scopes).toEqual(created.scopes);
    expect(identity!.agent).toBe("codex@devbox");

    // Status now shows the redemption, the redeemer, and the minted token id.
    const status = await app.fetch(
      jsonReq("GET", `/api/pairing/${created.id}`, { cookie })
    );
    const view = (await status.json()) as {
      status: string;
      redeemedBy: { hostname: string };
      tokenId: string;
    };
    expect(view.status).toBe("redeemed");
    expect(view.redeemedBy.hostname).toBe("devbox");
    const active = (await listTokens()).find((t) => t.id === view.tokenId);
    expect(active?.agent).toBe("codex@devbox");
  });

  it("labels the token to mirror the actual install choice", async () => {
    // Explicit --client override wins over the pairing's choice: the
    // connector installs the override, so the label must match it.
    const overridden = await createPairing(app, { client: "codex" });
    const overrideRes = await app.fetch(
      jsonReq("POST", "/api/pairing/redeem", {
        body: { code: overridden.code, hostname: "devbox", client: "cursor" },
      })
    );
    expect(overrideRes.status).toBe(200);
    expect(((await overrideRes.json()) as { client: string }).client).toBe(
      "cursor"
    );
    expect(
      (await listTokens()).some(
        (t) => t.agent === "cursor@devbox" && !t.revokedAt
      )
    ).toBe(true);

    // Single-detection hint fills in when neither flag nor pairing named one.
    const auto = await createPairing(app, {});
    const autoRes = await app.fetch(
      jsonReq("POST", "/api/pairing/redeem", {
        body: { code: auto.code, hostname: "devbox", detectedClient: "vscode" },
      })
    );
    expect(autoRes.status).toBe(200);
    // The connector still decides locally (response client stays null)...
    expect(
      ((await autoRes.json()) as { client: string | null }).client
    ).toBeNull();
    // ...but the label carries what it will install.
    expect(
      (await listTokens()).some(
        (t) => t.agent === "vscode@devbox" && !t.revokedAt
      )
    ).toBe(true);

    // --all installs the detected SET, which only the generic label rewrites
    // consistently: a client-specific label would rotate out from under the
    // other clients on the next single-client reconnect.
    const all = await createPairing(app, { client: "codex" });
    const allRes = await app.fetch(
      jsonReq("POST", "/api/pairing/redeem", {
        body: { code: all.code, hostname: "devbox", all: true },
      })
    );
    expect(allRes.status).toBe(200);
    const allPayload = (await allRes.json()) as {
      client: string | null;
      token: string;
    };
    expect(allPayload.client).toBeNull();
    expect(
      (await listTokens()).some(
        (t) => t.agent === "agent@devbox" && !t.revokedAt
      )
    ).toBe(true);
    expect(
      (
        await app.fetch(
          jsonReq("POST", "/api/pairing/complete", {
            bearer: allPayload.token,
            body: { code: all.code },
          })
        )
      ).status
    ).toBe(200);
    expect(await listAgentConnections()).toEqual([
      expect.objectContaining({
        target: { kind: "mcp-client", clientId: null },
        machine: "devbox",
      }),
    ]);

    // A detected client hint never overrides the server-selected client.
    const requested = await createPairing(app, { client: "codex" });
    const requestedRes = await app.fetch(
      jsonReq("POST", "/api/pairing/redeem", {
        body: {
          code: requested.code,
          hostname: "requested-client-host",
          detectedClient: "vscode",
        },
      })
    );
    expect(requestedRes.status).toBe(200);
    const requestedPayload = (await requestedRes.json()) as {
      client: string;
      token: string;
    };
    expect(requestedPayload.client).toBe("codex");
    expect(
      (
        await app.fetch(
          jsonReq("POST", "/api/pairing/complete", {
            bearer: requestedPayload.token,
            body: { code: requested.code },
          })
        )
      ).status
    ).toBe(200);
    expect(await listAgentConnections()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: { kind: "mcp-client", clientId: null },
          machine: "devbox",
        }),
        expect.objectContaining({
          target: { kind: "mcp-client", clientId: "codex" },
          machine: "requested-client-host",
        }),
      ])
    );
    expect(await listAgentConnections()).toHaveLength(2);
  });

  it("is single-use (410) and distinguishes expired (410) from unknown (404)", async () => {
    const created = await createPairing(app, {});
    const redeem = () =>
      app.fetch(
        jsonReq("POST", "/api/pairing/redeem", {
          body: { code: created.code, hostname: "devbox" },
        })
      );
    expect((await redeem()).status).toBe(200);
    const again = await redeem();
    expect(again.status).toBe(410);
    expect(((await again.json()) as { code: string }).code).toBe(
      "ALREADY_REDEEMED"
    );

    const { code: expiredCode } = await createPairingSession({
      client: null,
      scopes: ["docs:read"],
      mcpUrl: "http://localhost/mcp",
      ttlMs: 0,
    });
    const expired = await app.fetch(
      jsonReq("POST", "/api/pairing/redeem", { body: { code: expiredCode } })
    );
    expect(expired.status).toBe(410);
    expect(((await expired.json()) as { code: string }).code).toBe("EXPIRED");

    const unknown = await app.fetch(
      jsonReq("POST", "/api/pairing/redeem", { body: { code: "AAAAA-AAAAA" } })
    );
    expect(unknown.status).toBe(404);
  });

  it("reliably and idempotently completes rotation with the pairing bearer", async () => {
    const first = await createPairing(app, {
      client: "codex",
      displayName: "My Codex",
    });
    const firstRedeem = await app.fetch(
      jsonReq("POST", "/api/pairing/redeem", {
        body: { code: first.code, hostname: "devbox" },
      })
    );
    const firstToken = ((await firstRedeem.json()) as { token: string }).token;
    await app.fetch(
      jsonReq("POST", "/api/pairing/complete", {
        bearer: firstToken,
        body: { code: first.code },
      })
    );
    const second = await createPairing(app, { client: "codex" });
    const secondRedeem = await app.fetch(
      jsonReq("POST", "/api/pairing/redeem", {
        body: { code: second.code, hostname: "devbox" },
      })
    );
    const secondToken = ((await secondRedeem.json()) as { token: string })
      .token;

    let codexTokens = (await listTokens()).filter(
      (t) => t.agent === "codex@devbox"
    );
    expect(codexTokens).toHaveLength(2);
    expect(codexTokens.filter((t) => !t.revokedAt)).toHaveLength(2);

    const unauthenticated = await app.fetch(
      jsonReq("POST", "/api/pairing/complete", {
        body: { code: second.code },
      })
    );
    expect(unauthenticated.status).toBe(401);

    const unrelated = await createToken({
      scopes: ["docs:*"],
      agent: "cursor@other-machine",
    });
    const mismatched = await app.fetch(
      jsonReq("POST", "/api/pairing/complete", {
        bearer: unrelated.token,
        body: { code: second.code },
      })
    );
    expect(mismatched.status).toBe(409);

    for (let attempt = 0; attempt < 2; attempt++) {
      const completed = await app.fetch(
        jsonReq("POST", "/api/pairing/complete", {
          bearer: secondToken,
          body: { code: second.code },
        })
      );
      expect(completed.status).toBe(200);
    }
    codexTokens = (await listTokens()).filter(
      (t) => t.agent === "codex@devbox"
    );
    expect(codexTokens.filter((t) => !t.revokedAt)).toHaveLength(1);
    expect(await verifyToken(firstToken)).toBeNull();
    expect(await verifyToken(secondToken)).not.toBeNull();
    expect(await listAgentConnections()).toEqual([
      expect.objectContaining({ displayName: "My Codex" }),
    ]);
    const status = await app.fetch(jsonReq("GET", `/api/pairing/${second.id}`));
    const view = (await status.json()) as {
      status: string;
      events: { event: string }[];
    };
    expect(view.status).toBe("verified");
    expect(
      view.events.filter((event) => event.event === "verified")
    ).toHaveLength(1);
  });

  it("keeps pairing status nonterminal until the connection is durable", async () => {
    const created = await createPairing(app, { client: "codex" });
    const redeemed = await app.fetch(
      jsonReq("POST", "/api/pairing/redeem", {
        body: { code: created.code, hostname: "durability-host" },
      })
    );
    const token = ((await redeemed.json()) as { token: string }).token;

    const connectionPath = join(appDir, "agent-connections.json");
    mkdirSync(connectionPath);
    const failed = await app.fetch(
      jsonReq("POST", "/api/pairing/complete", {
        bearer: token,
        body: { code: created.code },
      })
    );
    expect(failed.status).toBe(500);
    const failedStatus = await app.fetch(
      jsonReq("GET", `/api/pairing/${created.id}`)
    );
    expect(((await failedStatus.json()) as { status: string }).status).toBe(
      "redeemed"
    );

    rmSync(connectionPath, { recursive: true, force: true });
    const retried = await app.fetch(
      jsonReq("POST", "/api/pairing/complete", {
        bearer: token,
        body: { code: created.code },
      })
    );
    expect(retried.status).toBe(200);
    const verifiedStatus = await app.fetch(
      jsonReq("GET", `/api/pairing/${created.id}`)
    );
    expect(((await verifiedStatus.json()) as { status: string }).status).toBe(
      "verified"
    );
    expect(await listAgentConnections()).toHaveLength(1);
  });

  it("rejects code-only verification and requires authenticated completion", async () => {
    const created = await createPairing(app, { client: "codex" });
    const redeemed = await app.fetch(
      jsonReq("POST", "/api/pairing/redeem", {
        body: { code: created.code, hostname: "progress-first-host" },
      })
    );
    const token = ((await redeemed.json()) as { token: string }).token;
    const progress = await app.fetch(
      jsonReq("POST", "/api/pairing/progress", {
        body: { code: created.code, event: "verified" },
      })
    );
    expect(progress.status).toBe(400);
    expect(await listAgentConnections()).toEqual([]);
    const progressStatus = await app.fetch(
      jsonReq("GET", `/api/pairing/${created.id}`)
    );
    expect(((await progressStatus.json()) as { status: string }).status).toBe(
      "redeemed"
    );

    const completed = await app.fetch(
      jsonReq("POST", "/api/pairing/complete", {
        bearer: token,
        body: { code: created.code },
      })
    );
    expect(completed.status).toBe(200);
    const completedStatus = await app.fetch(
      jsonReq("GET", `/api/pairing/${created.id}`)
    );
    expect(((await completedStatus.json()) as { status: string }).status).toBe(
      "verified"
    );
    expect(await listAgentConnections()).toEqual([
      expect.objectContaining({
        target: { kind: "mcp-client", clientId: "codex" },
        machine: "progress-first-host",
      }),
    ]);
  });

  it("revokes a delayed pairing when a newer semantic connection already exists", async () => {
    const older = await createPairing(app, { client: "codex" });
    const olderRedeem = await app.fetch(
      jsonReq("POST", "/api/pairing/redeem", {
        body: { code: older.code, hostname: "ordered-host" },
      })
    );
    const olderToken = ((await olderRedeem.json()) as { token: string }).token;

    const newer = await createPairing(app, { client: "codex" });
    const newerRedeem = await app.fetch(
      jsonReq("POST", "/api/pairing/redeem", {
        body: { code: newer.code, hostname: "ordered-host" },
      })
    );
    const newerToken = ((await newerRedeem.json()) as { token: string }).token;

    const newerTokenId = tokenIdFromToken(newerToken)!;
    expect(
      await upsertAgentConnection({
        target: { kind: "mcp-client", clientId: "codex" },
        mode: "on-demand",
        participant: null,
        machine: "ordered-host",
        credentialId: newerTokenId,
      })
    ).toBe(true);
    expect(
      (
        await app.fetch(
          jsonReq("POST", "/api/pairing/complete", {
            bearer: olderToken,
            body: { code: older.code },
          })
        )
      ).status
    ).toBe(200);

    expect(await verifyToken(olderToken)).toBeNull();
    expect(await verifyToken(newerToken)).not.toBeNull();
    expect(await listAgentConnections()).toEqual([
      expect.objectContaining({
        authKind: "local-token",
        machine: "ordered-host",
        target: { kind: "mcp-client", clientId: "codex" },
      }),
    ]);
  });

  it("does NOT rotate across hostname-less redeems (distinct machines)", async () => {
    for (let i = 0; i < 2; i++) {
      const created = await createPairing(app, { client: "codex" });
      const res = await app.fetch(
        jsonReq("POST", "/api/pairing/redeem", { body: { code: created.code } })
      );
      expect(res.status).toBe(200);
    }
    // Each hostname-less redeem gets a per-session label, so neither revokes
    // the other — a shared "unknown" would break the first machine's token.
    const unknowns = (await listTokens()).filter((t) =>
      t.agent?.startsWith("codex@unknown-")
    );
    expect(unknowns).toHaveLength(2);
    expect(unknowns.filter((t) => !t.revokedAt)).toHaveLength(2);
    expect(unknowns[0]!.agent).not.toBe(unknowns[1]!.agent);
  });

  it("locks the code surface after repeated failures", async () => {
    const created = await createPairing(app, {});
    for (let i = 0; i < 30; i++) {
      const res = await app.fetch(
        jsonReq("POST", "/api/pairing/redeem", {
          body: { code: "AAAAA-AAAAA" },
        })
      );
      expect(res.status).toBe(404);
    }
    // Locked for everyone — including a valid code — until the window drains.
    const locked = await app.fetch(
      jsonReq("POST", "/api/pairing/redeem", { body: { code: created.code } })
    );
    expect(locked.status).toBe(429);
  });
});

describe("progress (code surface)", () => {
  it("drives the live status the Settings flow polls", async () => {
    const previous = await createToken({
      scopes: ["docs:*"],
      agent: "codex@devbox",
    });
    const created = await createPairing(app, { client: "codex" });

    // Progress before redemption is refused.
    const early = await app.fetch(
      jsonReq("POST", "/api/pairing/progress", {
        body: { code: created.code, event: "config_written" },
      })
    );
    expect(early.status).toBe(409);

    await app.fetch(
      jsonReq("POST", "/api/pairing/redeem", {
        body: { code: created.code, hostname: "devbox" },
      })
    );

    for (const event of ["config_written", "verifying"]) {
      const res = await app.fetch(
        jsonReq("POST", "/api/pairing/progress", {
          body: { code: created.code, event },
        })
      );
      expect(res.status).toBe(200);
    }

    const status = await app.fetch(
      jsonReq("GET", `/api/pairing/${created.id}`)
    );
    const view = (await status.json()) as {
      status: string;
      events: { event: string }[];
    };
    expect(view.status).toBe("redeemed");
    expect(view.events.map((e) => e.event)).toEqual([
      "redeemed",
      "config_written",
      "verifying",
    ]);
    // Code-only progress is nonterminal. Only the exact bearer-authenticated
    // /complete call may retire this credential.
    expect(await verifyToken(previous.token)).not.toBeNull();
  });

  it("revokes the minted token on the explicit zero-write assertion", async () => {
    const created = await createPairing(app, { client: "codex" });
    await app.fetch(
      jsonReq("POST", "/api/pairing/redeem", {
        body: { code: created.code, hostname: "devbox" },
      })
    );
    await app.fetch(
      jsonReq("POST", "/api/pairing/progress", {
        body: {
          code: created.code,
          event: "failed_no_config",
          detail: "no clients",
        },
      })
    );
    // Zero-write failure: nothing holds the token, so it must not stay live.
    const stranded = (await listTokens()).find(
      (t) => t.agent === "codex@devbox"
    );
    expect(stranded?.revokedAt).not.toBeNull();
    const status = await app.fetch(
      jsonReq("GET", `/api/pairing/${created.id}`)
    );
    expect(((await status.json()) as { status: string }).status).toBe("failed");
  });

  it("does NOT revoke on a plain failed event, even without a config_written report", async () => {
    // The config_written report is best-effort; a dropped report followed by
    // a verification failure must not kill the credential the agent's
    // just-written config is carrying.
    const created = await createPairing(app, { client: "codex" });
    await app.fetch(
      jsonReq("POST", "/api/pairing/redeem", {
        body: { code: created.code, hostname: "devbox" },
      })
    );
    await app.fetch(
      jsonReq("POST", "/api/pairing/progress", {
        body: { code: created.code, event: "failed", detail: "verify timeout" },
      })
    );
    const token = (await listTokens()).find((t) => t.agent === "codex@devbox");
    expect(token?.revokedAt).toBeNull();
  });

  it("keeps the token when failure arrives AFTER a config write", async () => {
    const created = await createPairing(app, { client: "codex" });
    await app.fetch(
      jsonReq("POST", "/api/pairing/redeem", {
        body: { code: created.code, hostname: "devbox" },
      })
    );
    for (const event of ["config_written", "failed"]) {
      await app.fetch(
        jsonReq("POST", "/api/pairing/progress", {
          body: { code: created.code, event },
        })
      );
    }
    // The config on the agent machine carries this token; a verification
    // failure (e.g. transient network) must not kill it.
    const written = (await listTokens()).find(
      (t) => t.agent === "codex@devbox"
    );
    expect(written?.revokedAt).toBeNull();
  });

  it("revokes after the connector explicitly rolls every written config back", async () => {
    const previous = await createToken({
      scopes: ["docs:*"],
      agent: "codex@devbox",
    });
    const created = await createPairing(app, { client: "codex" });
    await app.fetch(
      jsonReq("POST", "/api/pairing/redeem", {
        body: { code: created.code, hostname: "devbox" },
      })
    );
    for (const event of ["config_written", "verifying", "rolled_back"]) {
      const response = await app.fetch(
        jsonReq("POST", "/api/pairing/progress", {
          body: { code: created.code, event },
        })
      );
      expect(response.status).toBe(200);
    }

    const status = await app.fetch(
      jsonReq("GET", `/api/pairing/${created.id}`)
    );
    const view = (await status.json()) as {
      status: string;
      tokenId: string;
      events: { event: string }[];
    };
    const tokens = await listTokens();
    expect(
      tokens.find((token) => token.id === view.tokenId)?.revokedAt
    ).not.toBeNull();
    expect(await verifyToken(previous.token)).not.toBeNull();
    expect(view.status).toBe("failed");
    expect(view.events.map((event) => event.event)).toEqual([
      "redeemed",
      "config_written",
      "verifying",
      "rolled_back",
    ]);
  });

  it("ignores a rollback claim after the connection has verified", async () => {
    const created = await createPairing(app, { client: "codex" });
    const redeemed = await app.fetch(
      jsonReq("POST", "/api/pairing/redeem", {
        body: { code: created.code, hostname: "devbox" },
      })
    );
    const token = ((await redeemed.json()) as { token: string }).token;

    const completed = await app.fetch(
      jsonReq("POST", "/api/pairing/complete", {
        bearer: token,
        body: { code: created.code },
      })
    );
    expect(completed.status).toBe(200);
    const rollback = await app.fetch(
      jsonReq("POST", "/api/pairing/progress", {
        body: { code: created.code, event: "rolled_back" },
      })
    );
    expect(rollback.status).toBe(200);

    expect(await verifyToken(token)).not.toBeNull();
    const status = await app.fetch(
      jsonReq("GET", `/api/pairing/${created.id}`)
    );
    expect(((await status.json()) as { status: string }).status).toBe(
      "verified"
    );
  });

  it("rejects unknown events and unknown codes", async () => {
    const created = await createPairing(app, {});
    await app.fetch(
      jsonReq("POST", "/api/pairing/redeem", { body: { code: created.code } })
    );

    const badEvent = await app.fetch(
      jsonReq("POST", "/api/pairing/progress", {
        body: { code: created.code, event: "redeemed" },
      })
    );
    expect(badEvent.status).toBe(400);

    const badCode = await app.fetch(
      jsonReq("POST", "/api/pairing/progress", {
        body: { code: "AAAAA-AAAAA", event: "verifying" },
      })
    );
    expect(badCode.status).toBe(404);
  });
});
