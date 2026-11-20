import { expect, test } from "@playwright/test"
import { startWebHarness, type WebHarness } from "./harness"

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

test("a file that can't be shown still says so and downloads", async ({
  page,
}) => {
  await page.goto(`${harness.webUrl}/spaces/papers/documents/damaged.pdf`)
  await expect(page.getByText("Couldn’t load preview")).toBeVisible({
    timeout: 60_000,
  })
  await expect(page.getByRole("button", { name: "Download" })).toBeVisible()
})
