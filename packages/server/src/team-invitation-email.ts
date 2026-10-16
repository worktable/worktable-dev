import {
  ENV,
  InvitationEmailResult,
  type InvitationEmailRequest,
  type InvitationEmailStatus,
} from "@worktable/hosted-contract"

/** Only Cloud tenants are given an invitation mail endpoint. */
export function invitationEmailConfigured(): boolean {
  return Boolean(invitationEmailEndpoint())
}

function invitationEmailEndpoint(): {
  url: URL
  runtimeId: string
  secret: string
} | null {
  const url = process.env[ENV.INVITATION_MAIL_URL]?.trim()
  const runtimeId = process.env[ENV.INVITATION_MAIL_RUNTIME_ID]?.trim()
  const secret = process.env[ENV.GATEWAY_SECRET]?.trim()
  if (!url || !runtimeId || !secret) return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "https:" || parsed.username || parsed.password)
      return null
    return { url: parsed, runtimeId, secret }
  } catch {
    return null
  }
}

/**
 * Asks the control plane to email one invitation. Creating the invitation
 * never depends on this succeeding, so every failure becomes a status.
 */
export async function sendInvitationEmail(
  request: InvitationEmailRequest
): Promise<InvitationEmailStatus> {
  const endpoint = invitationEmailEndpoint()
  if (!endpoint) return "unavailable"
  try {
    const response = await fetch(endpoint.url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${endpoint.secret}`,
        "X-Worktable-Runtime": endpoint.runtimeId,
      },
      body: JSON.stringify(request),
    })
    if (!response.ok) return "failed"
    const parsed = InvitationEmailResult.safeParse(
      await response.json().catch(() => null)
    )
    return parsed.success ? parsed.data.status : "failed"
  } catch {
    return "failed"
  }
}
