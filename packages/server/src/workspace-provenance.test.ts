import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { workspaceRouter } from "./routes/workspace.ts";
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
  type WorkspaceManifest,
  workspaceProvenanceMode,
} from "./workspace.ts";

const base: WorkspaceManifest = {
  type: "worktable.workspace",
  version: 1,
  id: "ws_x",
  name: "X",
  createdAt: "2026-01-01T00:00:00.000Z",
  cloud: { status: "unlinked" },
};

function seedManifest(dir: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(
    join(dir, "worktable.workspace.json"),
    `${JSON.stringify({ ...base, id: "ws_test", name: "Test WS", ...extra }, null, 2)}\n`,
  );
}

afterEach(() => setWorkspaceRootOverride(null));

describe("workspaceProvenanceMode", () => {
  it("defaults to daily when provenance is absent", () => {
    expect(workspaceProvenanceMode(base)).toBe("daily");
  });
  it("returns the mode for a known provenance", () => {
    expect(workspaceProvenanceMode({ ...base, provenance: { mode: "sandbox" } })).toBe("sandbox");
    expect(workspaceProvenanceMode({ ...base, provenance: { mode: "fixture" } })).toBe("fixture");
  });
  it("falls back to daily for an unrecognized mode (tolerant)", () => {
    const bad = { ...base, provenance: { mode: "garbage" } } as unknown as WorkspaceManifest;
    expect(workspaceProvenanceMode(bad)).toBe("daily");
  });
});

describe("provenance round-trips through ensureWorkspaceManifest", () => {
  it("preserves the provenance block and the existing id (no regeneration)", () => {
    const dir = mkdtempSync(join(tmpdir(), "wt-prov-"));
    try {
      setWorkspaceRootOverride(dir);
      seedManifest(dir, { provenance: { mode: "sandbox", source: { label: "Alex Daily" }, oneWay: true, disposable: true } });
      const m = ensureWorkspaceManifest();
      expect(m.id).toBe("ws_test"); // not regenerated
      expect(m.provenance?.mode).toBe("sandbox");
      expect(m.provenance?.source?.label).toBe("Alex Daily");
    } finally {
      setWorkspaceRootOverride(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("GET /api/workspace", () => {
  async function fetchWorkspace(dir: string): Promise<Response> {
    setWorkspaceRootOverride(dir);
    const app = new Hono();
    app.route("/api/workspace", workspaceRouter);
    return app.fetch(new Request("http://localhost/api/workspace"));
  }

  it("reports daily + null provenance for a plain manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wt-prov-"));
    try {
      seedManifest(dir);
      const res = await fetchWorkspace(dir);
      const body = (await res.json()) as { id: string; mode: string; provenance: unknown };
      expect(res.status).toBe(200);
      expect(body.id).toBe("ws_test");
      expect(body.mode).toBe("daily");
      expect(body.provenance).toBeNull();
    } finally {
      setWorkspaceRootOverride(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports sandbox + provenance detail for a stamped manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wt-prov-"));
    try {
      seedManifest(dir, { provenance: { mode: "sandbox", source: { label: "Alex Daily" }, disposable: true } });
      const res = await fetchWorkspace(dir);
      const body = (await res.json()) as { mode: string; provenance: { mode: string; source: { label: string } } };
      expect(body.mode).toBe("sandbox");
      expect(body.provenance.source.label).toBe("Alex Daily");
    } finally {
      setWorkspaceRootOverride(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
