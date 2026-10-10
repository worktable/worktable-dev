// Worktable Desktop's own updates, as seen from a local workspace page. The
// commands exist only in Desktop and only for its active local workspace, so
// every call resolves to null anywhere else (a browser, a remote server).

export type DesktopUpdateState =
  | "idle"
  | "checking"
  | "downloading"
  | "ready"
  | "installing"
  | "current"
  | "error"
  | "recovery"

export interface DesktopUpdateCheck {
  checkedAt: number
  outcome: "current" | "available" | "failed"
  message: string | null
}

export interface DesktopUpdateStatus {
  currentVersion: string
  state: DesktopUpdateState
  availableVersion: string | null
  notes: string | null
  downloadedBytes: number
  totalBytes: number | null
  canRestart: boolean
  lastCheck: DesktopUpdateCheck | null
}

type NativeInvoke = (command: string, args?: unknown) => Promise<unknown>

interface DesktopGlobal {
  __TAURI__?: { core?: { invoke?: NativeInvoke } }
}

const STATES = new Set<DesktopUpdateState>([
  "idle",
  "checking",
  "downloading",
  "ready",
  "installing",
  "current",
  "error",
  "recovery",
])
const OUTCOMES = new Set(["current", "available", "failed"])

function invoke(): NativeInvoke | null {
  return (
    (globalThis as typeof globalThis & DesktopGlobal).__TAURI__?.core?.invoke ??
    null
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Desktop refuses these commands outside the active local workspace. */
function unavailableError(error: unknown): boolean {
  const message = messageOf(error).toLowerCase()
  return (
    message.includes("native update command") ||
    (message.includes("desktop_workspace_") &&
      (message.includes("not found") ||
        message.includes("unknown command") ||
        message.includes("not allowed") ||
        message.includes("denied") ||
        message.includes("forbidden")))
  )
}

function optionalString(value: unknown): value is string | null {
  return value === null || typeof value === "string"
}

function parseCheck(value: unknown): DesktopUpdateCheck | null {
  if (value === null) return null
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Desktop returned an invalid update check.")
  }
  const check = value as Record<string, unknown>
  if (
    typeof check.checkedAt !== "number" ||
    typeof check.outcome !== "string" ||
    !OUTCOMES.has(check.outcome) ||
    !optionalString(check.message)
  ) {
    throw new Error("Desktop returned an invalid update check.")
  }
  return {
    checkedAt: check.checkedAt,
    outcome: check.outcome as DesktopUpdateCheck["outcome"],
    message: check.message,
  }
}

export function parseDesktopUpdateStatus(value: unknown): DesktopUpdateStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Desktop returned an invalid update status.")
  }
  const status = value as Record<string, unknown>
  if (
    status.schemaVersion !== 1 ||
    typeof status.currentVersion !== "string" ||
    typeof status.state !== "string" ||
    !STATES.has(status.state as DesktopUpdateState) ||
    !optionalString(status.availableVersion) ||
    !optionalString(status.notes) ||
    typeof status.downloadedBytes !== "number" ||
    (status.totalBytes !== null && typeof status.totalBytes !== "number") ||
    typeof status.canRestart !== "boolean"
  ) {
    throw new Error("Desktop returned an invalid update status.")
  }
  return {
    currentVersion: status.currentVersion,
    state: status.state as DesktopUpdateState,
    availableVersion: status.availableVersion,
    notes: status.notes,
    downloadedBytes: status.downloadedBytes,
    totalBytes: status.totalBytes as number | null,
    canRestart: status.canRestart,
    lastCheck: parseCheck(status.lastCheck ?? null),
  }
}

/** Desktop's update status, or null when this page is not a Desktop workspace. */
export async function getDesktopUpdateStatus(): Promise<DesktopUpdateStatus | null> {
  const nativeInvoke = invoke()
  if (!nativeInvoke) return null
  try {
    return parseDesktopUpdateStatus(
      await nativeInvoke("desktop_workspace_update_status")
    )
  } catch (error) {
    if (unavailableError(error)) return null
    throw new Error(messageOf(error))
  }
}

/** Starts a background check; progress arrives through the status. */
export async function checkDesktopUpdates(): Promise<void> {
  const nativeInvoke = invoke()
  if (!nativeInvoke) throw new Error("Desktop updates are unavailable here.")
  await nativeInvoke("desktop_workspace_check_for_updates")
}

/** Installs the downloaded update and restarts Desktop. */
export async function restartDesktopToUpdate(): Promise<void> {
  const nativeInvoke = invoke()
  if (!nativeInvoke) throw new Error("Desktop updates are unavailable here.")
  await nativeInvoke("desktop_workspace_restart_to_update")
}

/** Whether a Desktop bridge may exist at all, without asking it. */
export function mayHaveDesktopUpdates(): boolean {
  return invoke() !== null
}
