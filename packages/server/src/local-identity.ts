import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { ensureAppDir } from "./app-storage.ts";

export interface InstallIdentity {
  type: "worktable.install";
  version: 1;
  id: string;
  createdAt: string;
  releaseChannel: "stable";
}

export function getInstallIdentityPath(): string {
  return join(ensureAppDir(), "install.json");
}

function makeId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("base64url")}`;
}

function isInstallIdentity(value: unknown): value is InstallIdentity {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate["type"] === "worktable.install" &&
    candidate["version"] === 1 &&
    typeof candidate["id"] === "string" &&
    typeof candidate["createdAt"] === "string" &&
    candidate["releaseChannel"] === "stable"
  );
}

export function ensureInstallIdentity(): InstallIdentity {
  const path = getInstallIdentityPath();
  if (existsSync(path)) {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isInstallIdentity(parsed)) return parsed;
  }

  const identity: InstallIdentity = {
    type: "worktable.install",
    version: 1,
    id: makeId("ins"),
    createdAt: new Date().toISOString(),
    releaseChannel: "stable",
  };
  writeFileSync(path, JSON.stringify(identity, null, 2) + "\n", {
    mode: 0o600,
  });
  return identity;
}
