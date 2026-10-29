import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { CloudAnalyticsContext } from "@/lib/analytics"
import { PrivacySection } from "./privacy"

function switchChecked(preference: CloudAnalyticsContext["preference"]) {
  const client = new QueryClient()
  client.setQueryData<CloudAnalyticsContext>(["cloud", "analytics"], {
    preference,
    distinctId: "workos:user_test",
    surface: "web",
  })
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <PrivacySection />
    </QueryClientProvider>
  )
  return html.match(/role="switch"[^>]*aria-checked="(true|false)"/)?.[1]
}

test("usage analytics reads as on until the person turns it off", () => {
  expect(switchChecked(null)).toBe("true")
  expect(switchChecked({ version: 1, enabled: true, updatedAt: 1 })).toBe(
    "true"
  )
  expect(switchChecked({ version: 1, enabled: false, updatedAt: 1 })).toBe(
    "false"
  )
})
