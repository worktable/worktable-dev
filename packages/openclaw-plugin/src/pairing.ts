import { randomBytes } from "node:crypto"
import { hostname } from "node:os"
import { join } from "node:path"
import { mutateConfigFile } from "openclaw/plugin-sdk/config-mutation"
import { withFileLock } from "openclaw/plugin-sdk/file-lock"
import { writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store"
import { readJsonFileWithFallback } from "./json-store.js"
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths"
import { accessSettingsToKeep, type WorktableAccess } from "./access.js"

interface RedeemResult {
  mcpUrl: string
  token: string
  scopes: string[]
  workspaceName: string
  participantName?: string
  defaultSpaceId?: string
  /** The thread member who approved this connection. */
  ownerMemberId?: string
}

/** What a finished pairing saved, for the command to report. */
export interface PairedWorktable {
  workspaceName: string
  participantName?: string
  /**
   * Who the connection takes direction from. No owner means Worktable did not
   * name one, and the connection refuses every thread message.
   */
  access: Partial<WorktableAccess>
}

interface InstallationIdentityFile {
  type: "worktable.openclaw-installation"
  version: 1
  id: string
  createdAt: string
}

const INSTALLATION_ID = /^oci_[A-Za-z0-9_-]{24}$/
const INSTALLATION_LOCK_OPTIONS = {
  retries: {
    retries: 20,
    factor: 1.4,
    minTimeout: 10,
    maxTimeout: 250,
    randomize: true,
  },
  stale: 30_000,
}

function parseInstallationIdentity(
  value: unknown
): InstallationIdentityFile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const identity = value as Record<string, unknown>
  if (
    identity.type !== "worktable.openclaw-installation" ||
    identity.version !== 1 ||
    typeof identity.id !== "string" ||
    !INSTALLATION_ID.test(identity.id) ||
    typeof identity.createdAt !== "string" ||
    !Number.isFinite(Date.parse(identity.createdAt))
  ) {
    return null
  }
  return identity as unknown as InstallationIdentityFile
}

export async function ensureOpenClawInstallationId(
  env?: NodeJS.ProcessEnv
): Promise<string> {
  const filePath = join(
    resolveStateDir(env),
    "plugins",
    "worktable",
    "installation.json"
  )
  return withFileLock(filePath, INSTALLATION_LOCK_OPTIONS, async () => {
    const loaded = await readJsonFileWithFallback<unknown>(filePath, null)
    if (loaded.exists) {
      const existing = parseInstallationIdentity(loaded.value)
      if (!existing) {
        throw Object.assign(
          new Error("Invalid Worktable OpenClaw installation identity"),
          { code: "INSTALLATION_ID_UNAVAILABLE" }
        )
      }
      return existing.id
    }
    const identity: InstallationIdentityFile = {
      type: "worktable.openclaw-installation",
      version: 1,
      id: `oci_${randomBytes(18).toString("base64url")}`,
      createdAt: new Date().toISOString(),
    }
    await writeJsonFileAtomically(filePath, identity)
    return identity.id
  })
}

/**
 * The Worktable address agents use, path included: Worktable Cloud gives each
 * workspace an agent address such as `https://app.worktable.cloud/w/<id>`.
 */
function worktableOrigin(server: string): string {
  const url = new URL(server)
  url.search = ""
  url.hash = ""
  return url.toString().replace(/\/+$/, "")
}

async function jsonRequest<T>(
  url: string,
  body: Record<string, unknown>,
  token?: string
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  const result = (await response.json().catch(() => ({}))) as {
    error?: string
    code?: string
  }
  if (!response.ok) {
    throw Object.assign(
      new Error(result.error ?? `Worktable returned HTTP ${response.status}`),
      {
        code: result.code ?? `HTTP_${response.status}`,
        status: response.status,
      }
    )
  }
  return result as T
}

function retryablePairingError(error: unknown): boolean {
  if (!error || typeof error !== "object") return true
  if ("status" in error && typeof error.status === "number") {
    return error.status >= 500
  }
  return true
}

/** Consecutive failed checks tolerated when a request has no expiry. */
const MAX_WAIT_FAILURES = 30

