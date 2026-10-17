import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { CLOUD_PLANS, type BillingStatus } from "@worktable/hosted-contract"
import { SubscriptionCard } from "./account"

function render(billing: Partial<BillingStatus>, people: number | null = 3) {
  return renderToStaticMarkup(
    <SubscriptionCard
      billing={{
        plan: CLOUD_PLANS.team,
        access: "active",
        canManageBilling: true,
        canCheckout: false,
        canExport: true,
        canChangeTo: [],
        ...billing,
      }}
      people={people}
      worktableName="Northwind"
      onCheckout={() => {}}
      onPortal={() => {}}
    />
  )
}

test("subscription access determines available recovery actions", () => {
  const cases: Array<{
    access: BillingStatus["access"]
    manage: boolean
    checkout: boolean
    export: boolean
  }> = [
    { access: "active", manage: true, checkout: false, export: false },
    { access: "grace", manage: true, checkout: false, export: false },
    { access: "complimentary", manage: false, checkout: false, export: false },
    { access: "payment_required", manage: false, checkout: true, export: false },
    { access: "locked", manage: false, checkout: true, export: true },
  ]
  for (const state of cases) {
    const html = render({
      access: state.access,
      canManageBilling: state.manage,
      canCheckout: state.checkout,
    })
    expect(html.includes("Manage payment")).toBe(state.manage)
    expect(
      html.includes(
        state.access === "locked" ? "Restart subscription" : "Subscribe"
      )
    ).toBe(state.checkout)
    expect(html.includes(">Export</button>")).toBe(state.export)
    if (state.access === "grace") expect(html).toContain("Payment due")
    if (state.access === "complimentary") expect(html).toContain("VIP")
  }
})

test("a plan shows its people and offers the plans this Worktable can move to", () => {
  const team = render({ canChangeTo: ["business"] })
  expect(team).toContain("3 of 12 people")
  expect(team).toContain("Move to Business, $199 a month")
  expect(team).toContain("Cancel plan")

  // Solo pays for a plan through checkout.
  const solo = render(
    { plan: CLOUD_PLANS.solo, canManageBilling: false, canCheckout: true },
    1
  )
  expect(solo).toContain("Move to Team, $49 a month")
  expect(solo).not.toContain("Cancel plan")

  // Moving down waits until everyone fits.
  const crowded = render(
    { plan: CLOUD_PLANS.business, canChangeTo: ["team"] },
    14
  )
  expect(crowded).toContain("Remove 2 people before moving to Team.")
})
