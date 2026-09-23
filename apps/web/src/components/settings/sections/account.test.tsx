import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import {
  CLOUD_PERSONAL_PLAN,
  type BillingStatus,
} from "@worktable/hosted-contract"
import { SubscriptionCard } from "./account"

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
    {
      access: "payment_required",
      manage: false,
      checkout: true,
      export: false,
    },
    { access: "locked", manage: false, checkout: true, export: true },
  ]
  for (const state of cases) {
    const html = renderToStaticMarkup(
      <SubscriptionCard
        billing={{
          plan: CLOUD_PERSONAL_PLAN,
          access: state.access,
          canManageBilling: state.manage,
          canCheckout: state.checkout,
          canExport: true,
        }}
        checkoutPending={false}
        portalPending={false}
        onCheckout={() => {}}
        onPortal={() => {}}
      />
    )
    expect(html.includes("Manage billing")).toBe(state.manage)
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
