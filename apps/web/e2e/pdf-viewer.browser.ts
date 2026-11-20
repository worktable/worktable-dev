import { expect, test } from "@playwright/test"
import { startWebHarness, type WebHarness } from "./harness"
import { THEME_STORAGE_KEY } from "../src/lib/theme"

/**
 * A valid PDF with one line of text on each page. `padding` adds that many
 * bytes nothing refers to, ahead of the pages.
 */
function pdfOf(pages: string[], padding = 0): Buffer {
  // Objects are numbered from 1: the catalog, the page list, the font, the
  // padding if any, then a page and its content for each page.
  const first = padding > 0 ? 5 : 4
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${first + index * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  if (padding > 0) {
    objects.push(
      `<< /Length ${padding} >>\nstream\n${"x".repeat(padding)}\nendstream`
    )
  }
  for (const [index, text] of pages.entries()) {
    const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${first + 1 + index * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
    )
  }
  let body = "%PDF-1.4\n"
  const offsets: number[] = []
  for (const [index, object] of objects.entries()) {
    offsets.push(body.length)
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets)
    body += `${String(offset).padStart(10, "0")} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, "latin1")
}

/**
 * A one-page PDF under the standard security handler (RC4, 40-bit), user
 * password "open sesame", made for this test.
 */
const LOCKED_PDF = Buffer.from(
  "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA1NSA+PgpzdHJlYW0KvWGGDIwKKafzKfupfrTGrvQBbqH4Hnb3khzi9ZUGOZV1FV4c2xo6jk4ppspw8N1vBmIOzTGMIwplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago2IDAgb2JqCjw8IC9GaWx0ZXIgL1N0YW5kYXJkIC9WIDEgL1IgMiAvTyA8ZmNlODk4MjQwNmFjZmQ5ZDhmYTZkODdiODI0N2FjYTFkYjY3YTM0YjE3ZTg2YWQyNzQ1YmZhNWYwYTEyZWQzYz4gL1UgPDMwYjBjYjg2ODI2MmY4MGViMjU0MDhiZjQzNzU3MjdiZTFhZWM3N2FhOTIzMGNjYTdmYWZkYzUyZTI3MDdlZDg+IC9QIC00NCA+PgplbmRvYmoKeHJlZgowIDcKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzNDYgMDAwMDAgbiAKMDAwMDAwMDQxNiAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDcgL1Jvb3QgMSAwIFIgL0VuY3J5cHQgNiAwIFIgL0lEIFs8OGY4MjQyYTRlMDQzNTI1Y2RjOWI4ZTQ5NDRhYmJhM2I+IDw4ZjgyNDJhNGUwNDM1MjVjZGM5YjhlNDk0NGFiYmEzYj5dID4+CnN0YXJ0eHJlZgo2MTIKJSVFT0YK",
  "base64"
)

let harness: WebHarness
test.beforeAll(async () => {
  harness = await startWebHarness("pdf-viewer", { storageVersion: 2 })
  const created = await fetch(`${harness.apiUrl}/api/spaces`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "papers", name: "Papers" }),
  })
  expect(created.ok).toBe(true)
  for (const [name, bytes] of [
    [
      "report.pdf",
      pdfOf(["First page of the report", "Second page", "Third and last page"]),
    ],
    // Past the size a file is handed over whole, so it is read in pieces.
    ["long.pdf", pdfOf(["A page far into a large file"], 5 * 1024 * 1024)],
    ["damaged.pdf", Buffer.from("This was never a PDF. ".repeat(40))],
    ["locked.pdf", LOCKED_PDF],
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

test("a PDF opens and reads on its page, inside a frame that can reach nothing", async ({
  page,
}) => {
  await page.goto(`${harness.webUrl}/spaces/papers/documents/report.pdf`)
  const frameElement = page.locator('iframe[data-viewer-frame="pdf"]')
  await expect(frameElement).toHaveAttribute("data-settled", "", {
    timeout: 60_000,
  })
  const frame = page.frameLocator('iframe[data-viewer-frame="pdf"]')

  // The file itself: its pages, and text a reader can select.
  await expect(page.getByText("of 3")).toBeVisible()
  await expect(frame.getByText("First page of the report")).toBeVisible()

  // The page's tools drive the viewer, and the viewer reports back.
  const pageNumber = page.getByRole("textbox", { name: "Page" })
  await pageNumber.fill("3")
  await pageNumber.press("Enter")
  await expect(frame.getByText("Third and last page")).toBeInViewport()
  await expect(pageNumber).toHaveValue("3")
  const scale = page.locator('[aria-live="polite"]', { hasText: "%" })
  const before = await scale.textContent()
  await page.getByRole("button", { name: "Zoom in" }).click()
  await expect(scale).not.toHaveText(before ?? "")

  // The page browser beside it: a picture of each page, and a way there.
  const pages = page.getByRole("button", { name: "Pages", exact: true })
  await expect(pages).toHaveAttribute("aria-pressed", "true")
  await expect(frame.locator(".rail-picture img")).toHaveCount(3)
  await frame.getByRole("button", { name: "Page 2", exact: true }).click()
  await expect(pageNumber).toHaveValue("2")
  await pages.click()
  await expect(frame.locator("#viewer-rail")).toBeHidden()

  // A change of theme reaches the open viewer without starting it again.
  const frames: string[] = []
  page.on("request", (request) => {
    if (request.url().includes("/api/viewers/pdf")) frames.push(request.url())
  })
  const theme = () =>
    frame.locator("html").getAttribute("data-theme", { timeout: 5_000 })
  await page.evaluate((key) => {
    localStorage.setItem(key, "system")
    window.dispatchEvent(
      new StorageEvent("storage", {
        key,
        newValue: "system",
        storageArea: localStorage,
      })
    )
  }, THEME_STORAGE_KEY)
  await page.emulateMedia({ colorScheme: "light" })
  await expect.poll(theme).toBe("light")
  await page.emulateMedia({ colorScheme: "dark" })
  await expect.poll(theme).toBe("dark")
  await expect(frame.getByText("Third and last page")).toBeAttached()
  expect(frames).toEqual([])

  // The file's content is data: the frame that parses it has no origin, no
  // session, no API and no network, and the frame can't be framed elsewhere.
  const inside = page
    .frames()
    .find((each) => each.url().includes("/api/viewers/pdf"))!
  const reach = await inside.evaluate(async () => {
    const tried = async (attempt: () => unknown) => {
      try {
        await attempt()
        return "reached"
      } catch {
        return "blocked"
      }
    }
    return {
      origin: self.origin,
      cookie: await tried(() => document.cookie),
      storage: await tried(() => localStorage.length),
      api: await tried(() =>
        fetch("/api/system/deployment", { credentials: "include" })
      ),
      network: await tried(() =>
        fetch("https://example.com/", { mode: "no-cors" })
      ),
      parent: await tried(() => window.parent.document.title),
    }
  })
  expect(reach).toEqual({
    origin: "null",
    cookie: "blocked",
    storage: "blocked",
    api: "blocked",
    network: "blocked",
    parent: "blocked",
  })
  expect(await frameElement.getAttribute("sandbox")).toBe("allow-scripts")

  // Reading it changed nothing.
  const bytes = await page.request.get(
    `${harness.apiUrl}/api/spaces/papers/documents/file?path=report.pdf`
  )
  expect(
    Buffer.from(await bytes.body())
      .subarray(0, 8)
      .toString()
  ).toBe("%PDF-1.4")
})

test("a reader finds text, opens at a linked page, and unlocks a file", async ({
  page,
}) => {
  // A link to a page opens there.
  await page.goto(`${harness.webUrl}/spaces/papers/documents/report.pdf#page=2`)
  const pageNumber = page.getByRole("textbox", { name: "Page" })
  await expect(pageNumber).toHaveValue("2", { timeout: 60_000 })

  // Find counts every match and moves through them.
  await page.getByRole("button", { name: "Find", exact: true }).click()
  const findField = page.getByRole("textbox", { name: "Find in PDF" })
  // It starts from the page in view: the second of three.
  await findField.fill("page")
  await expect(page.getByText("2 of 3")).toBeVisible()
  await findField.press("Enter")
  await expect(page.getByText("3 of 3")).toBeVisible()
  await findField.fill("nowhere in this file")
  await expect(page.getByText("No matches")).toBeVisible()
  await findField.press("Escape")
  await expect(findField).toBeHidden()

  // A locked file asks for its password, says when one is wrong, and opens.
  await page.goto(`${harness.webUrl}/spaces/papers/documents/locked.pdf`)
  const password = page.getByLabel("Password", { exact: true })
  await password.fill("not it")
  await page.getByRole("button", { name: "Open", exact: true }).click()
  await expect(page.getByText("That password didn’t work.")).toBeVisible({
    timeout: 30_000,
  })
  await password.fill("open sesame")
  await page.getByRole("button", { name: "Open", exact: true }).click()
  await expect(
    page
      .frameLocator('iframe[data-viewer-frame="pdf"]')
      .getByText("A page behind a password")
  ).toBeVisible()

  // Giving up leaves the card and the download.
  await page.reload()
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(page.getByText("Password protected")).toBeVisible()
})

