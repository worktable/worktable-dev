import { expect, test } from "@playwright/test"
import { startWebHarness, type WebHarness } from "./harness"

/**
 * A two-page Word file made for this test: a bold title, a line, then a
 * page break and a second line.
 */
const PLAN_DOCX = Buffer.from(
  "UEsDBBQAAAAIAAAAdF3JTxqw6wAAAK4BAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH1QvU7DMBDeeQrLK4odGBBCSTrwMwJDeYCTfUks7LPlc0v79jht6YAK4933q69b7YIXW8zsIvXyRrVSIJloHU29/Fi/NPdScAGy4CNhL/fIcjVcdet9QhZVTNzLuZT0oDWbGQOwigmpImPMAUo986QTmE+YUN+27Z02kQpSacriIYfuCUfY+CKed/V9LJLRsxSPR+KS1UtIyTsDpeJ6S/ZXSnNKUFV54PDsEl9XgtQXExbk74CT7q0uk51F8Q65vEKoLP0Vs9U2mk2oSvW/zYWecRydwbN+cUs5GmSukwevzkgARz/99WHu4RtQSwMEFAAAAAgAAAB0XbmBRHGwAAAAKgEAAAsAAABfcmVscy8ucmVsc43POw7CMAwG4J1TRN5pWgaEUJMuCKkrKgeIEjeNaB5KwqO3JwMDIAZG278/y233sDO5YUzGOwZNVQNBJ70yTjM4D8f1DkjKwikxe4cMFkzQ8VV7wlnkspMmExIpiEsMppzDntIkJ7QiVT6gK5PRRytyKaOmQciL0Eg3db2l8d0A/mGSXjGIvWqADEvAf2w/jkbiwcurRZd/nPhKFFlEjZnB3UdF1atdFRYob+nHi/wJUEsDBBQAAAAIAAAAdF0hCtmRHAEAABgCAAARAAAAd29yZC9kb2N1bWVudC54bWyNUU1PwzAMvfMrotxZtmp8qFq7225IoMEPSBv3Q2riKPEo5dfjpoKOE1xsPz/72XEOxw87iHcIsUdXyN1mKwW4Gk3v2kK+vZ5uH6WIpJ3RAzoo5ARRHsubw5gbrC8WHAlWcDEfC9kR+VypWHdgddygB8dcg8FqYhhaNWIwPmANMfIAO6hsu71XVvdOlixZoZlm72cTknlOrlLlQf0gKl8uOhCEYRJ+0G6maClI1v/WoPLUh0jC6xYENoI6SG2bP/qqIJifPL96bpVqETtDjc78Uy1CTcvSvj1/sh6faZdlez7zmHcc3z1yrJaCJ50mouf8fikJfdvRCiskQrviAZortgNtIBTyIUuwQaQr2F4owTROraup77ur9U/LL1BLAQIUAxQAAAAIAAAAdF3JTxqw6wAAAK4BAAATAAAAAAAAAAAAAACAAQAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQDFAAAAAgAAAB0XbmBRHGwAAAAKgEAAAsAAAAAAAAAAAAAAIABHAEAAF9yZWxzLy5yZWxzUEsBAhQDFAAAAAgAAAB0XSEK2ZEcAQAAGAIAABEAAAAAAAAAAAAAAIAB9QEAAHdvcmQvZG9jdW1lbnQueG1sUEsFBgAAAAADAAMAuQAAAEADAAAAAA==",
  "base64"
)

let harness: WebHarness
test.beforeAll(async () => {
  harness = await startWebHarness("word-viewer", { storageVersion: 2 })
  const created = await fetch(`${harness.apiUrl}/api/spaces`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "papers", name: "Papers" }),
  })
  expect(created.ok).toBe(true)
  for (const [name, bytes] of [
    ["plan.docx", PLAN_DOCX],
    ["damaged.docx", Buffer.from("This was never a Word file. ".repeat(40))],
  ] as const) {
    const saved = await fetch(
      `${harness.apiUrl}/api/spaces/papers/documents/file?path=${name}`,
      { method: "PUT", body: new Uint8Array(bytes) }
    )
    expect(saved.ok).toBe(true)
  }
})
test.afterAll(async () => {
  await harness?.stop()
})

test("a Word file opens on its page in the Word viewer, and a damaged one keeps its card", async ({
  page,
}) => {
  await page.goto(`${harness.webUrl}/spaces/papers/documents/plan.docx`)
  const frameElement = page.locator('iframe[data-viewer-frame="word"]')
  await expect(frameElement).toHaveAttribute("data-settled", "", {
    timeout: 90_000,
  })
  const frame = page.frameLocator('iframe[data-viewer-frame="word"]')

  // The document as Word lays it out: its text, on its pages.
  await expect(frame.getByText("Quarterly plan")).toBeVisible()
  await expect(page.getByText("of 2")).toBeVisible()
  await expect(frame.getByText("Second page of the plan.")).toBeAttached()

  // The page's tools drive the viewer, and the viewer reports back.
  const scale = page.locator('[aria-live="polite"]', { hasText: "%" })
  await expect(scale).toHaveText("100%")
  await page.getByRole("button", { name: "Zoom in" }).click()
  await expect(scale).toHaveText("125%")

  // A file that can't be read says so, and still downloads.
  await page.goto(`${harness.webUrl}/spaces/papers/documents/damaged.docx`)
  await expect(page.getByText("Couldn’t load preview")).toBeVisible({
    timeout: 60_000,
  })
  await expect(page.getByRole("button", { name: "Download" })).toBeVisible()
})
