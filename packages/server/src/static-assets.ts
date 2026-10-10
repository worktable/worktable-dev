import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { preferredEncoding, type ContentEncoding } from "./http-compression.ts";

export type StaticAssetsSource =
  | "env"
  | "release-env"
  | "executable-relative"
  | "dev"
  | "missing";

export interface StaticAssetsInfo {
  staticDir: string | null;
  shellPath: string | null;
  source: StaticAssetsSource;
  checked: string[];
}

interface ReleaseManifest {
  staticDirRelative?: string;
}

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/**
 * The id of the web build in a static directory (build-id.txt, written by the
 * web build), or null when there is none, as in development.
 */
export function readBuildId(staticDir: string | null): string | null {
  if (!staticDir) return null;
  try {
    return readFileSync(join(staticDir, "build-id.txt"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

function shellPathFor(dir: string): string | null {
  const shell = join(dir, "_shell.html");
  if (existsSync(shell)) return shell;
  const index = join(dir, "index.html");
  if (existsSync(index)) return index;
  return null;
}

function releaseStaticDir(releaseDir: string): string {
  const manifestPath = join(releaseDir, "manifest.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ReleaseManifest;
      if (manifest.staticDirRelative) {
        return resolve(releaseDir, manifest.staticDirRelative);
      }
    } catch {
      // Invalid manifests are ignored for resolution; doctor reports the paths.
    }
  }
  return join(releaseDir, "web");
}

function addCandidate(
  candidates: Array<{ source: StaticAssetsSource; dir: string }>,
  source: StaticAssetsSource,
  dir: string | undefined
): void {
  if (!dir?.trim()) return;
  candidates.push({ source, dir: resolve(dir) });
}

function possibleExecutableReleaseDirs(): string[] {
  const paths = [process.argv[1], process.execPath].filter(
    (value): value is string => Boolean(value)
  );
  const dirs: string[] = [];
  for (const executable of paths) {
    const binDir = dirname(resolve(executable));
    dirs.push(dirname(binDir));
  }
  return [...new Set(dirs)];
}

export function getStaticAssetsInfo(): StaticAssetsInfo {
  const candidates: Array<{ source: StaticAssetsSource; dir: string }> = [];

  addCandidate(candidates, "env", process.env["WORKTABLE_STATIC_DIR"]);

  const releaseDir = process.env["WORKTABLE_RELEASE_DIR"]?.trim();
  if (releaseDir) {
    addCandidate(candidates, "release-env", releaseStaticDir(releaseDir));
  }

  for (const dir of possibleExecutableReleaseDirs()) {
    addCandidate(candidates, "executable-relative", releaseStaticDir(dir));
  }

  const distRoot = join(import.meta.dir, "../../../apps/web/dist");
  const clientDir = join(distRoot, "client");
  addCandidate(candidates, "dev", clientDir);
  addCandidate(candidates, "dev", distRoot);

  const checked: string[] = [];
  for (const candidate of candidates) {
    checked.push(candidate.dir);
    const shellPath = shellPathFor(candidate.dir);
    if (shellPath) {
      return {
        staticDir: candidate.dir,
        shellPath,
        source: candidate.source,
        checked,
      };
    }
  }

  return { staticDir: null, shellPath: null, source: "missing", checked };
}

export function resolveStaticFilePath(
  staticDir: string,
  requestPath: string
): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;

  const segments = decoded.split("/").filter(Boolean);
  if (segments.includes("..")) return null;

  const root = resolve(staticDir);
  const relativePath = decoded.replace(/^\/+/, "");
  const filePath = resolve(root, relativePath);
  if (filePath !== root && !filePath.startsWith(root + sep)) return null;
  return filePath;
}

function contentTypeFor(path: string): string {
  return (
    CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream"
  )
}

// Vite names build assets by content hash, so their bytes never change.
const IMMUTABLE_ASSET = /^\/assets\/[^/]+-[\w-]{8,}\.[a-z0-9]+$/i

type EncodedVariant = { path: string; size: number }
type Precompressed = Partial<Record<ContentEncoding, EncodedVariant>>
const precompressedByRoot = new Map<string, Map<string, Precompressed>>()

/**
 * List the Brotli and gzip copies that the web build writes beside hashed
 * assets. Requests then serve those files directly: nothing is compressed or
 * held in memory at run time. Called at startup; later calls rescan.
 */
export function indexStaticAssets(staticDir: string): number {
  const root = resolve(staticDir)
  const index = new Map<string, Precompressed>()
  const assets = join(root, "assets")
  let names: string[] = []
  try {
    names = readdirSync(assets)
  } catch {
    // A build without hashed assets has nothing to index.
  }
  const present = new Set(names)
  for (const name of names) {
    const match = /^(.+)\.(br|gz)$/.exec(name)
    if (!match || !present.has(match[1]!)) continue
    const path = join(assets, name)
    const variants = index.get(join(assets, match[1]!)) ?? {}
    variants[match[2] === "br" ? "br" : "gzip"] = {
      path,
      size: statSync(path).size,
    }
    index.set(join(assets, match[1]!), variants)
  }
  precompressedByRoot.set(root, index)
  return index.size
}

function precompressedFor(staticDir: string, filePath: string) {
  const root = resolve(staticDir)
  if (!precompressedByRoot.has(root)) indexStaticAssets(root)
  return precompressedByRoot.get(root)!.get(filePath)
}

export function createStaticFileResponse(
  staticDir: string,
  requestPath: string,
  headers?: HeadersInit,
  request?: Request
): Response | null {
  const filePath = resolveStaticFilePath(staticDir, requestPath);
  if (!filePath) return null;

  let stats;
  try {
    stats = statSync(filePath);
  } catch {
    return null;
  }
  if (!stats.isFile()) return null;

  const responseHeaders = new Headers(headers);
  if (!responseHeaders.has("Content-Type")) {
    responseHeaders.set("Content-Type", contentTypeFor(filePath));
  }
  const compressible =
    /^(text\/|application\/(json|manifest\+json)|image\/svg\+xml)/.test(
      responseHeaders.get("Content-Type")!
    )
  if (compressible) responseHeaders.append("Vary", "Accept-Encoding")
  const immutable = IMMUTABLE_ASSET.test(requestPath)
  // Only hashed assets have build-time copies; other files are small.
  const variants = immutable ? precompressedFor(staticDir, filePath) : undefined
  const encoding = variants
    ? preferredEncoding(
        request?.headers.get("accept-encoding") ?? "",
        (["br", "gzip"] as const).filter((coding) => variants[coding])
      )
    : null
  const body =
    encoding && variants ? variants[encoding]! : { path: filePath, size: stats.size }

  if (!responseHeaders.has("Cache-Control")) {
    responseHeaders.set(
      "Cache-Control",
      immutable ? "public, max-age=31536000, immutable" : "no-cache"
    )
  }
  // File identity, not content: an atomic replace or rewrite changes it.
  const identity = [stats.ino, stats.size, Math.round(stats.mtimeMs * 1000)]
    .map((part) => part.toString(36))
    .join("-")
  const etag = `"${identity}${encoding ? `-${encoding}` : ""}"`
  responseHeaders.set("ETag", etag)
  if (encoding) responseHeaders.set("Content-Encoding", encoding)
  const ifNoneMatch = request?.headers.get("if-none-match")
  if (
    ifNoneMatch
      ?.split(",")
      .some(
        (tag) => tag.trim() === "*" || tag.trim().replace(/^W\//, "") === etag
      )
  ) {
    responseHeaders.delete("Content-Length")
    return new Response(null, { status: 304, headers: responseHeaders })
  }
  responseHeaders.set("Content-Length", String(body.size));
  return new Response(
    request?.method === "HEAD" ? null : Bun.file(body.path),
    { headers: responseHeaders }
  );
}
