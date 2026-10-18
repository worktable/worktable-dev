import { useQuery } from "@tanstack/react-query"
import {
  CLOUD_PLANS,
  nextCloudPlan,
  type CloudPlanId,
  type PaidCloudPlanId,
} from "@worktable/hosted-contract/plans"
import type { WorkspaceInfo } from "./api"
import { workspaceQueryOptions } from "./queries"

export type CloudPlan = NonNullable<WorkspaceInfo["cloudPlan"]>

/** This Worktable's Cloud plan, from the workspace summary; null elsewhere. */
export function useCloudPlan(): {
  plan: CloudPlan | null
  worktableName: string
} {
  const workspace = useQuery(workspaceQueryOptions())
  return {
    plan: workspace.data?.cloudPlan ?? null,
    worktableName: workspace.data?.name ?? "This Worktable",
  }
}

/** "$49 a month" */
export function planPrice(id: CloudPlanId): string {
  const plan = CLOUD_PLANS[id]
  return plan.amount === 0 ? "Free" : `$${plan.amount / 100} a month`
}

/** "Up to 12 people", or "Just you and your agents" on Solo. */
export function planSummary(id: CloudPlanId): string {
  const plan = CLOUD_PLANS[id]
  return id === "solo"
    ? "Just you and your agents"
    : `Up to ${plan.peopleLimit} people`
}

/** Whether inviting this many more people fits the plan. */
export function roomFor(plan: CloudPlan | null, adding: number): boolean {
  if (!plan || plan.peopleLimit === null) return true
  return plan.people + Math.max(adding, 1) <= plan.peopleLimit
}


export function upgradeFor(plan: CloudPlan): PaidCloudPlanId | null {
  return nextCloudPlan(plan.plan)
}

/** Members see a payment problem two days before access locks. */
export const MEMBER_GRACE_NOTICE_MS = 2 * 24 * 60 * 60 * 1000
