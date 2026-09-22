import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { z } from "zod"
import { ensureAppDir } from "./app-storage.ts"
import { resolveWorkspaceOriginForRequest } from "./workspace-origin.ts"
import { workspaceCacheKey } from "./workspace.ts"
import { getWorkspaceCollaborationEpoch } from "./collaboration-epoch.ts"
import { withCrossProcessLock } from "./cross-process-lock.ts"

const User = z.object({
  id: z.string().min(1),
  email: z.string().optional(),
  name: z.string().nullable().optional(),
})
const Tokens = z.object({
  accessToken: z.string().optional(),
  refreshToken: z.string().min(1),
  accessTokenExpiresAt: z.string().optional(),
  user: User,
})
const Account = Tokens.extend({
  cloudOrigin: z.string().url(),
  workspaceEpoch: z.string(),
})
type Account = z.infer<typeof Account>
type Pending = {
  state: string
  codeVerifier: string
  expiresAt: number
  cloudOrigin: string
  workspaceEpoch: string
  callbackOrigin: string
  file: string
}
let pending: Pending | null = null
let attempt = 0
let signInError: string | undefined

export function linkedCloudOrigin() {
  const value =
    process.env["WORKTABLE_LINKED_CLOUD_ORIGIN"] ??
    "https://app.worktable.cloud"
  const url = new URL(value)
  if (url.protocol !== "https:" || url.origin !== value)
    throw new Error("INVALID_CLOUD_ORIGIN")
  return value
}
const accountPath = () =>
  join(ensureAppDir(), "linked", `${workspaceCacheKey()}.account.json`)
