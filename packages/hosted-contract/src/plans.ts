// The Cloud plans as plain values, without the schemas around them, so a
// browser can show plans without loading the validation library. The
// package's main entry re-exports all of this.

/**
 * The public, provider-neutral offer: one plan per Worktable, priced by how
 * many people it holds. Agents never count. Amounts are minor currency units.
 *
 * Provider product, price, checkout, customer, and subscription identifiers
 * intentionally live outside this package so they can never leak into a
 * browser-facing DTO.
 */
export const CLOUD_PLAN_IDS = ["solo", "team", "business"] as const
export type CloudPlanId = (typeof CLOUD_PLAN_IDS)[number]

export const PLAN_TERMS = {
  currency: "usd",
  interval: "month",
  initialRefundDays: 14,
  pastDueGraceDays: 7,
  supportEmail: "support@worktable.dev",
} as const

export const CLOUD_PLANS = {
  solo: {
    id: "solo",
    name: "Solo",
    amount: 0,
    peopleLimit: 1,
    linkedDevices: 1,
    ...PLAN_TERMS,
  },
  team: {
    id: "team",
    name: "Team",
    amount: 4900,
    peopleLimit: 12,
    linkedDevices: 3,
    ...PLAN_TERMS,
  },
  business: {
    id: "business",
    name: "Business",
    amount: 19900,
    peopleLimit: 50,
    linkedDevices: 5,
    ...PLAN_TERMS,
  },
} as const satisfies Record<CloudPlanId, { id: CloudPlanId; [key: string]: unknown }>

/** How each paid plan's product is named at the payment provider, so invoices say what was bought. */
export const CLOUD_PLAN_PRODUCT_NAMES = {
  team: "Worktable Cloud Team",
  business: "Worktable Cloud Business",
} as const

/** The plans someone pays for, in the order a Worktable grows through them. */
export const PAID_CLOUD_PLAN_IDS = ["team", "business"] as const
export type PaidCloudPlanId = (typeof PAID_CLOUD_PLAN_IDS)[number]

/** The plan that holds more people, or null at the largest. */
export function nextCloudPlan(id: CloudPlanId): PaidCloudPlanId | null {
  return id === "solo" ? "team" : id === "team" ? "business" : null
}
