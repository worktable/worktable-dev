import {
  brotliCompressSync,
  brotliDecompressSync,
  gunzipSync,
  gzipSync,
} from "node:zlib"
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStaticFileResponse,
  getStaticAssetsInfo,
  indexStaticAssets,
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
  it("serves the build's compressed copies of hashed assets and revalidates each representation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "worktable-delivery-"))
    try {
      mkdirSync(join(dir, "assets"))
      const path = "/assets/main-abcdefgh.js"
      const source = "console.log('asset');\n".repeat(200)
      writeFileSync(join(dir, path), source)
      writeFileSync(join(dir, path + ".br"), brotliCompressSync(source))
      writeFileSync(join(dir, path + ".gz"), gzipSync(source))
      // Small or unlisted files have no copies and are sent as they are.
      writeFileSync(join(dir, "assets", "tiny-abcdefgh.js"), "1;\n")
      expect(indexStaticAssets(dir)).toBe(1)
      const request = (headers: HeadersInit, method = "GET") =>
        new Request("http://localhost" + path, { headers, method })
      const respond = (headers: HeadersInit, method?: string) =>
        createStaticFileResponse(dir, path, undefined, request(headers, method))!

      const brotli = respond({ "accept-encoding": "gzip, deflate, br" })
      expect(brotli.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable"
      )
      expect(brotli.headers.get("content-type")).toContain("text/javascript")
      expect(brotli.headers.get("vary")).toContain("Accept-Encoding")
      expect(brotli.headers.get("content-encoding")).toBe("br")
      const brotliBytes = Buffer.from(await brotli.arrayBuffer())
      expect(brotliBytes.length).toBe(Number(brotli.headers.get("content-length")))
      expect(brotliDecompressSync(brotliBytes).toString()).toBe(source)

      const compressed = respond({ "accept-encoding": "gzip" })
      expect(compressed.headers.get("content-encoding")).toBe("gzip")
      expect(gunzipSync(Buffer.from(await compressed.arrayBuffer())).toString()).toBe(source)

      const plain = respond({ "accept-encoding": "gzip;q=0, br;q=0" })
      expect(plain.headers.get("content-encoding")).toBeNull()
      expect(await plain.text()).toBe(source)
      expect(plain.headers.get("content-length")).toBe(String(source.length))
      expect(
        new Set([brotli, compressed, plain].map((r) => r.headers.get("etag"))).size
      ).toBe(3)

      const revalidated = respond({
        "accept-encoding": "gzip",
        "if-none-match": `W/${compressed.headers.get("etag")}`,
      })
      expect(revalidated.status).toBe(304)
      expect(await revalidated.text()).toBe("")
      expect(revalidated.headers.get("content-length")).toBeNull()
      expect(
        respond({ "if-none-match": compressed.headers.get("etag")! }).status
      ).toBe(200)

      const head = respond({ "accept-encoding": "br" }, "HEAD")
      expect(head.headers.get("content-length")).toBe(String(brotliBytes.length))
      expect(await head.text()).toBe("")

      const tiny = createStaticFileResponse(
        dir,
        "/assets/tiny-abcdefgh.js",
        undefined,
        new Request("http://localhost/", { headers: { "accept-encoding": "br" } })
      )!
      expect(tiny.headers.get("content-encoding")).toBeNull()
      expect(await tiny.text()).toBe("1;\n")
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
