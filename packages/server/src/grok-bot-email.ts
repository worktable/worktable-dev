import {
  ENV,
  GROK_EMAIL_WAKE_PATH,
  grokEmailConnectionKey,
  grokEmailSender,
  type GrokEmailWake,
} from "@worktable/hosted-contract"
import { isHosted } from "./hosted.ts"
import { linkedStatus, sendLinkedGrokEmailWake } from "./linked-runtime.ts"
import type { StoredGrokBot } from "./grok-bot-store.ts"

export function grokBotMcpResource(): string | undefined {
  return isHosted() ? process.env[ENV.RESOURCE_URL] : linkedStatus().mcpUrl
}

export async function grokBotEmailSender(
  principalId: string
): Promise<string | undefined> {
  const resource = grokBotMcpResource()
  return resource
    ? grokEmailSender(resource, await grokEmailConnectionKey(principalId))
    : undefined
}

export async function sendGrokEmailWake(
  connection: StoredGrokBot,
  wake: { id: string; attempts: number },
  options: { fetch: typeof fetch; signal: AbortSignal }
): Promise<Response> {
  const body: GrokEmailWake = {
    emailAddress: connection.emailAddress!,
    connectionKey: await grokEmailConnectionKey(connection.principalId),
    wakeId: wake.id,
    attempt: wake.attempts,
  }
  if (!isHosted()) return sendLinkedGrokEmailWake(body, options)
  const endpoint = process.env[ENV.INVITATION_MAIL_URL]
  const runtimeId = process.env[ENV.INVITATION_MAIL_RUNTIME_ID]
  const secret = process.env[ENV.GATEWAY_SECRET]
  if (!endpoint || !runtimeId || !secret)
    return new Response(null, { status: 503 })
  const url = new URL(GROK_EMAIL_WAKE_PATH, endpoint)
  if (url.protocol !== "https:" || url.username || url.password)
    return new Response(null, { status: 503 })
  return options.fetch(url.href, {
    method: "POST",
    redirect: "error",
    signal: options.signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
      "X-Worktable-Runtime": runtimeId,
    },
    body: JSON.stringify(body),
  })
}
