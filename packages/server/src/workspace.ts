import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { workspaceStorageLayoutFromManifest } from "./workspace-storage-v2.ts";

// ============================================================
// Workspace root resolution
// ============================================================
//
// The workspace is the single user-selected folder that holds portable user
// content. Everything the user should be able to move, back up, git, inspect,
// or open on another machine lives under it:
//
//   <root>/worktable.workspace.json  workspace identity and portable metadata
//   <root>/spaces/                   spaces, docs, widgets, records, annotations
//   <root>/versions/                 doc version history
//
// Machine-local runtime state (install config, tokens, service logs, caches,
// Yjs binary edit state) belongs in app-private storage, not the workspace.

export interface WorkspaceProvider {
  root(): string;
  spacesDir(): string;
  versionsDir(): string;
}

export type WorkspaceMode = "daily" | "staging" | "sandbox" | "fixture";

/** Where a workspace came from. Absence on the manifest === a normal ("daily") workspace. */
export interface WorkspaceProvenance {
  mode: WorkspaceMode;
  /** The workspace this was copied/derived from. */
  source?: {
    workspaceId?: string;
    label?: string;
    path?: string;
    host?: string;
  };
  /** When the snapshot was taken. */
  snapshotAt?: string;
  /** Snapshot copies are one-way (edits never sync back). */
  oneWay?: boolean;
  /** Edits here are disposable. */
  disposable?: boolean;
  /** For mode "fixture": the fixture name. */
  fixtureName?: string;
}

export interface WorkspaceManifest {
  type: "worktable.workspace";
  version: 1 | 2;
  id: string;
  name: string;
  createdAt: string;
  cloud: {
    status: "unlinked";
  };
  /**
   * Portable first-run state. Absence means an existing workspace that
   * predates onboarding and is therefore already set up.
   */
  onboarding?: {
    version: 1;
    status: "pending" | "complete";
    completedAt?: string;
  };
  /** Optional provenance metadata. Absence === a normal ("daily") workspace. */
  provenance?: WorkspaceProvenance;
  // NOTE: the configured public origin (`publicUrl`) is NOT a manifest field. It
  // is machine-local — a tunnel/reverse-proxy URL belongs to this install, not
  // to the portable workspace — so it lives in the settings store
  // (`network.publicUrl`; see settings-store.ts), never here. An earlier build of
  // this branch stored it here; a stale `publicUrl` on a hand-carried manifest is
  // simply ignored (unknown keys don't invalidate `isWorkspaceManifest`).
}

const WORKSPACE_MODES: readonly WorkspaceMode[] = [
  "daily",
  "staging",
  "sandbox",
  "fixture",
];

/**
 * The validated workspace mode. Defaults to "daily" for an absent or unrecognized
 * provenance block — so a malformed `provenance` never makes a real workspace look like
 * a sandbox, and never has to invalidate the whole manifest.
 */
export function workspaceProvenanceMode(
  manifest: WorkspaceManifest
): WorkspaceMode {
  const mode = manifest.provenance?.mode;
  return mode && WORKSPACE_MODES.includes(mode) ? mode : "daily";
}

export interface MigrationHandoffResult {
  ok: boolean;
  /** Empty when ok; otherwise one human-readable reason per contract violation. */
  errors: string[];
}

/**
 * Validate portable staging provenance. Importers own how content is produced; core
 * depends only on this manifest seam for provenance UI and source-write guards.
 */
