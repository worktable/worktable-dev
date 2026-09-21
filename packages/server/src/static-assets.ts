import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";

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
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export function createStaticFileResponse(
  staticDir: string,
  requestPath: string,
  headers?: HeadersInit
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

  const body = readFileSync(filePath);
  const responseHeaders = new Headers(headers);
  if (!responseHeaders.has("Content-Type")) {
    responseHeaders.set("Content-Type", contentTypeFor(filePath));
  }
  responseHeaders.set("Content-Length", String(stats.size));
  return new Response(body, { headers: responseHeaders });
}