async function read(file: string): Promise<Account | null> {
  try {
    return Account.parse(JSON.parse(await readFile(file, "utf8")))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}
async function save(file: string, account: Account) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(account), {
      flag: "wx",
      mode: 0o600,
    })
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}
async function request(
  origin: string,
  path: string,
  body: unknown,
  token?: string
) {
  return fetch(`${origin}/gateway/local/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  })
}
export async function cloudAccountStatus() {
  const file = accountPath()
  let account = await read(file)
  const epoch = await getWorkspaceCollaborationEpoch()
  if (
    account?.cloudOrigin === linkedCloudOrigin() &&
    account.workspaceEpoch === epoch &&
    !account.accessToken
  ) {
    const recoveringAttempt = attempt
    account = await withCrossProcessLock(
      `${file}.lock`,
      { label: "Cloud account" },
      async () => {
        // Re-read under the same lock used by sign-out and token rotation.
        const current = await read(file)
        if (
          !current ||
          current.accessToken ||
          current.cloudOrigin !== linkedCloudOrigin() ||
          current.workspaceEpoch !== epoch
        )
          return current
        try {
          const recovered = await refresh(file)
          if (attempt === recoveringAttempt) signInError = undefined
          return recovered
        } catch {
          // Keep the continuation available for the next Settings poll; a
          // definitive provider rejection has already removed the account.
          return read(file)
        }
      }
    )
  }
  const user =
    account?.cloudOrigin === linkedCloudOrigin() &&
    account.workspaceEpoch === epoch &&
    account.accessToken
      ? account.user
      : null
  return {
    user,
    signingIn:
      !!pending &&
      pending.file === accountPath() &&
      pending.workspaceEpoch === epoch &&
      pending.expiresAt > Date.now(),
    ...(signInError ? { error: signInError } : {}),
  }
}
export async function startCloudSignIn(callbackOrigin: string) {
  const origin = new URL(callbackOrigin)
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.origin !== callbackOrigin
  )
    throw new Error("Invalid return address")
  pending = null
  const startedAttempt = ++attempt
  signInError = undefined
  const cloudOrigin = linkedCloudOrigin()
  const file = accountPath()
  const workspaceEpoch = await getWorkspaceCollaborationEpoch()
  const response = await request(cloudOrigin, "auth/start", {
    redirectUri: `${callbackOrigin}/api/linked/account/callback`,
  })
  if (!response.ok) throw new Error("Could not start Cloud sign-in. Try again.")
  const started = z
    .object({
      authorizationUrl: z.string().url(),
      state: z.string().min(1),
      codeVerifier: z.string().min(43).max(128),
      expiresAt: z.number(),
    })
    .parse(await response.json())
  const authUrl = new URL(started.authorizationUrl)
  if (
    authUrl.origin !== "https://api.workos.com" ||
    authUrl.pathname !== "/user_management/authorize" ||
    authUrl.searchParams.get("state") !== started.state ||
    authUrl.searchParams.get("code_challenge_method") !== "S256"
  )
    throw new Error("Invalid sign-in response")
  if (attempt !== startedAttempt) throw new Error("Sign-in cancelled")
  pending = { ...started, cloudOrigin, workspaceEpoch, callbackOrigin, file }
  return { url: started.authorizationUrl }
}

/** State + PKCE authenticate this one-use callback, including a Desktop system browser without local cookies. */
export async function completeCloudSignIn(
  input: URL | Request
): Promise<boolean> {
  const url = input instanceof URL ? input : new URL(input.url)
  const effectiveOrigin =
    input instanceof URL
      ? url.origin
      : resolveWorkspaceOriginForRequest(input).origin
  const current = pending
  const completingAttempt = attempt
  if (
    !current ||
    url.searchParams.get("state") !== current.state ||
    current.expiresAt <= Date.now() ||
    (url.origin !== current.callbackOrigin &&
      effectiveOrigin !== current.callbackOrigin) ||
    current.file !== accountPath()
  )
    return false
  pending = null
  if (current.workspaceEpoch !== (await getWorkspaceCollaborationEpoch()))
    return false
  try {
    const code = url.searchParams.get("code")
    if (!code || code.length > 4096 || url.searchParams.has("error"))
      throw new Error("Sign-in cancelled. Try again from Settings.")
    await withCrossProcessLock(
      `${current.file}.lock`,
      { label: "Cloud account" },
      async () => {
        const response = await request(current.cloudOrigin, "auth/exchange", {
          state: current.state,
          code,
          codeVerifier: current.codeVerifier,
        })
        const body = (await response.json()) as Record<string, unknown>
        if (attempt !== completingAttempt) throw new Error("Sign-in cancelled")
        if (!response.ok) {
          // Code redemption can succeed before verification recovers. Retain only
          // the rotating refresh credential so another exchange is never needed.
          if (
            response.status === 503 &&
            typeof body["refreshToken"] === "string" &&
            typeof body["expectedUserId"] === "string"
          ) {
            await save(current.file, {
              cloudOrigin: current.cloudOrigin,
              workspaceEpoch: current.workspaceEpoch,
              refreshToken: body["refreshToken"],
              user: { id: body["expectedUserId"] },
            })
            await refresh(current.file)
            return
          }
          throw new Error("Could not sign in. Try again from Settings.")
        }
        await save(current.file, {
          ...Tokens.parse(body),
          cloudOrigin: current.cloudOrigin,
          workspaceEpoch: current.workspaceEpoch,
        })
      }
    )
    signInError = undefined
    return true
  } catch (error) {
    signInError =
      error instanceof Error
        ? error.message
        : "Could not sign in. Try again from Settings."
    return false
  }
}

/** Caller holds the account lock; rotated refresh tokens are saved even on a verification outage. */
async function refresh(file: string): Promise<Account> {
  const account = await read(file)
  if (
    !account ||
    account.cloudOrigin !== linkedCloudOrigin() ||
    account.workspaceEpoch !== (await getWorkspaceCollaborationEpoch())
  )
    throw new Error("Sign in to Worktable Cloud.")
  if (
    account.accessToken &&
    Date.parse(account.accessTokenExpiresAt ?? "") > Date.now() + 30_000
  )
    return account
  const response = await request(account.cloudOrigin, "auth/refresh", {
    refreshToken: account.refreshToken,
    expectedUserId: account.user.id,
  })
  const body = (await response.json()) as Record<string, unknown>
  if (!response.ok) {
    if (response.status === 401) await rm(file, { force: true })
    else if (
      response.status === 503 &&
      typeof body["refreshToken"] === "string"
    )
      await save(file, { ...account, refreshToken: body["refreshToken"] })
    throw new Error(
      response.status === 401
        ? "Sign in to Worktable Cloud again."
        : "Cloud sign-in is unavailable. Try again."
    )
  }
  const updated = { ...account, ...Tokens.parse(body) }
  if (updated.user.id !== account.user.id)
    throw new Error("Cloud account changed. Sign in again.")
  await save(file, updated)
  return updated
}
export class CloudLinkError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.code = code
  }
}
export async function cloudLinkRequest(origin: string, body: unknown) {
  const file = accountPath()
  return withCrossProcessLock(
    `${file}.lock`,
    { label: "Cloud account" },
    async () => {
      const account = await refresh(file)
      if (account.cloudOrigin !== origin)
        throw new Error("Sign in to this Worktable Cloud account first.")
      const response = await request(origin, "link", body, account.accessToken)
      if (response.status === 401) await rm(file, { force: true })
      const data = (await response.json()) as Record<string, unknown>
      if (!response.ok) {
        const code = data["code"]
        const messages: Record<string, string> = {
          BILLING_REQUIRED: "A Worktable Cloud subscription is required.",
          BILLING_LOCKED:
            "Update your Worktable Cloud subscription to continue.",
          INSTALLATION_LIMIT: "Unlink a device in Cloud to connect this one.",
          LINK_ALREADY_USED:
            "Unlink this device before connecting another account.",
          LINKED_CAPACITY: "Worktable Link unavailable. Try again later.",
          SIGN_IN_REQUIRED: "Sign in to Worktable Cloud again.",
          AUTH_VERIFICATION_UNAVAILABLE:
            "Cloud sign-in is unavailable. Try again.",
        }
        throw new CloudLinkError(
          typeof code === "string" && messages[code]
            ? messages[code]
            : "Could not update Worktable Link. Try again.",
          typeof code === "string" ? code : "LINKED_UNAVAILABLE"
        )
      }
      return data
    }
  )
}
export async function signOutCloudAccount() {
  ++attempt
  pending = null
  signInError = undefined
  const file = accountPath()
  await withCrossProcessLock(`${file}.lock`, { label: "Cloud account" }, () =>
    rm(file, { force: true })
  )
}
