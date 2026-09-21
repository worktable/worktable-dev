import { expect, test, type Page } from "@playwright/test"
import { fileURLToPath } from "node:url"

import { startWebHarness, type WebHarness } from "./harness"

let harness: WebHarness

function appUrl(path = "/"): string {
  return new URL(path, harness.webUrl).href
}

const toastModuleUrl = `/@fs${fileURLToPath(
  new URL("../../../packages/ui/src/components/sonner.tsx", import.meta.url)
)}`

async function showToast(page: Page) {
  await page.evaluate(async (moduleUrl) => {
    const { toast } = await import(/* @vite-ignore */ moduleUrl)
    toast.success("Document restored", {
      description: "Saved back to the workspace.",
      duration: Infinity,
      action: { label: "View", onClick: () => undefined },
    })
  }, toastModuleUrl)
}

async function dismissToasts(page: Page) {
  await page.evaluate(async (moduleUrl) => {
    const { toast } = await import(/* @vite-ignore */ moduleUrl)
    toast.dismiss()
  }, toastModuleUrl)
}

test.beforeAll(async () => {
  harness = await startWebHarness("toast-browser")
})

test.afterAll(async () => {
  await harness?.stop()
})

test("toasts expose their status, description, action, and dismissal", async ({
  page,
}) => {
  await page.goto(appUrl(), { waitUntil: "domcontentloaded" })
  await expect(
    page.getByRole("button", { name: "Settings", exact: true })
  ).toBeVisible({ timeout: 30_000 })

  await showToast(page)
  const toast = page.locator('[data-sonner-toast][data-type="success"]')
  await expect(toast).toBeVisible()
  await expect(toast).toContainText("Saved back to the workspace.")
  await expect(toast.getByRole("button", { name: "View" })).toBeVisible()

  await dismissToasts(page)
  await expect(toast).toHaveCount(0)
})

test("mobile toasts remain inside the viewport with a reachable action", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(appUrl(), { waitUntil: "domcontentloaded" })
  await expect(
    page.getByRole("button", { name: "Settings", exact: true })
  ).toBeVisible({ timeout: 30_000 })

  await showToast(page)
  const toast = page.locator('[data-sonner-toast][data-type="success"]')
  await expect(toast.getByRole("button", { name: "View" })).toBeVisible()

  const box = await toast.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(390)
})
