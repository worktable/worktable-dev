import {
  BillingStatus as BillingStatusSchema,
  type BillingStatus,
} from "@worktable/hosted-contract"
import {
  authenticatedFetch,
  BASE_URL,
  redirectToLogin,
  UnauthorizedError,
} from "./http"

export async function getCloudBillingStatus(): Promise<BillingStatus> {
  const response = await authenticatedFetch(`${BASE_URL}/api/billing/status`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: unknown
    } | null
    throw new Error(
      typeof body?.error === "string"
        ? body.error
        : "Could not read billing status"
    )
  }
  return BillingStatusSchema.parse(await response.json())
}

async function openCloudBillingDestination(
  path: "/api/billing/checkout" | "/api/billing/portal",
  fallbackError: string
): Promise<void> {
  const response = await authenticatedFetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  })
  if (response.status === 401) {
    redirectToLogin()
    throw new UnauthorizedError()
  }
  const body = (await response.json().catch(() => null)) as {
    url?: unknown
    error?: unknown
  } | null
  if (!response.ok || typeof body?.url !== "string") {
    throw new Error(
      typeof body?.error === "string" ? body.error : fallbackError
    )
  }
  window.location.assign(body.url)
}

export async function openCloudBillingCheckout(): Promise<void> {
  return openCloudBillingDestination(
    "/api/billing/checkout",
    "Could not open checkout"
  )
}

export async function openCloudBillingPortal(): Promise<void> {
  return openCloudBillingDestination(
    "/api/billing/portal",
    "Could not open billing management"
  )
}

export function downloadCloudWorkspace(): void {
  window.location.assign("/api/workspace/export")
}
