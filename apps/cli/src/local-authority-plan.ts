import { resolve } from "node:path"
import { bindHostFor, isLoopbackHost } from "./config.ts"
import type { ServiceStatus } from "./service.ts"

export interface ReachabilityOpts {
  reachable?: boolean
  bind?: boolean
  host?: string
}

export interface ResolvedReachability {
  reachable: boolean
  host: string
  needsAck: boolean
}

/**
 * Resolve the persisted network posture without touching local state.
 */
export function resolveReachability(
  opts: ReachabilityOpts,
  currentReachable: boolean,
  alreadyAcknowledged = false,
  currentHost = ""
): ResolvedReachability {
  const reachableFlag =
    opts.reachable === true || opts.bind === true
      ? true
      : opts.reachable === false
        ? false
        : undefined
  let reachable =
    reachableFlag ?? (opts.host ? !isLoopbackHost(opts.host) : currentReachable)
  const override = opts.host?.trim()
  const host = override
    ? override
    : reachable && currentHost && !isLoopbackHost(currentHost)
      ? currentHost
      : bindHostFor(reachable)
  reachable = reachable && !isLoopbackHost(host)
  const needsAck = !isLoopbackHost(host) && !alreadyAcknowledged
  return { reachable, host, needsAck }
}

export interface RuntimeEndpointProof {
  processAlive: boolean
  endpointVerified: boolean
  workspaceId: string
  workspacePath: string
  host: string
  port: number
}

export type RuntimeEndpointState = "verified" | "unreachable" | "rejected"

export type RuntimeReadinessDecision =
  | { action: "ready" }
  | { action: "retry"; reason: "pending" | "unreachable" }
  | {
      action: "reject"
      reason: "unproven-endpoint" | "proof-rejected" | "destination-conflict"
    }

export type ExactRuntimeReadinessFailure =
  | "absent"
  | "pending-deadline"
  | "unreachable-deadline"
  | "unproven-endpoint"
  | "proof-rejected"
  | "destination-conflict"
  | "owner-conflict"
  | "manager-conflict"

export function describeRuntimeReadinessFailure(
  reason: ExactRuntimeReadinessFailure,
  origin: string
): string {
  switch (reason) {
    case "absent":
      return `Worktable service stopped before publishing a local runtime lease at ${origin}.`
    case "pending-deadline":
      return `Worktable service did not become reachable at ${origin} before the readiness deadline.`
    case "unreachable-deadline":
      return `Worktable service at ${origin} did not complete its authenticated ownership proof before the readiness deadline.`
    case "unproven-endpoint":
      return `A Worktable endpoint answered at ${origin}, but it had no live local runtime lease.`
    case "proof-rejected":
      return `The endpoint at ${origin} rejected Worktable's authenticated local ownership proof.`
    case "destination-conflict":
      return `A running Worktable process published a different workspace or endpoint than ${origin}.`
    case "owner-conflict":
      return `The process at ${origin} is owned by a different Worktable launch mode.`
    case "manager-conflict":
      return `The process at ${origin} is not owned by the installed service manager.`
  }
}

export interface DesiredLocalAuthority {
  workspaceId?: string
  workspacePath: string
  host: string
  port: number
  background: boolean
  noLaunch: boolean
  changesDurableState: boolean
}

export type LocalAuthorityOperation =
  | "launch"
  | "setup"
  | "service-attach"
  | "restore"

export type LocalAuthorityLockState =
  | { state: "owned"; exactOwnership: true }
  | { state: "available"; exactOwnership: false }
  | { state: "foreign"; exactOwnership: false }

export type LocalAuthorityJournalState =
  | { state: "none" }
  | { state: "recoverable" }
  | { state: "blocked" }

export type LocalAuthorityServiceAction =
  | "install"
  | "uninstall"
  | "start"
  | "restart"
  | "none"
  | "unsupported"

export interface LocalAuthorityPlanInput {
  operation: LocalAuthorityOperation
  desired: DesiredLocalAuthority
  runtime: RuntimeEndpointProof | null | undefined
  service: Pick<
    ServiceStatus,
    "platform" | "state" | "installed" | "startsAtLogin"
  >
  lock: LocalAuthorityLockState
  journal: LocalAuthorityJournalState
}

export type LocalAuthorityPlan =
  | {
      action: "refuse"
      code:
        | "LOCK_NOT_OWNED"
        | "ACTIVATION_RECOVERY_REQUIRED"
        | "SERVICE_STATE_UNKNOWN"
      message: string
    }
  | {
      action: "proceed"
      endpointProven: boolean
      serviceAction: LocalAuthorityServiceAction
      restartRunningService: boolean
    }

