// Waking an agent that isn't calling Worktable. A ring only says that something
// is waiting: it never carries work or authority. The woken agent fetches its
// work with its own credential, so a lost, repeated or forged ring can at worst
// cause an extra check.
//
// A mechanism, such as a webhook, is code. Each vendor that uses it is a
// profile: data saying which destinations may receive the secret and what the
// request looks like.

/** Delay before each retry when a woken agent has not answered. */
export const WAKE_RETRIES: readonly number[] = [
  15_000, 30_000, 60_000, 120_000, 300_000, 600_000,
]

/** One durable ring. The same id is reused when a ring is retried after a crash. */
export interface Ring {
  id: string
  attempts: number
}

/**
 * `sent` covers both acceptance and ambiguous failures: the retry schedule
 * continues until the agent answers. `session` is the run an accepted ring
 * started, when the profile reads one. `rejected` means the destination
 * refused the ring, so retrying cannot help and a person must check the
 * setup. `retry` means it was turned away for now (429 or 5xx), so nothing
 * started; `after` is how long it asked to wait, in milliseconds.
 */
export type RingOutcome =
  | { kind: "sent"; session?: string }
  | { kind: "rejected"; status: number }
  | { kind: "retry"; status: number; after?: number }

export interface RingContext {
  fetch: typeof fetch
  signal: AbortSignal
}

/** The longest Retry-After a ring honours. */
const MAX_RETRY_AFTER = 60 * 60_000

function retryAfter(value: string | null): number | undefined {
  const text = value?.trim()
  if (!text) return undefined
  const ms = /^\d+$/.test(text)
    ? Number(text) * 1000
    : Date.parse(text) - Date.now()
  // Zero or past asks for no wait in particular: the usual backoff applies.
  return Number.isFinite(ms) && ms > 0
    ? Math.min(ms, MAX_RETRY_AFTER)
    : undefined
}

/**
 * Read a destination's answer without keeping its headers. The body is read
 * only from an accepted answer, and only for the run it started.
 */
export async function ringOutcome(
  response: Response,
  profile?: Pick<WebhookProfile, "session">
): Promise<RingOutcome> {
  const { status } = response
  if (response.ok && profile?.session) {
    let session: string | undefined
    try {
      session = profile.session(JSON.parse(await response.text()))
    } catch {
      session = undefined
    }
    return session ? { kind: "sent", session } : { kind: "sent" }
  }
  await response.body?.cancel()
  if (
    [400, 401, 403, 404, 410].includes(status) ||
    (status >= 300 && status < 400)
  )
    return { kind: "rejected", status }
  if (status === 429 || status >= 500) {
    const after = retryAfter(response.headers.get("retry-after"))
    return after === undefined
      ? { kind: "retry", status }
      : { kind: "retry", status, after }
  }
  return { kind: "sent" }
}

export interface WebhookProfile {
  /** Shown when the value is not a URL. */
  urlHint: string
  /** Shown when a URL is not one of the profile's destinations. */
  destinationHint: string
  /** The only destinations allowed to receive the profile's secret. */
  allows(url: URL): boolean
  headers(secret: string): Record<string, string>
  body(ring: Ring): string
  /** The run an accepted ring started, read from the answer's body. */
  session?(body: unknown): string | undefined
}

/** A Grok Bot routine's webhook trigger, which Cursor Automations serves. */
export const GROK_BOT_ROUTINE: WebhookProfile = {
  urlHint: "Enter the routine's webhook URL",
  destinationHint:
    "Use the Grok Bot routine URL at https://api2.cursor.sh/automations/webhook/…",
  allows: (url) =>
    url.hostname === "api2.cursor.sh" &&
    /^\/automations\/webhook\/[A-Za-z0-9_-]+$/.test(url.pathname),
  headers: (secret) => ({
    "content-type": "application/json",
    authorization: `Bearer ${secret}`,
  }),
  body: (ring) =>
    JSON.stringify({
      version: 1,
      event: "worktable.inbox.ready",
      wakeId: ring.id,
    }),
}

/**
 * A Claude Code scheduled task's API trigger. Every accepted ring starts a new
 * run on the person's Claude plan, with no way to deduplicate, and its text
 * reaches the run as untrusted data. So it carries only the signal: never
 * content, names, ids or secrets.
 */
export const CLAUDE_CODE_TASK: WebhookProfile = {
  urlHint: "Paste the URL Claude shows for the API trigger",
  destinationHint:
    "Use the URL Claude shows: https://api.anthropic.com/v1/claude_code/routines/trig_…/fire",
  allows: (url) =>
    url.hostname === "api.anthropic.com" &&
    /^\/v1\/claude_code\/routines\/trig_[A-Za-z0-9_-]+\/fire$/.test(
      url.pathname
    ),
  headers: (secret) => ({
    "content-type": "application/json",
    authorization: `Bearer ${secret}`,
    "anthropic-version": "2023-06-01",
  }),
  body: () =>
    JSON.stringify({ text: "Something was sent to you in Worktable." }),
  session: (body) => {
    const url = (body as { claude_code_session_url?: unknown } | null)
      ?.claude_code_session_url
    return typeof url === "string" &&
      url.startsWith("https://") &&
      url.length <= 2048
      ? url
      : undefined
  },
}

/** Only an exact profile destination can receive its secret. No redirects. */
export function validateWebhookDestination(
  profile: WebhookProfile,
  value: string
): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(profile.urlHint)
  }
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !profile.allows(url)
  ) {
    throw new Error(profile.destinationHint)
  }
  return url.href
}

export async function ringWebhook(
  profile: WebhookProfile,
  destination: { url: string; secret: string },
  ring: Ring,
  context: RingContext
): Promise<RingOutcome> {
  const response = await context.fetch(
    validateWebhookDestination(profile, destination.url),
    {
      method: "POST",
      redirect: "error",
      headers: profile.headers(destination.secret),
      body: profile.body(ring),
      signal: context.signal,
    }
  )
  return ringOutcome(response, profile)
}