export function validateStagingHandoff(value: unknown): MigrationHandoffResult {
  if (!isWorkspaceManifest(value)) {
    return {
      ok: false,
      errors: [
        "not a valid worktable workspace manifest (type/version/id/name/cloud.status)",
      ],
    };
  }
  const errors: string[] = [];
  const provenance = value.provenance;
  if (!provenance) {
    errors.push(
      'missing provenance block (a migration-produced workspace must carry one with mode "staging")'
    );
  } else {
    if (provenance.mode !== "staging") {
      errors.push(
        `provenance.mode must be "staging" (got ${JSON.stringify(provenance.mode)})`
      );
    }
    // A non-empty STRING is required — a truthy-but-empty value (whitespace-only string, or
    // a non-string like {} / []) carries no traceability and must not pass.
    const nonEmpty = (v: unknown): boolean =>
      typeof v === "string" && v.trim().length > 0;
    const source = provenance.source;
    if (
      !source ||
      !(
        nonEmpty(source.label) ||
        nonEmpty(source.path) ||
        nonEmpty(source.workspaceId)
      )
    ) {
      errors.push(
        "provenance.source must identify the staging origin with a non-empty label, path, or workspaceId"
      );
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Override for testing. Set before calling any store functions. */
let _rootOverride: string | null = null;

export function setWorkspaceRootOverride(dir: string | null): void {
  _rootOverride = dir;
}

export function getWorkspaceRoot(): string {
  if (_rootOverride) return _rootOverride;
  const env = process.env["WORKTABLE_WORKSPACE"]?.trim();
  if (env) return resolve(env);
  return join(homedir(), "Worktable");
}

// Stable per-workspace key for machine-local caches (Yjs state, record index).
// Keying app-data state by workspace root means a moved or copied workspace
// gets fresh caches instead of inheriting another copy's state.
export function workspaceCacheKey(): string {
  return createHash("sha256")
    .update(getWorkspaceRoot())
    .digest("hex")
    .slice(0, 16);
}

export function getSpacesDir(): string {
  return join(getWorkspaceRoot(), "spaces");
}

export function getVersionsDir(): string {
  return join(getWorkspaceRoot(), "versions");
}

export function getWorkspaceManifestPath(): string {
  return join(getWorkspaceRoot(), "worktable.workspace.json");
}

/** Portable per-space document alias metadata. */
export function getDocAliasesPath(spaceId: string): string {
  return join(getSpacesDir(), spaceId, "doc-aliases.json");
}

/** Portable per-space inventory for the format-neutral document kernel. */
export function getDocumentInventoryPath(spaceId: string): string {
  return join(getSpacesDir(), spaceId, "documents.meta.json");
}

function makeId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("base64url")}`;
}

export function isWorkspaceManifest(
  value: unknown
): value is WorkspaceManifest {
  if (
    value &&
    typeof value === "object" &&
    (value as Record<string, unknown>)["version"] === 2
  ) {
    return workspaceStorageLayoutFromManifest(value).kind === "v2";
  }
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const cloud = candidate["cloud"] as Record<string, unknown> | undefined;
  const onboarding = candidate["onboarding"];
  const validOnboarding =
    onboarding === undefined ||
    (onboarding !== null &&
      typeof onboarding === "object" &&
      !Array.isArray(onboarding) &&
      (onboarding as Record<string, unknown>)["version"] === 1 &&
      ["pending", "complete"].includes(
        String((onboarding as Record<string, unknown>)["status"])
      ) &&
      ((onboarding as Record<string, unknown>)["completedAt"] === undefined ||
        typeof (onboarding as Record<string, unknown>)["completedAt"] ===
          "string"));
  return (
    candidate["type"] === "worktable.workspace" &&
    candidate["version"] === 1 &&
    typeof candidate["id"] === "string" &&
    typeof candidate["name"] === "string" &&
    typeof candidate["createdAt"] === "string" &&
    cloud?.["status"] === "unlinked" &&
    validOnboarding
  );
}

// ============================================================
// Workspace folder classification
// ============================================================
//
// Before initializing or adopting a workspace folder we classify it into one
// of four outcomes so callers (CLI setup, server boot) can branch explicitly
// instead of silently overwriting an unfamiliar or unreadable folder.

export type WorkspaceRejectReason =
  | "not-a-directory"
  | "non-empty-non-workspace"
  | "corrupt-manifest"
  | "unsupported-version"
  | "symlink";

export type WorkspaceClassification =
  | { outcome: "missing" }
  | { outcome: "empty" }
  | { outcome: "valid"; manifest: WorkspaceManifest; name: string }
  | { outcome: "reject"; reason: WorkspaceRejectReason; message: string };

export type WorkspacePreparationIntent = "create" | "open" | "create-or-open";

export type WorkspaceInspection =
  | { outcome: "missing"; path: string }
  | { outcome: "empty"; path: string }
  | {
      outcome: "valid";
      path: string;
      workspace: Pick<WorkspaceManifest, "id" | "name" | "createdAt">;
    }
  | {
      outcome: "reject";
      path: string;
      reason: WorkspaceRejectReason;
      message: string;
    };

export interface PreparedWorkspace {
  path: string;
  created: boolean;
  manifest: WorkspaceManifest;
}

export type WorkspacePreparationErrorCode =
  | "EXPECTED_EMPTY_WORKSPACE"
  | "EXPECTED_EXISTING_WORKSPACE";

/**
 * Raised when a workspace folder cannot be safely adopted or initialized.
 * Carries the machine-readable reason and a human-facing message that names
 * the folder and states that no changes were made.
 */
export class WorkspaceAdoptionError extends Error {
  readonly reason: WorkspaceRejectReason;
  constructor(reason: WorkspaceRejectReason, message: string) {
    super(message);
    this.name = "WorkspaceAdoptionError";
    this.reason = reason;
  }
}

/** Raised when a safe folder classification does not match the caller's intent. */
export class WorkspacePreparationError extends Error {
  readonly code: WorkspacePreparationErrorCode;
  readonly path: string;

  constructor(
    code: WorkspacePreparationErrorCode,
    path: string,
    message: string
  ) {
    super(message);
    this.name = "WorkspacePreparationError";
    this.code = code;
    this.path = path;
  }
}

// Cosmetic OS metadata files that should not make an otherwise-empty folder
// look "occupied". Deliberately narrow — a real .git/.ssh folder must reject.
const IGNORED_EMPTY_ENTRIES = new Set([".DS_Store", "Thumbs.db", ".localized"]);

export function isIgnoredEmptyWorkspaceEntry(name: string): boolean {
  return IGNORED_EMPTY_ENTRIES.has(name);
}

const MANIFEST_FILE = "worktable.workspace.json";

/**
 * Side-effect-free classification of a candidate workspace folder. Takes an
 * explicit path so callers can inspect a candidate before any config is
 * applied. Never throws on bad input (corrupt JSON, missing dir, etc.) — all
 * problems surface as `{ outcome: "reject" }`.
 */
export function classifyWorkspaceTarget(path: string): WorkspaceClassification {
  const root = resolve(path);

  // lstat first so a symlink at the workspace root is rejected outright
  // (defends against following a link to a foreign or privileged location).
  let linkStat: ReturnType<typeof lstatSync> | null = null;
  try {
    linkStat = lstatSync(root);
  } catch {
    linkStat = null;
  }
  if (linkStat?.isSymbolicLink()) {
    return {
      outcome: "reject",
      reason: "symlink",
      message: `Workspace folder "${root}" is a symbolic link. Worktable will not use a symlinked workspace root; point it at a real directory. No changes were made.`,
    };
  }

  if (!existsSync(root)) return { outcome: "missing" };

  let dirStat: ReturnType<typeof statSync>;
  try {
    dirStat = statSync(root);
  } catch {
    return {
      outcome: "reject",
      reason: "not-a-directory",
      message: `Workspace path "${root}" could not be read as a directory. No changes were made.`,
    };
  }
  if (!dirStat.isDirectory()) {
    return {
      outcome: "reject",
      reason: "not-a-directory",
      message: `Workspace path "${root}" is a file, not a directory. Choose a folder. No changes were made.`,
    };
  }

  const manifestPath = join(root, MANIFEST_FILE);
  if (existsSync(manifestPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      return {
        outcome: "reject",
        reason: "corrupt-manifest",
        message: `Workspace folder "${root}" contains an unreadable ${MANIFEST_FILE} (invalid JSON). Worktable will not overwrite it; repair or remove the file. No changes were made.`,
      };
    }
    if (isWorkspaceManifest(parsed)) {
      return { outcome: "valid", manifest: parsed, name: parsed.name };
    }
    return {
      outcome: "reject",
      reason: "unsupported-version",
      message: `Workspace folder "${root}" contains a ${MANIFEST_FILE} that Worktable does not recognize (unsupported version or format). Worktable will not overwrite it. No changes were made.`,
    };
  }

  // No manifest: only an empty folder (modulo cosmetic OS files) may be
  // initialized. Anything else is someone else's data — reject.
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return {
      outcome: "reject",
      reason: "not-a-directory",
      message: `Workspace folder "${root}" could not be listed. No changes were made.`,
    };
  }
  const meaningful = entries.filter(
    (name) => !isIgnoredEmptyWorkspaceEntry(name)
  );
  if (meaningful.length === 0) return { outcome: "empty" };

  return {
    outcome: "reject",
    reason: "non-empty-non-workspace",
    message: `Folder "${root}" already contains other files and is not a Worktable workspace. Choose an empty folder or an existing Worktable workspace. No changes were made.`,
  };
}

/**
 * Stable machine-facing projection of the workspace classifier. The explicit
 * canonical path is included so native hosts never need to recreate the
 * workspace provider's default-path rules.
 */
export function inspectWorkspaceTarget(
  path = getWorkspaceRoot()
): WorkspaceInspection {
  const canonicalPath = resolve(path);
  const classification = classifyWorkspaceTarget(canonicalPath);
  switch (classification.outcome) {
    case "missing":
    case "empty":
      return { outcome: classification.outcome, path: canonicalPath };
    case "valid":
      return {
        outcome: "valid",
        path: canonicalPath,
        workspace: {
          id: classification.manifest.id,
          name: classification.manifest.name,
          createdAt: classification.manifest.createdAt,
        },
      };
    case "reject":
      return {
        outcome: "reject",
        path: canonicalPath,
        reason: classification.reason,
        message: classification.message,
      };
  }
}

function writeWorkspaceManifestAt(
  root: string,
  manifest: WorkspaceManifest
): void {
  writeWorkspaceManifestBytesAt(
    root,
    JSON.stringify(manifest, null, 2) + "\n"
  );
}

/**
 * Atomically replace a manifest with owner-only permissions. Import paths use
 * this instead of writing through the extracted inode, whose source mode may
 * be read-only or overly permissive.
 */
export function writeWorkspaceManifestBytesAt(
  root: string,
  contents: string | Uint8Array
): void {
  mkdirSync(root, { recursive: true });
  const path = join(root, MANIFEST_FILE);
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, contents, { flag: "wx", mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Prepare an explicit folder for a caller with a declared create/open intent.
 * Classification and mutation stay together in the workspace path authority,
 * so Desktop and other supervised callers never duplicate adoption rules.
 */
export function prepareWorkspaceTarget(
  path: string,
  intent: WorkspacePreparationIntent
): PreparedWorkspace {
  const root = resolve(path);
  const classification = classifyWorkspaceTarget(root);

  if (classification.outcome === "reject") {
    throw new WorkspaceAdoptionError(
      classification.reason,
      classification.message
    );
  }

  if (classification.outcome === "valid") {
    if (intent === "create") {
      throw new WorkspacePreparationError(
        "EXPECTED_EMPTY_WORKSPACE",
        root,
        `Folder "${root}" is already the Worktable workspace "${classification.name}". Open it instead of creating a new workspace. No changes were made.`
      );
    }
    return { path: root, created: false, manifest: classification.manifest };
  }

  if (intent === "open") {
    throw new WorkspacePreparationError(
      "EXPECTED_EXISTING_WORKSPACE",
      root,
      `Folder "${root}" is not an existing Worktable workspace. Create a workspace there instead. No changes were made.`
    );
  }

  const manifest: WorkspaceManifest = {
    type: "worktable.workspace",
    version: 1,
    id: makeId("ws"),
    name: "Local Workspace",
    createdAt: new Date().toISOString(),
    cloud: { status: "unlinked" },
    onboarding: { version: 1, status: "pending" },
  };
  writeWorkspaceManifestAt(root, manifest);
  return { path: root, created: true, manifest };
}

export function ensureWorkspaceManifest(): WorkspaceManifest {
  return prepareWorkspaceTarget(getWorkspaceRoot(), "create-or-open").manifest;
}

/**
 * Persist a full manifest, preserving whatever fields the caller carried through
 * (never a partial write). Atomic tmp→rename at mode 0600 — mirrors the manifest
 * write in `ensureWorkspaceManifest`, upgraded to tmp+rename so a concurrent
 * reader never sees a half-written file.
 */
export function writeWorkspaceManifest(manifest: WorkspaceManifest): void {
  const root = getWorkspaceRoot();
  // Unique tmp per write (pid alone is shared by concurrent writers in one
  // process): the loser of an overlapping rename must not ENOENT on a tmp file
  // the winner already moved.
  writeWorkspaceManifestAt(root, manifest);
}

export const workspace: WorkspaceProvider = {
  root: getWorkspaceRoot,
  spacesDir: getSpacesDir,
  versionsDir: getVersionsDir,
};
