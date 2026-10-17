import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { CloudPlan } from "@/lib/cloud-plan"
import { PlanFullNotice } from "./plan-full-notice"

function render(plan: Partial<CloudPlan>, adding = 1) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <PlanFullNotice
        plan={{
          plan: "team",
          access: "active",
          peopleLimit: 10,
          people: 10,
          payerName: "Avery",
          isPayer: true,
          ...plan,
        }}
        worktableName="Northwind"
        adding={adding}
      />
    </QueryClientProvider>
  )
}

test("a full plan offers the next plan to the person who pays, and names them to everyone else", () => {
  expect(render({ plan: "solo", peopleLimit: 1, people: 1 })).toContain(
    "Inviting people needs a paid plan for Northwind."
  )
  const payer = render({})
  expect(payer).toContain(
    "Northwind&#x27;s plan has room for 10 people, and 10 are in or invited."
  )
  expect(payer).toContain("Move to Team 30, $99 a month")
  expect(render({ isPayer: false })).toContain(
    "Northwind is full. Ask Avery to change the plan. We&#x27;ve"
  )
  expect(render({ plan: "team30", peopleLimit: 30, people: 30 })).toContain(
    "Northwind has reached 30 people."
  )
})

test("Solo starts on the smallest paid plan that holds everyone being invited", () => {
  const small = render({ plan: "solo", peopleLimit: 1, people: 1 }, 3)
  expect(small).toMatch(/aria-checked="true"[^>]*>.*?Team<\/span>/)
  const large = render({ plan: "solo", peopleLimit: 1, people: 1 }, 12)
  expect(large).toMatch(/aria-checked="true"[^>]*>.*?Team 30<\/span>/)
})
