import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAppDirOverride } from "./app-storage.ts";
import { ensureInstallIdentity, getInstallIdentityPath } from "./local-identity.ts";

let appDir: string;

beforeEach(() => {
  appDir = mkdtempSync(join(tmpdir(), "worktable-app-identity-"));
  setAppDirOverride(appDir);
});

afterEach(() => {
  setAppDirOverride(null);
  if (existsSync(appDir)) rmSync(appDir, { recursive: true, force: true });
});

describe("install identity", () => {
  it("creates and reuses a stable app-private install identity", async () => {
    const identity = ensureInstallIdentity();
    expect(identity).toMatchObject({
      type: "worktable.install",
      version: 1,
      releaseChannel: "stable",
    });
    expect(identity.id).toMatch(/^ins_/);
    expect(existsSync(getInstallIdentityPath())).toBe(true);

    const persisted = JSON.parse(await readFile(getInstallIdentityPath(), "utf8"));
    expect(persisted.id).toBe(identity.id);
    expect(ensureInstallIdentity().id).toBe(identity.id);
  });
});