function isRateLimited(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "status" in error &&
    error.status === 429
  )
}

function retryableWaitError(error: unknown): boolean {
  return isRateLimited(error) || retryablePairingError(error)
}

export async function completePairingWithRetry(
  origin: string,
  code: string,
  token: string,
  options: { attempts?: number; delayMs?: number } = {}
): Promise<void> {
  const attempts = Math.max(1, options.attempts ?? 3)
  const delayMs = Math.max(0, options.delayMs ?? 250)
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await jsonRequest(`${origin}/api/pairing/complete`, { code }, token)
      return
    } catch (error) {
      lastError = error
      if (!retryablePairingError(error) || attempt === attempts) throw error
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt))
    }
  }
  throw lastError
}

async function clearPendingPairing(input: {
  origin: string
  token: string
  pairingCode: string
}): Promise<void> {
  await mutateConfigFile({
    mutate: (draft) => {
      const channels = (draft.channels ?? {}) as Record<string, unknown>
      const section = channels.worktable as Record<string, unknown> | undefined
      if (
        section?.server !== input.origin ||
        section.token !== input.token ||
        section.pendingPairingCode !== input.pairingCode
      ) {
        return
      }
      const completed = { ...section }
      delete completed.pendingPairingCode
      channels.worktable = completed
      draft.channels = channels as typeof draft.channels
    },
  })
}

export async function resumePendingPairingCompletion(
  input: {
    origin: string
    pairingCode: string
    token: string
  },
  options: {
    attempts?: number
    delayMs?: number
    clearPending?: () => Promise<void>
  } = {}
): Promise<void> {
  await completePairingWithRetry(
    input.origin,
    input.pairingCode,
    input.token,
    options
  )
  await (options.clearPending?.() ?? clearPendingPairing(input))
}

async function reportFailure(
  origin: string,
  code: string,
  detail: string
): Promise<void> {
  await jsonRequest(`${origin}/api/pairing/progress`, {
    code,
    event: "failed_no_config",
    detail,
  }).catch(() => undefined)
}

interface ConnectionRequestCreated {
  code: string
  pollToken: string
  approvalUrl: string
  expiresAt: string
  interval?: number
}

const CLOUD_HOST = "app.worktable.cloud"
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"])

function hostOf(url: URL): string {
  const host = url.hostname.toLowerCase()
  return LOOPBACK.has(host) ? "loopback" : host
}

/**
 * An address Worktable answered with, accepted only on the host the user gave
 * or on Worktable Cloud, and never a plain-HTTP address for an HTTPS one. The
 * pairing code, the token and every later request go there.
 */
export function knownWorktableAddress(given: string, answered: string): string {
  const asked = new URL(given)
  let answer: URL
  try {
    answer = new URL(answered)
  } catch {
    throw Object.assign(
      new Error(
        `Worktable at ${asked.host} answered with an address OpenClaw can't read.`
      ),
      { code: "ADDRESS_MISMATCH" }
    )
  }
  const downgraded = asked.protocol === "https:" && answer.protocol !== "https:"
  const sameHost = hostOf(answer) === hostOf(asked) && !downgraded
  const cloud =
    answer.protocol === "https:" && answer.hostname.toLowerCase() === CLOUD_HOST
  if (["http:", "https:"].includes(answer.protocol) && (sameHost || cloud)) {
    return answered
  }
  throw Object.assign(
    new Error(
      `Worktable at ${asked.host} answered with an address somewhere else: ${answer.origin}. If that is your Worktable, run connect with that address.`
    ),
    { code: "ADDRESS_MISMATCH" }
  )
}

type ConnectionRequestPoll =
  | { status: "pending" | "denied" | "expired" }
  /** On Worktable Cloud, `server` is the workspace the owner approved into. */
  | { status: "approved"; code: string; server?: string }

/**
 * Ask Worktable to connect this installation and wait for its owner to
 * approve it, then pair with the code Worktable hands back.
 */
