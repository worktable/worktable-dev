import {
  isSkillProjectionTargetId,
  SKILL_PROJECTION_TARGET_IDS,
  type SkillProjectionTargetId,
} from "@worktable/types"

export type DesktopAgentSkillOperation =
  | "install"
  | "update"
  | "repair"
  | "remove"

export type DesktopAgentSkillState =
  | "not-installed"
  | "current"
  | "outdated"
  | "missing"
  | "locally-modified"
  | "conflict"
  | "incomplete"

export interface DesktopAgentSkillStatus {
  targetId: SkillProjectionTargetId
  label: string
  state: DesktopAgentSkillState
  detail: string
  targetRoot: string
  resolvedTargetRoot: string
  sourcePackageDigest: string | null
  installedPackageDigest: string | null
  missingSkills: string[]
  modifiedSkills: string[]
  allowedOperations: DesktopAgentSkillOperation[]
}

export interface DesktopAgentSkillPreview {
  planId: string
  allowed: boolean
  action: string
  changes: string[]
  status: DesktopAgentSkillStatus
}

export interface DesktopAgentSkillResult {
  applied: boolean
  statusAfter: DesktopAgentSkillStatus
}

type NativeInvoke = (command: string, args?: unknown) => Promise<unknown>

interface DesktopGlobal {
  __TAURI__?: { core?: { invoke?: NativeInvoke } }
}

const SKILL_STATES = new Set<DesktopAgentSkillState>([
  "not-installed",
  "current",
  "outdated",
  "missing",
  "locally-modified",
  "conflict",
  "incomplete",
])

const SKILL_OPERATIONS = new Set<DesktopAgentSkillOperation>([
  "install",
  "update",
  "repair",
  "remove",
])

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Desktop returned an invalid agent skill contract.")
  }
  return value as Record<string, unknown>
}

function stringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string") &&
    new Set(value).size === value.length
  )
}

function parseStatus(value: unknown): DesktopAgentSkillStatus {
  const status = record(value)
  const targetId = status.targetId
  const state = status.state
  if (
    typeof targetId !== "string" ||
    !isSkillProjectionTargetId(targetId) ||
    typeof status.label !== "string" ||
    typeof state !== "string" ||
    !SKILL_STATES.has(state as DesktopAgentSkillState) ||
    typeof status.detail !== "string" ||
    typeof status.targetRoot !== "string" ||
    typeof status.resolvedTargetRoot !== "string" ||
    (status.sourcePackageDigest !== null &&
      typeof status.sourcePackageDigest !== "string") ||
    (status.installedPackageDigest !== null &&
      typeof status.installedPackageDigest !== "string") ||
    !stringArray(status.missingSkills) ||
    !stringArray(status.modifiedSkills) ||
    !Array.isArray(status.allowedOperations) ||
    !status.allowedOperations.every(
      (operation) =>
        typeof operation === "string" &&
        SKILL_OPERATIONS.has(operation as DesktopAgentSkillOperation)
    ) ||
    new Set(status.allowedOperations).size !== status.allowedOperations.length
  ) {
    throw new Error("Desktop returned an invalid agent skill status.")
  }
  return {
    targetId,
    label: status.label,
    state: state as DesktopAgentSkillState,
    detail: status.detail,
    targetRoot: status.targetRoot,
    resolvedTargetRoot: status.resolvedTargetRoot,
    sourcePackageDigest: status.sourcePackageDigest as string | null,
    installedPackageDigest: status.installedPackageDigest as string | null,
    missingSkills: status.missingSkills,
    modifiedSkills: status.modifiedSkills,
    allowedOperations: status.allowedOperations as DesktopAgentSkillOperation[],
  }
}

function invoke(): NativeInvoke | null {
  return (
    (globalThis as typeof globalThis & DesktopGlobal).__TAURI__?.core?.invoke ??
    null
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function unavailableStatusError(error: unknown): boolean {
  const message = messageOf(error).toLowerCase()
  return (
    message.includes("native agent skill command") ||
    (message.includes("desktop_agent_skills_status") &&
      (message.includes("not found") ||
        message.includes("unknown command") ||
        message.includes("not allowed") ||
        message.includes("denied") ||
        message.includes("forbidden")))
  )
}

export async function getDesktopAgentSkillStatuses(): Promise<
  DesktopAgentSkillStatus[] | null
> {
  const nativeInvoke = invoke()
  if (!nativeInvoke) return null
  let value: unknown
  try {
    value = await nativeInvoke("desktop_agent_skills_status")
  } catch (error) {
    if (unavailableStatusError(error)) return null
    throw new Error(messageOf(error))
  }
  const envelope = record(value)
  if (envelope.schemaVersion !== 2 || !Array.isArray(envelope.statuses)) {
    throw new Error("Desktop returned an invalid agent skill status contract.")
  }
  const statuses = envelope.statuses.map(parseStatus)
  if (
    statuses.length !== SKILL_PROJECTION_TARGET_IDS.length ||
    !SKILL_PROJECTION_TARGET_IDS.every(
      (targetId) =>
        statuses.filter((status) => status.targetId === targetId).length === 1
    )
  ) {
    throw new Error(
      "Desktop returned an incomplete agent skill status contract."
    )
  }
  return statuses
}

export async function previewDesktopAgentSkillOperation(
  targetId: SkillProjectionTargetId,
  operation: DesktopAgentSkillOperation
): Promise<DesktopAgentSkillPreview> {
  const nativeInvoke = invoke()
  if (!nativeInvoke) {
    throw new Error(
      "Agent skill controls are available only in Worktable Desktop."
    )
  }
  const envelope = record(
    await nativeInvoke("desktop_agent_skills_preview", { targetId, operation })
  )
  if (envelope.schemaVersion !== 2) {
    throw new Error("Desktop returned an invalid agent skill preview contract.")
  }
  const preview = record(envelope.preview)
  if (
    typeof preview.planId !== "string" ||
    !/^[a-f0-9]{64}$/.test(preview.planId) ||
    typeof preview.allowed !== "boolean" ||
    typeof preview.action !== "string" ||
    !stringArray(preview.changes)
  ) {
    throw new Error("Desktop returned an invalid agent skill preview.")
  }
  return {
    planId: preview.planId,
    allowed: preview.allowed,
    action: preview.action,
    changes: preview.changes,
    status: parseStatus(preview.status),
  }
}

export async function applyDesktopAgentSkillOperation(
  targetId: SkillProjectionTargetId,
  operation: DesktopAgentSkillOperation,
  planId: string
): Promise<DesktopAgentSkillResult> {
  if (!/^[a-f0-9]{64}$/.test(planId)) {
    throw new Error("Desktop agent skill plan id is invalid.")
  }
  const nativeInvoke = invoke()
  if (!nativeInvoke) {
    throw new Error(
      "Agent skill controls are available only in Worktable Desktop."
    )
  }
  const envelope = record(
    await nativeInvoke("desktop_agent_skills_apply", {
      targetId,
      operation,
      planId,
    })
  )
  if (envelope.schemaVersion !== 2) {
    throw new Error("Desktop returned an invalid agent skill result contract.")
  }
  const result = record(envelope.result)
  if (typeof result.applied !== "boolean") {
    throw new Error("Desktop returned an invalid agent skill result.")
  }
  return {
    applied: result.applied,
    statusAfter: parseStatus(result.statusAfter),
  }
}