test("a large PDF is read in pieces, not whole", async ({ page }) => {
  const ranges: string[] = []
  page.on("request", (request) => {
    const range = request.headers()["range"]
    if (range && request.url().includes("/documents/file")) ranges.push(range)
  })
  await page.goto(`${harness.webUrl}/spaces/papers/documents/long.pdf`)
  const frame = page.frameLocator('iframe[data-viewer-frame="pdf"]')
  await expect(frame.getByText("A page far into a large file")).toBeVisible({
    timeout: 60_000,
  })
  // The start, then only what the first page needed: far less than 5 MiB.
  expect(ranges[0]).toBe("bytes=0-262143")
  expect(ranges.length).toBeGreaterThan(1)
  const fetched = ranges.reduce((total, range) => {
    const [, begin, end] = /^bytes=(\d+)-(\d+)$/.exec(range) ?? []
    return total + Number(end) - Number(begin) + 1
  }, 0)
  expect(fetched).toBeLessThan(1024 * 1024)
})

test("a PDF whose bytes stop arriving says so instead of waiting", async ({
  page,
}) => {
  // The first piece arrives; every later read fails.
  await page.route("**/documents/file?*", (route) => {
    const range = route.request().headers()["range"]
    return range && !range.startsWith("bytes=0-")
      ? route.abort()
      : route.continue()
  })
  await page.goto(`${harness.webUrl}/spaces/papers/documents/long.pdf`)
  // Well inside the 30 seconds the viewer gives a file to show.
  await expect(page.getByText("Couldn’t load preview")).toBeVisible({
    timeout: 15_000,
  })
  await page.unroute("**/documents/file?*")
})

