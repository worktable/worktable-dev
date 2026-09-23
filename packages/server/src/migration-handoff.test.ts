/** Portable staging provenance validation. */
import { describe, expect, it } from "bun:test";
import { validateStagingHandoff, type WorkspaceManifest } from "./workspace.ts";

function stagingManifest(overrides?: Partial<WorkspaceManifest>): WorkspaceManifest {
  return {
    type: "worktable.workspace",
    version: 1,
    id: "ws_staging_abc",
    name: "Migrated (staging)",
    createdAt: "2026-01-01T00:00:00.000Z",
    cloud: { status: "unlinked" },
    provenance: {
      mode: "staging",
      source: { label: "Example export", path: "/home/example/workspaces/staging" },
      snapshotAt: "2026-01-01T00:00:00.000Z",
      oneWay: true,
    },
    ...overrides,
  };
}

describe("validateStagingHandoff", () => {
  it("accepts a well-formed staging manifest", () => {
    const r = validateStagingHandoff(stagingManifest());
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("accepts a source identified by any one of label / path / workspaceId", () => {
    for (const source of [{ label: "X" }, { path: "/x" }, { workspaceId: "ws_src" }]) {
      const r = validateStagingHandoff(stagingManifest({ provenance: { mode: "staging", source } }));
      expect(r.ok).toBe(true);
    }
  });

  it("rejects a manifest with no provenance block", () => {
    const r = validateStagingHandoff(stagingManifest({ provenance: undefined }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("provenance");
  });

  it("rejects a non-staging mode (a sandbox/daily manifest is not a migration handoff)", () => {
    for (const mode of ["daily", "sandbox", "fixture"] as const) {
      const r = validateStagingHandoff(stagingManifest({ provenance: { mode, source: { label: "X" } } }));
      expect(r.ok).toBe(false);
      expect(r.errors.join(" ")).toContain("staging");
    }
  });

  it("rejects a staging manifest whose source identifies nothing", () => {
    const r = validateStagingHandoff(stagingManifest({ provenance: { mode: "staging", source: {} } }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("source");
  });

  it("rejects truthy-but-empty source values (whitespace-only string, or a non-string)", () => {
    const bad: unknown[] = [{ label: "   " }, { path: "" }, { workspaceId: {} }, { label: [] }];
    for (const source of bad) {
      const r = validateStagingHandoff(stagingManifest({ provenance: { mode: "staging", source } as never }));
      expect(r.ok).toBe(false);
    }
  });

  it("rejects values that are not workspace manifests at all", () => {
    for (const junk of [null, undefined, {}, { type: "nope" }, "string", 42]) {
      expect(validateStagingHandoff(junk).ok).toBe(false);
    }
  });
});
