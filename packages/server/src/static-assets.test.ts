import { gunzipSync } from "node:zlib"
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
})

describe("static asset delivery", () => {
  it("compresses hashed assets, negotiates gzip, and revalidates each representation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worktable-delivery-"))
    try {
      mkdirSync(join(dir, "assets"))
      const path = "/assets/main-abcdefgh.js"
      const source = "console.log('asset');\n".repeat(200)
      writeFileSync(join(dir, path), source)
      const request = (headers: HeadersInit) =>
        new Request("http://localhost" + path, { headers })
      const compressed = createStaticFileResponse(
        dir,
        path,
        undefined,
        request({ "accept-encoding": "br, gzip" })
      )!
      expect(compressed.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable"
      )
      expect(compressed.headers.get("vary")).toContain("Accept-Encoding")
      expect(compressed.headers.get("content-encoding")).toBe("gzip")
      const bytes = Buffer.from(await compressed.arrayBuffer())
      expect(bytes.length).toBe(
        Number(compressed.headers.get("content-length"))
      )
      expect(bytes.length).toBeLessThan(source.length / 2)
      expect(gunzipSync(bytes).toString()).toBe(source)
      const plain = createStaticFileResponse(
        dir,
        path,
        undefined,
        request({ "accept-encoding": "gzip;q=0, *;q=1" })
      )!
      expect(plain.headers.get("content-encoding")).toBeNull()
      expect(await plain.text()).toBe(source)
      expect(plain.headers.get("etag")).not.toBe(compressed.headers.get("etag"))
      const revalidated = createStaticFileResponse(
        dir,
        path,
        undefined,
        request({
          "accept-encoding": "gzip",
          "if-none-match": compressed.headers.get("etag")!,
        })
      )!
      expect(revalidated.status).toBe(304)
      expect(await revalidated.text()).toBe("")
      expect(revalidated.headers.get("content-length")).toBeNull()
      expect(
        createStaticFileResponse(
          dir,
          path,
          undefined,
          request({ "if-none-match": compressed.headers.get("etag")! })
        )!.status
      ).toBe(200)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("keeps shells fresh and isolates cached bytes by file identity and root", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worktable-delivery-"))
    try {
      writeFileSync(join(dir, "_shell.html"), "first")
      const first = createStaticFileResponse(dir, "/_shell.html")!
      expect(first.headers.get("cache-control")).toBe("no-cache")
      expect(await first.text()).toBe("first")
      writeFileSync(join(dir, "_shell.html"), "second")
      const second = createStaticFileResponse(dir, "/_shell.html")!
      expect(await second.text()).toBe("second")
      expect(second.headers.get("etag")).not.toBe(first.headers.get("etag"))
      mkdirSync(join(dir, "other"))
      writeFileSync(join(dir, "other", "_shell.html"), "other")
      expect(
        await createStaticFileResponse(
          join(dir, "other"),
          "/_shell.html"
        )!.text()
      ).toBe("other")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