test("a PDF in a Doc opens full screen, and on to its page", async ({
  page,
}) => {
  const created = await page.request.post(
    `${harness.apiUrl}/api/spaces/papers/docs`,
    {
      data: {
        title: "Reading list",
        content: [
          { type: "paragraph", content: "This week:" },
          { type: "file", props: { url: "report.pdf", name: "report.pdf" } },
        ],
      },
    }
  )
  expect(created.ok()).toBe(true)
  const { path } = (await created.json()) as { path: string }
  await page.goto(`${harness.webUrl}/spaces/papers/documents/${path}`)
  await page.getByText("report.pdf", { exact: true }).click()
  const viewer = page.getByRole("dialog")
  await expect(
    viewer
      .frameLocator('iframe[data-viewer-frame="pdf"]')
      .getByText("First page of the report")
  ).toBeVisible({ timeout: 60_000 })
  await expect(viewer.getByText("of 3")).toBeVisible()
  await viewer.getByLabel("Open file page").click()
  await expect(page).toHaveURL(/\/documents\/report\.pdf$/)
  await expect(page.getByRole("dialog")).toBeHidden()
})

test("a document put in the viewer's place is never handed the file", async ({
  page,
}) => {
  // Stands in for a page another site navigated the viewer frame to: no
  // origin, the same frame, but not the document the app loaded there, so
  // it can only guess the secret the app gave that document.
  await page.route("**/api/viewers/pdf?*", (route) =>
    route.fulfill({
      contentType: "text/html",
      headers: { "Content-Security-Policy": "sandbox allow-scripts" },
      body: `<!doctype html><script>
        addEventListener("message", (event) => {
          if (event.data && event.data.type === "viewer.open") console.log("handed the file")
        })
        for (const token of ["", "guess"])
          parent.postMessage({ type: "viewer.handshake", token }, "*")
      </script>`,
    })
  )
  const logged: string[] = []
  page.on("console", (message) => logged.push(message.text()))
  await page.goto(`${harness.webUrl}/spaces/papers/documents/report.pdf`)
  // A handshake without the secret ends the open: the card, at once.
  await expect(page.getByText("Couldn’t load preview")).toBeVisible({
    timeout: 15_000,
  })
  expect(logged).not.toContain("handed the file")
  await page.unroute("**/api/viewers/pdf?*")
})

test("a file that can't be shown still says so and downloads", async ({
  page,
}) => {
  await page.goto(`${harness.webUrl}/spaces/papers/documents/damaged.pdf`)
  await expect(page.getByText("Couldn’t load preview")).toBeVisible({
    timeout: 60_000,
  })
  await expect(page.getByRole("button", { name: "Download" })).toBeVisible()
})
