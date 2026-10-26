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
 * continues until the agent answers. `rejected` means the destination refused
 * the ring, so retrying cannot help and a person must check the setup.
 */
export type RingOutcome =
  | { kind: "sent" }
  | { kind: "rejected"; status: number }

export interface RingContext {
  fetch: typeof fetch
  signal: AbortSignal
}

/** Read a destination's answer without keeping its body or headers. */
export async function ringOutcome(response: Response): Promise<RingOutcome> {
  await response.body?.cancel()
  return [400, 401, 403, 404, 410].includes(response.status) ||
    (response.status >= 300 && response.status < 400)
    ? { kind: "rejected", status: response.status }
    : { kind: "sent" }
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
  return ringOutcome(response)
}
