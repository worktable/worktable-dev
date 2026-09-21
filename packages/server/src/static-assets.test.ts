import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStaticFileResponse,
  getStaticAssetsInfo,
  resolveStaticFilePath,
} from "./static-assets.ts";

const ORIGINAL_STATIC_DIR = process.env["WORKTABLE_STATIC_DIR"];
const ORIGINAL_RELEASE_DIR = process.env["WORKTABLE_RELEASE_DIR"];

afterEach(() => {
  if (ORIGINAL_STATIC_DIR === undefined) {
    delete process.env["WORKTABLE_STATIC_DIR"];
  } else {
    process.env["WORKTABLE_STATIC_DIR"] = ORIGINAL_STATIC_DIR;
  }
  if (ORIGINAL_RELEASE_DIR === undefined) {
    delete process.env["WORKTABLE_RELEASE_DIR"];
  } else {
    process.env["WORKTABLE_RELEASE_DIR"] = ORIGINAL_RELEASE_DIR;
  }
});

describe("static asset resolution", () => {
  it("prefers WORKTABLE_STATIC_DIR when it contains a shell", () => {
    const dir = mkdtempSync(join(tmpdir(), "worktable-static-"));
    try {
      writeFileSync(join(dir, "index.html"), "<!doctype html>");
      process.env["WORKTABLE_STATIC_DIR"] = dir;
      delete process.env["WORKTABLE_RELEASE_DIR"];

      const info = getStaticAssetsInfo();
      expect(info.source).toBe("env");
      expect(info.staticDir).toBe(dir);
      expect(info.shellPath).toBe(join(dir, "index.html"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses release manifest staticDirRelative from WORKTABLE_RELEASE_DIR", () => {
    const releaseDir = mkdtempSync(join(tmpdir(), "worktable-release-"));
    try {
      mkdirSync(join(releaseDir, "web"), { recursive: true });
      writeFileSync(join(releaseDir, "web", "_shell.html"), "<!doctype html>");
      writeFileSync(
        join(releaseDir, "manifest.json"),
        JSON.stringify({ staticDirRelative: "web" })
      );
      delete process.env["WORKTABLE_STATIC_DIR"];
      process.env["WORKTABLE_RELEASE_DIR"] = releaseDir;

      const info = getStaticAssetsInfo();
      expect(info.source).toBe("release-env");
      expect(info.staticDir).toBe(join(releaseDir, "web"));
      expect(info.shellPath).toBe(join(releaseDir, "web", "_shell.html"));
    } finally {
      rmSync(releaseDir, { recursive: true, force: true });
    }
  });

  it("skips explicit env paths that do not contain a shell", () => {
    const dir = mkdtempSync(join(tmpdir(), "worktable-empty-static-"));
    try {
      process.env["WORKTABLE_STATIC_DIR"] = dir;
      delete process.env["WORKTABLE_RELEASE_DIR"];

      const info = getStaticAssetsInfo();
      if (info.source === "env") {
        throw new Error("empty static dir should not be accepted");
      }
      expect(info.checked).toContain(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("static file responses", () => {
  it("serves files with an explicit content length", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worktable-static-response-"));
    try {
      mkdirSync(join(dir, "assets"), { recursive: true });
      writeFileSync(join(dir, "assets", "main.js"), "console.log('ok');\n");

      const response = createStaticFileResponse(dir, "/assets/main.js");
      expect(response?.status).toBe(200);
      expect(response?.headers.get("content-type")).toContain("text/javascript");
      expect(response?.headers.get("content-length")).toBe("19");
      expect(await response?.text()).toBe("console.log('ok');\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows content-type overrides for known app files", () => {
    const dir = mkdtempSync(join(tmpdir(), "worktable-static-response-"));
    try {
      writeFileSync(join(dir, "manifest.webmanifest"), "{}\n");

      const response = createStaticFileResponse(dir, "/manifest.webmanifest", {
        "Content-Type": "application/manifest+json",
      });
      expect(response?.headers.get("content-type")).toBe(
        "application/manifest+json"
      );
      expect(response?.headers.get("content-length")).toBe("3");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects traversal outside the static root", () => {
    const dir = mkdtempSync(join(tmpdir(), "worktable-static-response-"));
    try {
      expect(resolveStaticFilePath(dir, "/assets/%2e%2e/secret.txt")).toBeNull();
      expect(createStaticFileResponse(dir, "/assets/../secret.txt")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
