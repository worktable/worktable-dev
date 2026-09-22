import { cloudLinkRequest, linkedCloudOrigin } from "./cloud-account.ts"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { rmSync } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { hostname } from "node:os"
import { z } from "zod"
import {
  HOSTED_OAUTH_SCOPES,
  LinkedHostReply,
} from "@worktable/hosted-contract"
import { ensureAppDir } from "./app-storage.ts"
import { getWorkspaceRoot, workspaceCacheKey } from "./workspace.ts"
import { getWorkspaceCollaborationEpoch } from "./collaboration-epoch.ts"
import { withCrossProcessLock } from "./cross-process-lock.ts"
import { createLinkedIngress } from "./linked-ingress.ts"
import { linkedConnectorBinary } from "./linked-connector.ts"
import { setLinkedSharing } from "./linked-sharing.ts"
import { invalidateAllDocumentShares } from "./share-store.ts"
import { isHosted } from "./hosted.ts"

const StoredLink = z
  .object({
    version: z.literal(1),
    cloudOrigin: z.string().url(),
    controlSecret: z.string().regex(/^[a-f0-9]{64}$/),
    workspaceEpoch: z.string(),
    label: z.string(),
    bootSequence: z.number().int().nonnegative(),
    disabled: z.boolean(),
  })
  .strict()
type StoredLink = z.infer<typeof StoredLink>
export type LinkedStatus = {
  state:
    | "unlinked"
    | "awaiting_approval"
    | "connecting"
    | "online"
    | "offline"
    | "locked"
    | "paused"
    | "revoked"
    | "unlinking"
    | "error"
  cloudOrigin: string
  enabled: boolean | null
  mcpUrl?: string
  label?: string
}
let status: LinkedStatus = {
  state: "connecting",
  enabled: null,
  cloudOrigin: "https://app.worktable.cloud",
}
let stopRuntime: (() => Promise<void>) | null = null
let actions: Promise<unknown> = Promise.resolve()
let running = false

function path() {
  return join(ensureAppDir(), "linked", `${workspaceCacheKey()}.json`)
}
async function readLink(file: string): Promise<StoredLink | null> {
  try {
    return StoredLink.parse(JSON.parse(await readFile(file, "utf8")))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}
async function saveLink(file: string, link: StoredLink) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(link), {
      mode: 0o600,
      flag: "wx",
    })
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}
const cloudOrigin = linkedCloudOrigin
export function linkedStatus(): LinkedStatus {
  return { ...status }
}

async function change<T>(operation: () => Promise<T>): Promise<T> {
  const next = actions
    .catch(() => undefined)
    .then(async () => {
      await stopRuntime?.()
      stopRuntime = null
      try {
        return await operation()
      } finally {
        if (running) launch()
      }
    })
  actions = next
  return next
}

async function prepareLink(): Promise<StoredLink> {
  const file = path()
  let link = await readLink(file)
  const epoch = await getWorkspaceCollaborationEpoch()
  if (link?.disabled)
    throw new Error("Unlinking is still in progress. Try again shortly.")
  if (link && link.workspaceEpoch !== epoch)
    throw new Error("Unlink this device before connecting its replacement.")
  if (!link) {
    link = {
      version: 1,
      cloudOrigin: cloudOrigin(),
      controlSecret: randomBytes(32).toString("hex"),
      workspaceEpoch: epoch,
      label: hostname().slice(0, 80) || "My device",
      bootSequence: 0,
      disabled: false,
    }
    await saveLink(file, link)
  }
  return link
}
function enrollment(link: StoredLink) {
  return {
    controlHash: createHash("sha256").update(link.controlSecret).digest("hex"),
    workspaceEpoch: link.workspaceEpoch,
    label: link.label,
  }
}

