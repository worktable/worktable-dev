import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { FIXTURES, getFixture, type FixtureDef } from "./defs.ts";
import { generateInto } from "./generate.ts";
import { FixtureBuilder } from "./harness.ts";
import { seedStarterWorkspace } from "../seed.ts";
import { listSpaces } from "../store.ts";
import { ensureWorkspaceManifest, setWorkspaceRootOverride } from "../workspace.ts";

async function generate(name: string, dir: string): Promise<void> {
  const def = getFixture(name);
  const b = new FixtureBuilder(dir);
  await def.build(b);
  await b.finalize(def.workspace);
  setWorkspaceRootOverride(null);
}

/** Recursively read every file under `dir` as relpath -> content (for byte-equality). */
function readTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(dir, p), readFileSync(p, "utf8"));
    }
  };
  walk(dir);
  return out;
}

afterEach(() => setWorkspaceRootOverride(null));

describe("fixture generator (basic-docs)", () => {
  test("fixture CLI verifies committed examples in a fresh process", () => {
    // Cold startup exposed a format/reader import cycle hidden by suite ordering.
    // The all-fixtures test below owns repeated generation determinism.
    expect(() => execFileSync(process.execPath, [
      "run", join(import.meta.dir, "cli.ts"), "verify",
    ], { stdio: "pipe", timeout: 10_000 })).not.toThrow();
  });

  test("opens as a valid workspace and does NOT trigger the welcome seed (seed-guard immunity)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wt-fix-seed-"));
    try {
      await generate("basic-docs", dir);
      setWorkspaceRootOverride(dir);
      // Manifest is contract-valid (ensureWorkspaceManifest accepts it, keeps the fixed id).
      expect(ensureWorkspaceManifest().id).toBe("ws_fixture_basic_docs");
      // A content-bearing fixture must short-circuit seeding — welcome is never injected.
      expect(await seedStarterWorkspace()).toBe(false);
      const spaceIds = (await listSpaces()).map((s) => s.id).sort();
      expect(spaceIds).toEqual(["notes"]);
    } finally {
      setWorkspaceRootOverride(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("all fixtures", () => {
  test("every fixture generates byte-identically on re-run (determinism gate)", async () => {
    for (const name of Object.keys(FIXTURES)) {
      const a = mkdtempSync(join(tmpdir(), `wt-fix-${name}-a-`));
      const b = mkdtempSync(join(tmpdir(), `wt-fix-${name}-b-`));
      try {
        await generate(name, a);
        await generate(name, b);
        expect([...readTree(a).entries()].sort()).toEqual([...readTree(b).entries()].sort());
      } finally {
        rmSync(a, { recursive: true, force: true });
        rmSync(b, { recursive: true, force: true });
      }
    }
  });
});

describe("generate crash-safety", () => {
  test("a failing generate leaves an existing committed fixture intact", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wt-fix-committed-"));
    writeFileSync(join(dir, "SENTINEL"), "keep-me");
    const boom: FixtureDef = {
      name: "boom",
      proves: "",
      workspace: { id: "ws_boom", name: "Boom" },
      build: async (b: FixtureBuilder) => {
        await b.space({ id: "x", name: "X" });
        throw new Error("boom mid-build");
      },
    };
    try {
      await expect(generateInto(boom, dir)).rejects.toThrow("boom");
      // The committed fixture (sentinel) must survive the failed regeneration.
      expect(existsSync(join(dir, "SENTINEL"))).toBe(true);
    } finally {
      setWorkspaceRootOverride(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("regenerating over an existing fixture replaces it cleanly (no leftover staging/backup)", async () => {
    const parent = mkdtempSync(join(tmpdir(), "wt-fix-parent-"));
    const outDir = join(parent, "basic-docs");
    mkdirSync(outDir);
    writeFileSync(join(outDir, "STALE"), "old content");
    try {
      await generateInto(getFixture("basic-docs"), outDir);
      expect(existsSync(join(outDir, "STALE"))).toBe(false); // old content replaced
      expect(existsSync(join(outDir, "worktable.workspace.json"))).toBe(true); // new content present
      // The swap leaves no staging (.fixgen) or backup (.fixbak) dirs behind.
      expect(readdirSync(parent).filter((e) => e.startsWith(".fix"))).toEqual([]);
    } finally {
      setWorkspaceRootOverride(null);
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
