import { runtimePath } from "./runtime-path"
import {
  BillingStatus as BillingStatusSchema,
  type BillingStatus,
  type PaidCloudPlanId,
} from "@worktable/hosted-contract"
import {
  authenticatedFetch,
  BASE_URL,
  redirectToLogin,
  UnauthorizedError,
  HttpError,
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
    throw new HttpError(
      response.status,
      body,
      typeof body?.error === "string"
        ? body.error
        : "Could not read billing status"
    )
  }
  return BillingStatusSchema.parse(await response.json())
}

async function openCloudBillingDestination(
  path: "/api/billing/checkout" | "/api/billing/portal",
  fallbackError: string,
  request?: Record<string, unknown>
): Promise<void> {
  const response = await authenticatedFetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    ...(request ? { body: JSON.stringify(request) } : {}),
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

/** The theme on screen, so checkout opens in it too. */
function pageTheme(): "light" | "dark" | undefined {
  if (typeof document === "undefined") return undefined
  return document.documentElement.classList.contains("light") ? "light" : "dark"
}

/** Pay for this Worktable: its current plan, or the paid plan chosen. */
export async function openCloudBillingCheckout(
  plan?: PaidCloudPlanId
): Promise<void> {
  const theme = pageTheme()
  return openCloudBillingDestination(
    "/api/billing/checkout",
    "Could not open checkout",
    plan || theme
      ? { ...(plan ? { plan } : {}), ...(theme ? { theme } : {}) }
      : undefined
  )
}

async function postBilling(
  path: "/api/billing/change-plan" | "/api/billing/cancel",
  request: Record<string, unknown>,
  fallbackError: string
): Promise<void> {
  const response = await authenticatedFetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  })
  if (response.status === 401) {
    redirectToLogin()
    throw new UnauthorizedError()
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: unknown
    } | null
    throw new Error(
      typeof body?.error === "string" ? body.error : fallbackError
    )
  }
}

/** Move a paid Worktable to another paid plan; it applies at once. */
export function changeCloudPlan(plan: PaidCloudPlanId): Promise<void> {
  return postBilling(
    "/api/billing/change-plan",
    { plan },
    "Could not change the plan"
  )
}

/** End the paid plan when the current period ends. */
export function cancelCloudPlan(): Promise<void> {
  return postBilling("/api/billing/cancel", {}, "Could not cancel the plan")
}

export async function openCloudBillingPortal(): Promise<void> {
  return openCloudBillingDestination(
    "/api/billing/portal",
    "Could not open billing management"
  )
}

export function downloadCloudWorkspace(): void {
  window.location.assign(runtimePath("/api/workspace/export"))
}
