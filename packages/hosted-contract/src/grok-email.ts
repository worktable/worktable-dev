import { z } from "zod"

export const GROK_EMAIL_WAKE_PATH = "/runtime/grok-email-wake"
export const GROK_LINKED_EMAIL_WAKE_PATH = "/linked/grok-email-wake"
export const GrokBotEmailAddress = z
  .string()
  .trim()
  .toLowerCase()
  .max(81)
  .regex(/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?@mail\.grokbot\.com$/)

/** Only an opaque wake signal crosses the mail service, never an assignment. */
export const GrokEmailWake = z
  .object({
    emailAddress: GrokBotEmailAddress,
    connectionKey: z.string().regex(/^[a-f0-9]{64}$/),
    wakeId: z.string().regex(/^wake_[a-f0-9-]{36}$/),
    attempt: z.number().int().min(1).max(6),
  })
  .strict()
export type GrokEmailWake = z.infer<typeof GrokEmailWake>
export const LinkedGrokEmailWake = GrokEmailWake.extend({
  workspaceEpoch: z.string().min(1).max(256),
  bootSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict()

export async function grokEmailConnectionKey(
  principalId: string
): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(principalId)
  )
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

/** Bind a sender to the exact MCP resource and connection, across all transports. */
export async function grokEmailSender(
  resource: string,
  connectionKey: string
): Promise<string> {
  const digest = await grokEmailConnectionKey(`${resource}:${connectionKey}`)
  return `wake.${digest.slice(0, 40)}@agents.worktable.dev`
}