export async function requestWorktablePairing(options: {
  server: string
  participantName?: string
  onApprovalNeeded(request: { code: string; approvalUrl: string }): void
  sleep?: (ms: number) => Promise<void>
}): Promise<PairedWorktable> {
  const origin = worktableOrigin(options.server)
  const installationId = await ensureOpenClawInstallationId()
  const request = await jsonRequest<ConnectionRequestCreated>(
    `${origin}/api/pairing/requests`,
    {
      target: { kind: "agent-adapter", adapter: "openclaw", installationId },
      hostname: hostname(),
      ...(options.participantName ? { name: options.participantName } : {}),
    }
  )
  options.onApprovalNeeded({
    code: request.code,
    approvalUrl: request.approvalUrl,
  })
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const interval = Math.max(1, request.interval ?? 2) * 1000
  // Whatever it answers, a request is over when it expires.
  const deadline = Date.parse(request.expiresAt)
  let failures = 0
  for (;;) {
    await sleep(interval)
    let poll: ConnectionRequestPoll
    try {
      poll = await jsonRequest<ConnectionRequestPoll>(
        `${origin}/api/pairing/requests/poll`,
        { pollToken: request.pollToken }
      )
      failures = 0
    } catch (error) {
      // A dropped connection, a restarting Worktable, or a busy one does not
      // end the wait for approval; anything else does.
      failures += 1
      const expired = Number.isFinite(deadline)
        ? Date.now() >= deadline
        : failures > MAX_WAIT_FAILURES
      if (!retryableWaitError(error) || expired) throw error
      if (isRateLimited(error)) await sleep(Math.max(interval, 10_000))
      continue
    }
    if (poll.status === "approved") {
      return pairWorktableChannel({
        server: poll.server
          ? knownWorktableAddress(origin, poll.server)
          : origin,
        pairingCode: poll.code,
      })
    }
    if (poll.status === "denied") {
      throw new Error("The Worktable owner declined this connection.")
    }
    if (poll.status === "expired" || Date.now() >= deadline) {
      throw new Error(
        "The connection request expired. Run the connect command again."
      )
    }
  }
}

export async function pairWorktableChannel(options: {
  server: string
  pairingCode: string
}): Promise<PairedWorktable> {
  const origin = worktableOrigin(options.server)
  const installationId = await ensureOpenClawInstallationId()
  const redeemed = await jsonRequest<RedeemResult>(
    `${origin}/api/pairing/redeem`,
    {
      code: options.pairingCode,
      hostname: hostname(),
      installationId,
    }
  )

  let access: Partial<WorktableAccess> = {}
  try {
    await mutateConfigFile({
      mutate: (draft) => {
        const channels = (draft.channels ?? {}) as Record<string, unknown>
        // The person who approved is the one this OpenClaw takes direction
        // from. What that person chose to trust stays only while both the
        // Worktable and the approver are the same.
        access = accessSettingsToKeep(
          channels.worktable as Record<string, unknown> | undefined,
          { server: origin, ownerMemberId: redeemed.ownerMemberId }
        )
        channels.worktable = {
          enabled: true,
          server: origin,
          token: redeemed.token,
          participantName: redeemed.participantName,
          ...(redeemed.defaultSpaceId
            ? { defaultSpaceId: redeemed.defaultSpaceId }
            : {}),
          ...access,
          pendingPairingCode: options.pairingCode,
        }
        draft.channels = channels as typeof draft.channels
      },
    })
  } catch (error) {
    await reportFailure(
      origin,
      options.pairingCode,
      "OpenClaw could not save the Worktable channel configuration."
    )
    throw error
  }

  // Progress is informative only. Configuration is already durable at this
  // point, so a dropped progress request must not be misreported as a
  // zero-write failure (which would revoke a working credential).
  await jsonRequest(`${origin}/api/pairing/progress`, {
    code: options.pairingCode,
    event: "config_written",
    detail: "Worktable channel configuration saved.",
  }).catch(() => undefined)
  await jsonRequest(`${origin}/api/pairing/progress`, {
    code: options.pairingCode,
    event: "verifying",
    detail: "Waiting for the OpenClaw Gateway to verify the channel.",
  }).catch(() => undefined)

  return {
    workspaceName: redeemed.workspaceName,
    participantName: redeemed.participantName,
    access,
  }
}
