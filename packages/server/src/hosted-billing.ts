import {
  BILLING_HEADER,
  decodeTenantBilling,
  nextCloudPlan,
  type CloudPlanId,
  type PaidCloudPlanId,
  type TenantBilling,
} from "@worktable/hosted-contract"
import { gatewayAdmits, gatewaySecret, isHosted } from "./hosted.ts"
import { accessSnapshot } from "./team-access.ts"
import { currentTeamWorktable, requireTeamDatabase } from "./team-database.ts"
import { listTeamMembers } from "./team-members.ts"
import { TeamAccessError } from "./team-policy.ts"

/**
 * The plan the gateway says this Worktable is on. Null off Cloud, and on any
 * request the gateway didn't admit, so nobody can claim a bigger plan.
 */
export function requestBilling(request: Request): TenantBilling | null {
  if (!isHosted() || !gatewaySecret() || !gatewayAdmits(request)) return null
  return decodeTenantBilling(request.headers.get(BILLING_HEADER))
}

function expiresAtMs(value: unknown): number {
  if (typeof value === "number") return value
  if (value instanceof Date) return value.getTime()
  return Date.parse(String(value))
}

/**
 * The people a plan holds: members and pending invitations that haven't
 * expired. Agents never count.
 */
export function peopleInWorktable(now = Date.now()): number {
  const worktable = currentTeamWorktable()
  if (!worktable) return 1
  const pending = requireTeamDatabase()
    .query<{ expiresAt: unknown }, [string]>(
      "SELECT expiresAt FROM invitation WHERE organizationId = ? AND status = 'pending'"
    )
    .all(worktable.organizationId)
    .filter((row) => expiresAtMs(row.expiresAt) > now).length
  return listTeamMembers().length + pending
}

export interface PlanRoom {
  plan: CloudPlanId
  limit: number | null
  used: number
  nextPlan: PaidCloudPlanId | null
  payerName: string | null
}

export function planRoom(billing: TenantBilling): PlanRoom {
  return {
    plan: billing.plan,
    limit: billing.peopleLimit,
    used: peopleInWorktable(),
    nextPlan: nextCloudPlan(billing.plan),
    payerName: billing.payer?.name || null,
  }
}

/** Inviting would take the Worktable past what its plan holds. */
export class PlanFullError extends Error {
  readonly code = "PLAN_FULL"
  readonly room: PlanRoom
  constructor(room: PlanRoom) {
    super("This Worktable's plan is full")
    this.room = room
  }
}

/** Refuse an invitation the plan has no room for. */
export function assertRoomForInvitation(billing: TenantBilling | null): void {
  if (!billing || billing.peopleLimit === null) return
  const room = planRoom(billing)
  if (room.used + 1 > billing.peopleLimit) throw new PlanFullError(room)
}

/** Whether this member signs in as the person who pays for the Worktable. */
export function memberIsPayer(
  userId: string,
  billing: TenantBilling | null
): boolean {
  const subject = billing?.payer?.subject
  if (!subject) return false
  for (const [key, binding] of accessSnapshot()?.bindings ?? []) {
    if (binding.userId === userId && key.endsWith(`\0${subject}`)) return true
  }
  return false
}

/** The payer stays an owner until billing is handed over. */
export function assertPayerKeepsOwnership(
  userId: string,
  role: "owner" | "member" | null,
  billing: TenantBilling | null
): void {
  if (role === "owner" || !memberIsPayer(userId, billing)) return
  throw new TeamAccessError(
    role === null
      ? "Hand over billing before removing the person who pays"
      : "Hand over billing before changing the role of the person who pays"
  )
}