export function runtimeProvesWorkspaceEndpoint(
  runtime: RuntimeEndpointProof | null | undefined,
  expected: {
    workspaceId?: string
    workspacePath: string
    host: string
    port: number
  }
): boolean {
  return Boolean(
    runtime?.processAlive &&
    runtime.endpointVerified &&
    runtimeMatchesWorkspaceEndpoint(runtime, expected)
  )
}

function runtimeMatchesWorkspaceEndpoint(
  runtime: RuntimeEndpointProof,
  expected: {
    workspaceId?: string
    workspacePath: string
    host: string
    port: number
  }
): boolean {
  return (
    (expected.workspaceId === undefined ||
      runtime.workspaceId === expected.workspaceId) &&
    resolve(runtime.workspacePath) === resolve(expected.workspacePath) &&
    runtime.host.toLowerCase() === expected.host.toLowerCase() &&
    runtime.port === expected.port
  )
}

export function classifyRuntimeReadiness(
  observation: {
    runtime: RuntimeEndpointProof | null
    endpointState: RuntimeEndpointState
    worktableWithoutLiveLease: boolean
  },
  expected: {
    workspaceId?: string
    workspacePath: string
    host: string
    port: number
  }
): RuntimeReadinessDecision {
  if (!observation.runtime?.processAlive) {
    return observation.worktableWithoutLiveLease
      ? { action: "reject", reason: "unproven-endpoint" }
      : { action: "retry", reason: "pending" }
  }
  if (!runtimeMatchesWorkspaceEndpoint(observation.runtime, expected)) {
    return { action: "reject", reason: "destination-conflict" }
  }
  if (observation.endpointState === "rejected") {
    return { action: "reject", reason: "proof-rejected" }
  }
  if (observation.endpointState === "unreachable") {
    return { action: "retry", reason: "unreachable" }
  }
  return { action: "ready" }
}

export function localHostServiceStartMode(
  service: Pick<ServiceStatus, "state">
): "start" | "restart" {
  return service.state === "running" ? "restart" : "start"
}

export function getSetupServiceAction(
  background: boolean,
  service: Pick<
    ServiceStatus,
    "platform" | "state" | "installed" | "startsAtLogin"
  >
): "install" | "uninstall" | "none" | "unsupported" {
  if (background) {
    return service.platform === "unsupported" ? "unsupported" : "install"
  }
  if (service.platform === "unsupported") return "none"
  return service.installed ||
    service.startsAtLogin ||
    service.state === "running"
    ? "uninstall"
    : "none"
}

export function shouldRestartServiceAfterSetup(
  background: boolean,
  noLaunch: boolean,
  service: Pick<ServiceStatus, "state">
): boolean {
  return background && !noLaunch && service.state === "running"
}

export function unknownServiceReconfigureRefusal(
  service: Pick<ServiceStatus, "installed" | "state">,
  changesDurableState: boolean
): string | null {
  if (service.installed && service.state === "unknown" && changesDurableState) {
    return "Can't reconfigure the background service from here: its state is unknown because the service manager (systemctl --user) isn't reachable in this session. Re-run from a full login session (or run `worktable service restart` there)."
  }
  return null
}

/**
 * One production decision seam for local-authority transitions. Callers gather
 * proofs and own side effects; this function decides whether a transition is
 * safe and which service action is required.
 */
export function planLocalAuthority(
  input: LocalAuthorityPlanInput
): LocalAuthorityPlan {
  if (input.lock.state !== "owned" || !input.lock.exactOwnership) {
    return {
      action: "refuse",
      code: "LOCK_NOT_OWNED",
      message:
        "The local authority lock is not owned by this operation. Retry after the current Worktable operation finishes.",
    }
  }
  if (input.journal.state !== "none") {
    return {
      action: "refuse",
      code: "ACTIVATION_RECOVERY_REQUIRED",
      message:
        "A previous local workspace activation did not finish. Run `worktable local-host recover --json` before changing local state.",
    }
  }
  const unknownRefusal = unknownServiceReconfigureRefusal(
    input.service,
    input.desired.changesDurableState
  )
  if (unknownRefusal) {
    return {
      action: "refuse",
      code: "SERVICE_STATE_UNKNOWN",
      message: unknownRefusal,
    }
  }

  const endpointProven = runtimeProvesWorkspaceEndpoint(
    input.runtime,
    input.desired
  )
  const serviceAction: LocalAuthorityServiceAction =
    input.operation === "setup"
      ? getSetupServiceAction(input.desired.background, input.service)
      : input.operation === "service-attach" || input.operation === "restore"
        ? localHostServiceStartMode(input.service)
        : input.desired.background
          ? input.service.installed
            ? "restart"
            : input.service.platform === "unsupported"
              ? "unsupported"
              : "install"
          : "none"

  return {
    action: "proceed",
    endpointProven,
    serviceAction,
    restartRunningService: shouldRestartServiceAfterSetup(
      input.desired.background,
      input.desired.noLaunch,
      input.service
    ),
  }
}