/** Released web clients can finish their explicit browser approval after an update. */
export async function beginLink(): Promise<{ url: string }> {
  return change(async () => {
    const link = await prepareLink()
    const response = await fetch(`${link.cloudOrigin}/linked/enroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(enrollment(link)),
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    })
    if (!response.ok) throw new Error("Could not start linking. Try again.")
    const data = z
      .object({ url: z.string().url() })
      .parse(await response.json())
    if (new URL(data.url).origin !== link.cloudOrigin)
      throw new Error("Invalid linking response")
    status = {
      state: "awaiting_approval",
      enabled: false,
      cloudOrigin: link.cloudOrigin,
      label: link.label,
    }
    return data
  })
}

async function enableLink(): Promise<LinkedStatus> {
  return change(async () => {
    const link = await prepareLink()
    const data = await cloudLinkRequest(link.cloudOrigin, {
      action: "enable",
      enrollment: enrollment(link),
    })
    const destinationId = z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .parse(data["destinationId"])
    if (data["state"] === "paused")
      await cloudLinkRequest(link.cloudOrigin, {
        action: "pause",
        enrollment: enrollment(link),
        paused: false,
      })
    status = {
      state: "connecting",
      enabled: true,
      cloudOrigin: link.cloudOrigin,
      label: link.label,
      mcpUrl: `${link.cloudOrigin}/api/mcp/d/${destinationId}`,
    }
    return linkedStatus()
  })
}

export async function setLinkEnabled(enabled: boolean): Promise<LinkedStatus> {
  if (enabled) return enableLink()
  return change(async () => {
    const link = await readLink(path())
    if (!link || link.disabled) throw new Error("This device is not linked.")
    const data = await cloudLinkRequest(link.cloudOrigin, {
      action: "pause",
      paused: true,
      enrollment: enrollment(link),
    })
    const destinationId = z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .parse(data["destinationId"])
    status = {
      state: "paused",
      enabled: false,
      cloudOrigin: link.cloudOrigin,
      label: link.label,
      mcpUrl: `${link.cloudOrigin}/api/mcp/d/${destinationId}`,
    }
    return linkedStatus()
  })
}

export async function disconnectLink(): Promise<void> {
  await change(async () => {
    const file = path()
    const link = await readLink(file)
    await invalidateAllDocumentShares()
    if (link) {
      await saveLink(file, { ...link, disabled: true })
      status = {
        state: "unlinking",
        enabled: false,
        cloudOrigin: link.cloudOrigin,
      }
    } else
      status = { state: "unlinked", enabled: false, cloudOrigin: cloudOrigin() }
  })
}

function launch(): void {
  if (isHosted()) return
  const file = path()
  const root = getWorkspaceRoot()
  const controller = new AbortController()
  let ingress: Awaited<ReturnType<typeof createLinkedIngress>> | null = null
  let listener: ReturnType<typeof Bun.serve> | null = null
  let connector: ReturnType<typeof Bun.spawn> | null = null
  let connected = false
  let metricsPort: number | null = null
  const stopping = new Set<Promise<void>>()
  const stoppingChildren = new Set<ReturnType<typeof Bun.spawn>>()
  const stoppingCredentials = new Set<string>()
  function stopConnector() {
    const child = connector
    const credentialFile = tokenFile
    tokenFile = null
    if (child) stoppingChildren.add(child)
    if (credentialFile) stoppingCredentials.add(credentialFile)
    connector = null
    connected = false
    metricsPort = null
    child?.kill()
    const timer = child
      ? setTimeout(() => child.kill("SIGKILL"), 3000)
      : undefined
    const stopped = (child?.exited ?? Promise.resolve())
      .then(async () => {
        if (credentialFile) await rm(credentialFile, { force: true })
      })
      .catch(() => {
        console.error("Could not remove a stopped connector credential")
      })
      .finally(() => {
        clearTimeout(timer)
        if (child) stoppingChildren.delete(child)
        if (credentialFile) stoppingCredentials.delete(credentialFile)
        stopping.delete(stopped)
      })
    stopping.add(stopped)
  }
  let tokenFile: string | null = null
  // Some CLI owners exit synchronously on signals. Never leave their connector behind.
  const onExit = () => {
    connector?.kill("SIGKILL")
    for (const child of stoppingChildren) child.kill("SIGKILL")
    for (const file of [
      ...stoppingCredentials,
      ...(tokenFile ? [tokenFile] : []),
    ]) {
      try {
        rmSync(file, { force: true })
      } catch {
        /* Normal async shutdown reports cleanup failures. */
      }
    }
  }
  process.once("exit", onExit)
  function fence() {
    ingress?.revoke()
    ingress = null
    listener?.stop(true)
    listener = null
    stopConnector()
    setLinkedSharing(null)
  }
  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      if (controller.signal.aborted) return resolve()
      const done = () => {
        clearTimeout(timer)
        controller.signal.removeEventListener("abort", done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      controller.signal.addEventListener("abort", done, { once: true })
    })
  const work = (async () => {
    const initial = await readLink(file)
    if (!initial) {
      status = { state: "unlinked", enabled: false, cloudOrigin: cloudOrigin() }
      return
    }
    await withCrossProcessLock(
      `${file}.runtime-lock`,
      { label: "linked installation host" },
      async () => {
        const link = (await readLink(file))!
        const signal = () =>
          AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)])
        const headers = {
          Authorization: `Bearer ${link.controlSecret}`,
          "Content-Type": "application/json",
        }
        if (
          !link.disabled &&
          link.workspaceEpoch !== (await getWorkspaceCollaborationEpoch())
        ) {
          link.disabled = true
        }
        link.bootSequence += 1
        await saveLink(file, link)
        let bootNonce = randomUUID()
        let renewBoot = false
        let port = 0
        while (!controller.signal.aborted && getWorkspaceRoot() === root) {
          try {
            if (link.disabled) {
              status = {
                state: "unlinking",
                enabled: false,
                cloudOrigin: link.cloudOrigin,
              }
              const response = await fetch(
                `${link.cloudOrigin}/linked/disconnect`,
                { method: "POST", headers, signal: signal(), redirect: "error" }
              )
              if (!response.ok) throw new Error("DISCONNECT_FAILED")
              await rm(file, { force: true })
              status = {
                state: "unlinked",
                enabled: false,
                cloudOrigin: link.cloudOrigin,
              }
              return
            }
            if (
              link.workspaceEpoch !== (await getWorkspaceCollaborationEpoch())
            ) {
              fence()
              link.disabled = true
              await saveLink(file, link)
              continue
            }
            if (!listener) {
              listener = Bun.serve({
                hostname: "127.0.0.1",
                port: 0,
                fetch: (request) =>
                  ingress
                    ? ingress.fetch(request)
                    : new Response(null, { status: 403 }),
              })
              port = listener.port!
            }
            connected = false
            if (connector && connector.exitCode === null && metricsPort) {
              try {
                const ready = await fetch(
                  `http://127.0.0.1:${metricsPort}/ready`,
                  {
                    signal: AbortSignal.any([
                      controller.signal,
                      AbortSignal.timeout(2000),
                    ]),
                    redirect: "error",
                  }
                )
                connected = ready.ok
                await ready.body?.cancel()
              } catch {
                /* A running connector may have lost its edge connections. */
              }
            }
            const response = await fetch(
              `${link.cloudOrigin}/linked/heartbeat`,
              {
                method: "POST",
                headers,
                body: JSON.stringify({
                  workspaceEpoch: link.workspaceEpoch,
                  bootSequence: link.bootSequence,
                  bootNonce,
                  port,
                  connected,
                }),
                signal: signal(),
                redirect: "error",
              }
            )
            if (!response.ok) throw new Error("HEARTBEAT_FAILED")
            const reply = LinkedHostReply.parse(await response.json())
            if (controller.signal.aborted) break
            if (reply.state === "revoked" || reply.state === "superseded") {
              fence()
              status = {
                state: "revoked",
                enabled: false,
                cloudOrigin: link.cloudOrigin,
              }
              return
            }
            if (reply.state === "locked" || reply.state === "paused") {
              // Recovery starts a fresh signed-request epoch, including replay memory.
              renewBoot = true
              ingress?.revoke()
              ingress = null
              stopConnector()
              setLinkedSharing(null)
              status = {
                ...status,
                state: reply.state,
                enabled: reply.state !== "paused" && !reply.paused,
                cloudOrigin: link.cloudOrigin,
                ...(reply.destinationId
                  ? {
                      mcpUrl: `${link.cloudOrigin}/api/mcp/d/${reply.destinationId}`,
                    }
                  : {}),
                label: link.label,
              }
            } else if (reply.state === "pending") {
              status = {
                state: "awaiting_approval",
                enabled: false,
                cloudOrigin: link.cloudOrigin,
                label: link.label,
              }
            } else {
              if (ingress && ingress.binding.generation !== reply.generation) {
                ingress.revoke()
                ingress = null
                stopConnector()
                setLinkedSharing(null)
                renewBoot = true
              }
              if (renewBoot) {
                link.bootSequence += 1
                bootNonce = randomUUID()
                await saveLink(file, link)
                renewBoot = false
                continue
              }
              if (
                !reply.installationId ||
                !reply.destinationId ||
                !reply.ownerSubject ||
                !reply.generation ||
                !reply.signingKey
              )
                throw new Error("INVALID_BINDING")
              const mcpUrl = `${link.cloudOrigin}/api/mcp/d/${reply.destinationId}`
              if (!ingress)
                ingress = await createLinkedIngress({
                  binding: {
                    installationId: reply.installationId,
                    destinationId: reply.destinationId,
                    ownerSubject: reply.ownerSubject,
                    generation: reply.generation,
                  },
                  key: Buffer.from(reply.signingKey, "hex"),
                  scopes: HOSTED_OAUTH_SCOPES,
                  publicOrigin: reply.publicOrigin,
                  bootNonce,
                })
              ingress.setSharingOrigin(
                reply.sharingEnabled ? reply.shareOrigin : null
              )
              if (
                reply.tunnelToken &&
                (!connector || connector.exitCode !== null)
              ) {
                const binary = await linkedConnectorBinary(controller.signal)
                if (controller.signal.aborted) break
                tokenFile = `${file}.${bootNonce}.tunnel-token`
                await writeFile(tokenFile, reply.tunnelToken, { mode: 0o600 })
                connected = false
                connector = Bun.spawn(
                  [
                    binary,
                    "tunnel",
                    "--no-autoupdate",
                    "--loglevel",
                    "info",
                    "--metrics",
                    "127.0.0.1:0",
                    "run",
                    "--token-file",
                    tokenFile,
                  ],
                  { stdout: "ignore", stderr: "pipe" }
                )
                const child = connector
                void (async () => {
                  if (!child.stderr || typeof child.stderr === "number") return
                  const reader = child.stderr.getReader()
                  const decoder = new TextDecoder()
                  let tail = ""
                  try {
                    for (;;) {
                      const chunk = await reader.read()
                      if (chunk.done) break
                      tail = (
                        tail + decoder.decode(chunk.value, { stream: true })
                      ).slice(-8192)
                      const metrics =
                        /Starting metrics server on 127\.0\.0\.1:(\d+)\/metrics/.exec(
                          tail
                        )
                      if (metrics && connector === child)
                        metricsPort = Number(metrics[1])
                    }
                  } finally {
                    reader.releaseLock()
                    if (connector === child) connected = false
                  }
                })().catch(() => {
                  if (connector === child) connected = false
                })
              }
              status = {
                state: connected && reply.ready ? "online" : "connecting",
                enabled: true,
                cloudOrigin: link.cloudOrigin,
                mcpUrl,
                label: link.label,
              }
              setLinkedSharing(
                reply.sharingEnabled
                  ? {
                      workspaceId: `d-${reply.destinationId}`,
                      shareOrigin: reply.shareOrigin,
                      htmlShareOrigin: reply.htmlShareOrigin,
                    }
                  : null
              )
            }
          } catch {
            if (!controller.signal.aborted)
              status = {
                ...status,
                state: link.disabled ? "unlinking" : "offline",
                cloudOrigin: link.cloudOrigin,
              }
          }
          await wait(connected ? 20_000 : 5_000)
        }
      }
    )
  })()
    .catch(() => {
      status = { ...status, state: "error" }
    })
    .finally(async () => {
      fence()
      await Promise.allSettled(stopping)
      process.removeListener("exit", onExit)
      if (tokenFile) await rm(tokenFile, { force: true })
    })
  stopRuntime = async () => {
    controller.abort()
    fence()
    await work
  }
}

/** The server owns this lifecycle, including when Desktop owns the server process. */
export function startLinkedRuntime(): () => Promise<void> {
  status = { state: "connecting", enabled: null, cloudOrigin: cloudOrigin() }
  running = true
  launch()
  return async () => {
    running = false
    await actions.catch(() => undefined)
    await stopRuntime?.()
    stopRuntime = null
  }
}
