import { randomBytes } from "node:crypto"
import { hostname } from "node:os"
import { join } from "node:path"
import { mutateConfigFile } from "openclaw/plugin-sdk/config-mutation"
import { withFileLock } from "openclaw/plugin-sdk/file-lock"
import {
  readJsonFileWithFallback,
  writeJsonFileAtomically,
} from "openclaw/plugin-sdk/json-store"
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths"
import {
  beginServiceAuthRegistration,
  completeServiceAuthRegistration,
  discoverAgentAuth,
  WorktableAgentCredentialProvider,
} from "./agent-auth.js"
import {
  loadAgentCredential,
  promotePendingAgentAuth,
  saveAgentCredential,
  stagePendingAgentAuth,
} from "./agent-auth-config.js"
import { McpWorktableClient } from "./worktable-client.js"

interface RedeemResult {
  mcpUrl: string
  token: string
  scopes: string[]
  workspaceName: string
  participantName?: string
  defaultSpaceId?: string
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
  env: NodeJS.ProcessEnv = process.env
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

function worktableOrigin(server: string): string {
  const url = new URL(server)
  url.pathname = ""
  url.search = ""
  url.hash = ""
  return url.toString().replace(/\/$/, "")
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

export async function pairWorktableChannel(options: {
  server: string
  pairingCode: string
}): Promise<{ workspaceName: string; participantName?: string }> {
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

  try {
    await mutateConfigFile({
      mutate: (draft) => {
        const channels = (draft.channels ?? {}) as Record<string, unknown>
        channels.worktable = {
          enabled: true,
          server: origin,
          token: redeemed.token,
          participantName: redeemed.participantName,
          ...(redeemed.defaultSpaceId
            ? { defaultSpaceId: redeemed.defaultSpaceId }
            : {}),
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
  }
}

export async function registerWorktableAgent(options: {
  server: string
  email: string
  participantName: string
  readUserCode(verificationUri: string): Promise<string>
}): Promise<{ participantName: string }> {
  const participantName = options.participantName.trim()
  if (!participantName) {
    throw new Error("The Worktable participant name is required")
  }
  if (participantName.length > 120) {
    throw new Error(
      "The Worktable participant name must be 120 characters or fewer"
    )
  }
  const origin = worktableOrigin(options.server)
  const discovery = await discoverAgentAuth(origin)
  const registration = await beginServiceAuthRegistration(
    discovery,
    options.email.trim()
  )
  const userCode = (
    await options.readUserCode(registration.verificationUri)
  ).trim()
  if (!userCode) {
    throw new Error("The Agent Registration claim code is required")
  }
  const credential = await completeServiceAuthRegistration(
    discovery,
    registration,
    userCode
  )

  // The claim response is delivered exactly once. Stage it durably before any
  // token exchange or MCP verification that can fail independently.
  await stagePendingAgentAuth({
    server: origin,
    participantName,
    credential,
  })

  const provider = new WorktableAgentCredentialProvider({
    credential,
    load: () => loadAgentCredential(credential.registrationId),
    save: (next) => saveAgentCredential(credential.registrationId, next),
  })
  const client = new McpWorktableClient(origin, {
    provider,
    adapter: "openclaw",
    installationId: credential.registrationId,
    label: `OpenClaw · ${participantName}`,
    machine: hostname(),
  })
  try {
    const participant = await client.registerParticipant(participantName)
    await promotePendingAgentAuth(credential.registrationId)
    return { participantName: participant.name }
  } finally {
    await client.close()
  }
}
