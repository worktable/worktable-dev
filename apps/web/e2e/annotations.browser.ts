import { mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { expect, test, type Locator, type Page } from "@playwright/test"
import { startWebHarness, type WebHarness } from "./harness"

let harness: WebHarness

test.beforeAll(async () => {
  harness = await startWebHarness("annotations")
  const response = await fetch(`${harness.apiUrl}/api/spaces`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Annotations" }),
  })
  expect(response.ok).toBe(true)
})

test.afterAll(async () => {
  await harness?.stop()
})

/** The text a named ::highlight() marks on the page. */
const highlighted = (page: Page, name: string) =>
  page.evaluate(
    (name) =>
      [...(CSS.highlights.get(name) ?? [])].map((range) =>
        (range as Range).toString()
      ),
    name
  )
const draftHighlight = (page: Page) =>
  highlighted(page, "worktable-comment-draft")

/** The comment sheet slides in on mobile; a tap while it moves can miss. */
const settled = (composer: Locator) =>
  composer.evaluate((element) =>
    Promise.all(
      element
        .getAnimations({ subtree: true })
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().endTime !== Infinity
        )
        .map((animation) => animation.finished.catch(() => undefined))
    )
  )

for (const mobile of [true, false]) {
  test.describe(mobile ? "mobile" : "desktop", () => {
    test.use({
      viewport: mobile
        ? { width: 390, height: 844 }
        : { width: 1280, height: 900 },
      hasTouch: mobile,
      isMobile: mobile,
    })

    test("annotations preserve the selected quote through composing and saving", async ({
      page,
    }) => {
      // Allow the cold dev-server editor bundle to load on shared CI workers.
      test.setTimeout(120_000)
      const docPath = mobile ? "mobile-selection" : "desktop-selection"
      const quote = "Review this sentence"
      const response = await page.request.put(
        `${harness.apiUrl}/api/spaces/annotations/docs/${docPath}`,
        {
          data: {
            content: [
              {
                id: "intro",
                type: "paragraph",
                content: "Context before the selection.",
              },
              {
                id: "selected-block",
                type: "paragraph",
                content: `${quote} before publishing.`,
              },
            ],
          },
        }
      )
      expect(response.ok()).toBe(true)
      const annotationUrl = `${harness.apiUrl}/api/spaces/annotations/annotations?docPath=${docPath}`
      const savedAnnotations = async () =>
        (await (await page.request.get(annotationUrl)).json()).annotations

      await page.goto(
        `${harness.webUrl}/spaces/annotations/documents/${docPath}`,
        { waitUntil: "domcontentloaded" }
      )
      const editor = page.locator('.bn-editor[contenteditable="true"]')
      const paragraph = editor.locator(
        '[data-id="selected-block"] .bn-inline-content'
      )
      await expect(paragraph).toHaveText(`${quote} before publishing.`, {
        timeout: 60_000,
      })
      const composer = page.getByRole("dialog", { name: "Add Comment" })
      // On a phone the sheet repeats the quote; beside the text, the page
      // keeps it marked instead.
      const expectQuote = async () => {
        if (mobile) await expect(composer.locator("blockquote")).toHaveText(quote)
        else await expect.poll(() => draftHighlight(page)).toEqual([quote])
      }
      const selectQuote = async () => {
        // Native selection handles are OS UI, so focus the editor and select
        // the quote through it, then use a real touch tap on mobile to
        // exercise selection/focus preservation. Do not tap the text and set
        // a DOM range: ProseMirror copies its selection back to the page
        // 20 ms after gaining focus, and on a busy runner that can land after
        // the range and before the editor reads it, restoring the caret.
        await paragraph.evaluate((node, length) => {
          const { editor } = node.closest(".bn-editor") as HTMLElement & {
            editor: import("@tiptap/core").Editor
          }
          editor.view.focus()
          const from = editor.view.posAtDOM(node.firstChild!, 0)
          // Start from a caret, as a drag would, so selecting the same quote
          // again still reads as a new selection and shows the toolbar.
          editor.commands.setTextSelection(from)
          editor.commands.setTextSelection({ from, to: from + length })
        }, quote.length)
        await expect
          .poll(() => page.evaluate(() => window.getSelection()?.toString()))
          .toBe(quote)
        const annotate = page.getByRole("button", {
          name: "Comment",
          exact: true,
        })
        if (mobile) await annotate.tap()
        else await annotate.click()
        await expect(composer).toBeVisible()
        await settled(composer)
      }

      await selectQuote()
      await expectQuote()
      await expect(composer.getByRole("textbox")).toBeFocused()
      await page.keyboard.press("Escape")
      await expect(composer).not.toBeVisible()
      expect(await savedAnnotations()).toEqual([])

      await selectQuote()
      await expectQuote()
      await expect(composer.getByRole("textbox")).toBeFocused()
      if (mobile) await page.keyboard.insertText("Please clarify the wording.")
      else await composer.getByRole("textbox").fill("Please clarify the wording.")
      await composer
        .getByRole("button", { name: "Send comment", exact: true })
        .click()
      await expect.poll(savedAnnotations).toMatchObject([
        {
          category: "comment",
          body: "Please clarify the wording.",
          target: { type: "block", blockId: "selected-block", quote },
        },
      ])
      await expect(composer).not.toBeVisible()
      // On a phone the next comment is a tap away; the panel stays shut.
      await expect(
        page
          .getByRole("complementary")
          .filter({ has: page.getByRole("heading", { name: "Comments", exact: true }) })
          .getByText("Please clarify the wording.", { exact: true })
      ).toBeVisible({ visible: !mobile })
      await expect(paragraph).toHaveText(`${quote} before publishing.`)
      expect(await savedAnnotations()).toHaveLength(1)

      // A second annotation on the same block starts from a blank draft.
      await selectQuote()
      await expect(composer.getByRole("textbox")).toHaveValue("")
    })

    test("a Markdown Doc takes a comment on selected text without Edit, and keeps it on its passage through a rewrite", async ({
      page,
    }) => {
      test.setTimeout(120_000)
      const docPath = mobile ? "mobile-reading" : "desktop-reading"
      const file = harness.workspacePath(
        "spaces",
        "annotations",
        "docs",
        `${docPath}.md`
      )
      await mkdir(dirname(file), { recursive: true })
      await writeFile(
        file,
        "# Reading\n\nKeep this line.\n\nThe **launch date** moves to May.\n"
      )
      const annotationUrl = `${harness.apiUrl}/api/spaces/annotations/annotations?docPath=${docPath}`
      const savedAnnotations = async () =>
        (await (await page.request.get(annotationUrl)).json()).annotations

      await page.goto(
        `${harness.webUrl}/spaces/annotations/documents/${docPath}`,
        { waitUntil: "domcontentloaded" }
      )
      const article = page.locator("article.worktable-markdown")
      await expect(article).toContainText("moves to May.", { timeout: 60_000 })
      await expect(page.locator('[contenteditable="true"]')).toHaveCount(0)

      // From inside the bold words to the plain text after them.
      await article.locator("p", { hasText: "moves to May" }).evaluate((paragraph) => {
        const bold = paragraph.querySelector("strong")!
        const range = document.createRange()
        range.setStart(bold.firstChild!, 0)
        range.setEnd(bold.nextSibling!, " moves".length)
        window.getSelection()!.removeAllRanges()
        window.getSelection()!.addRange(range)
      })
      const comment = page.getByRole("button", { name: "Comment", exact: true })
      if (mobile) await comment.tap()
      else await comment.click()
      const composer = page.getByRole("dialog", { name: "Add Comment" })
      await expect(composer.getByRole("textbox")).toBeFocused()
      await settled(composer)
      if (!mobile)
        await expect.poll(() => draftHighlight(page)).toEqual(["launch date moves"])
      await page.keyboard.insertText("Confirm with finance.")
      // A second press while the first is still sending makes no second
      // comment.
      let creates = 0
      page.on("request", (request) => {
        if (
          request.method() === "POST" &&
          new URL(request.url()).pathname.endsWith("/annotations")
        )
          creates += 1
      })
      const send = composer.getByRole("button", {
        name: "Send comment",
        exact: true,
      })
      if (mobile) {
        await send.tap()
        await send.tap({ force: true, timeout: 1_000 }).catch(() => {})
      } else {
        await page.keyboard.press("Enter")
        await page.keyboard.press("Enter")
      }
      await expect(composer).not.toBeVisible()

      await expect.poll(savedAnnotations).toMatchObject([
        {
          body: "Confirm with finance.",
          target: {
            type: "doc",
            docPath,
            quote: "launch date moves",
            prefix: expect.stringContaining("Keep this line."),
            suffix: " to May.",
          },
        },
      ])
      expect(creates).toBe(1)
      await expect
        .poll(() => highlighted(page, "worktable-comment"))
        .toEqual(["launch date moves"])

      // An agent rewrites the file around the passage.
      await writeFile(
        file,
        "# Reading\n\nA new opening.\n\n- The **launch date** moves to May, for now.\n"
      )
      await expect(article.locator("li")).toContainText("for now")
      await expect
        .poll(() => highlighted(page, "worktable-comment"))
        .toEqual(["launch date moves"])

      if (mobile) return
      // An agent answers in Markdown, and the writer answers back.
      const [saved] = await savedAnnotations()
      const replied = await page.request.post(
        `${harness.apiUrl}/api/spaces/annotations/annotations/${saved.id}/replies`,
        {
          data: {
            body: "Moved to **June**.",
            author: { type: "agent", id: "agent-reviewer", name: "Reviewer" },
          },
        }
      )
      expect(replied.ok()).toBe(true)
      // The list shows the latest message; opening it shows the conversation.
      await page.getByRole("button", { name: /Moved to June\./ }).click()
      const thread = page.getByRole("article", { name: /^Comment by / })
      await expect(thread.locator("strong", { hasText: "June" })).toBeVisible()
      await page.getByPlaceholder(/^Reply/).click()
      await page.keyboard.insertText("Thanks, June works.")
      await page.keyboard.press("Enter")
      await expect
        .poll(async () =>
          (await savedAnnotations())[0].thread.map(
            (message: { body: string }) => message.body
          )
        )
        .toEqual(["Moved to **June**.", "Thanks, June works."])
      await expect(thread.getByText("Thanks, June works.")).toBeVisible()
      await page.getByRole("button", { name: "All Comments", exact: true }).click()
      await expect(
        page.getByRole("button", { name: /Thanks, June works\./ })
      ).toBeVisible()
    })
  })
}

test("a rich Doc marks commented text, and a comment whose text is gone shows it in the version it was written on", async ({
  page,
}) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1280, height: 900 })
  const docPath = "rich-original"
  const base = `${harness.apiUrl}/api/spaces/annotations/docs`
  const blocks = (text: string) => [
    { type: "heading", props: { level: 1 }, content: "Rich Original" },
    { type: "paragraph", content: text },
  ]
  expect(
    (
      await page.request.post(base, {
        data: {
          title: "Rich Original",
          content: blocks("The launch date moves to May."),
        },
      })
    ).ok()
  ).toBe(true)
  const comment = await page.request.post(
    `${harness.apiUrl}/api/spaces/annotations/annotations`,
    {
      data: {
        target: { type: "doc", docPath, quote: "launch date moves" },
        category: "comment",
        body: "Confirm with finance.",
      },
    }
  )
  expect(comment.ok()).toBe(true)

  await page.goto(`${harness.webUrl}/spaces/annotations/documents/${docPath}`, {
    waitUntil: "domcontentloaded",
  })
  const editor = page.locator('.bn-editor[contenteditable="true"]')
  await expect(editor).toContainText("moves to May", { timeout: 60_000 })
  // Marked as on a Markdown Doc.
  await expect
    .poll(() => highlighted(page, "worktable-comment"))
    .toEqual(["launch date moves"])

  // The sentence is rewritten; the comment waits under Text Changed.
  const { revision } = (await (
    await page.request.get(`${base}/${docPath}`)
  ).json()) as { revision: string }
  expect(
    (
      await page.request.fetch(`${base}/${docPath}`, {
        method: "PUT",
        data: { content: blocks("We ship in June."), expectedRevision: revision },
      })
    ).ok()
  ).toBe(true)
  await expect(editor).toContainText("We ship in June.")
  await page.getByRole("button", { name: /open comments/ }).click()
  const changed = page.getByRole("region", { name: /Text Changed/ })
  await expect(changed.getByText("Confirm with finance.")).toBeVisible({
    timeout: 10_000,
  })
  await changed.getByRole("button", { name: /Confirm with finance\./ }).click()
  await page.getByRole("button", { name: "Original", exact: true }).click()
  await expect
    .poll(() => highlighted(page, "worktable-comment-original"))
    .toEqual(["launch date moves"])
})


for (const mobile of [true, false]) {
  test.describe(mobile ? "HTML Doc on a phone" : "HTML Doc", () => {
    test.use({
      viewport: mobile
        ? { width: 390, height: 844 }
        : { width: 1280, height: 900 },
      hasTouch: mobile,
      isMobile: mobile,
    })

    test("a comment on an element of an HTML Doc follows it through a rewrite", async ({
      page,
    }) => {
      test.setTimeout(120_000)
      const id = mobile ? "pricing-phone" : "pricing"
      const widgets = `${harness.apiUrl}/api/spaces/annotations/widgets`
      const pageHtml = (price: string, note: string) =>
        `<!doctype html><html><head><title>Pricing</title></head><body><main><h1>Pricing</h1>
<section id="plans"><article><h3>Team</h3>
<div class="price">${price}</div>
<p>Up to 12 people.</p></article></section>
${note}</main></body></html>`
      expect(
        (
          await page.request.post(widgets, {
            data: {
              id,
              name: "Pricing",
              html: pageHtml(
                "$49 per month",
                '<p class="note">Prices exclude tax.</p>'
              ),
            },
          })
        ).ok()
      ).toBe(true)

      await page.goto(`${harness.webUrl}/spaces/annotations/documents/${id}`, {
        waitUntil: "domcontentloaded",
      })
      const frame = page.frameLocator(
        'iframe[data-worktable-widget-frame="true"]'
      )
      const price = frame.locator(".price")
      await expect(price).toHaveText("$49 per month", { timeout: 60_000 })
      const mode = page.getByRole("button", { name: "Comment", exact: true })
      const composer = page.getByRole("dialog", { name: "Add Comment" })
      const thread = page.getByRole("article", { name: /^Comment by / })
      const choose = (element: Locator) =>
        mobile ? element.tap() : element.click()
      const commentOn = async (element: Locator, text: string) => {
        await choose(element)
        await expect(composer.getByRole("textbox")).toBeVisible()
        if (mobile) await settled(composer)
        await composer.getByRole("textbox").fill(text)
        await composer
          .getByRole("button", { name: "Send comment", exact: true })
          .click()
        await expect(composer).toBeHidden()
      }

      // The mode stays on from one comment to the next.
      await mode.click()
      await expect(mode).toHaveAttribute("aria-pressed", "true")
      await commentOn(price, "Show the yearly price.")
      await expect(mode).toHaveAttribute("aria-pressed", "true")
      await commentOn(frame.locator(".note"), "Cut this line.")
      // Escape leaves it, from inside the page too.
      if (mobile) await mode.click()
      else await frame.locator("body").press("Escape")
      await expect(mode).toHaveAttribute("aria-pressed", "false")

      // An agent rewrites the page: the price reads differently and the
      // note is gone.
      const source = await page.request.get(
        `${widgets}/${id}/content?format=raw`
      )
      const revision = source.headers()["etag"]?.replace(/"/g, "")
      expect(
        (
          await page.request.fetch(`${widgets}/${id}`, {
            method: "PUT",
            data: {
              name: "Pricing",
              html: pageHtml("$39 per month, billed yearly", ""),
              expectedRevision: revision,
            },
          })
        ).ok()
      ).toBe(true)
      await expect(price).toHaveText("$39 per month, billed yearly", {
        timeout: 30_000,
      })

      // The price's comment is still pinned to it: its pin, where the
      // element was pressed along its top edge, opens the comment.
      await expect(async () => {
        if (!(await thread.isVisible())) {
          const box = (await price.boundingBox())!
          const at = [box.x + box.width / 2, box.y] as const
          if (mobile) await page.touchscreen.tap(...at)
          else await page.mouse.click(...at)
        }
        await expect(thread).toContainText("Show the yearly price.", {
          timeout: 2_000,
        })
      }).toPass({ timeout: 30_000 })

      // The note's comment waits under Page Changed.
      await page.getByRole("button", { name: "All Comments", exact: true }).click()
      const changed = page.getByRole("region", { name: /Page Changed/ })
      await expect(changed.getByText("Cut this line.")).toBeVisible()
      await expect(changed.getByText("Show the yearly price.")).toHaveCount(0)

      // An agent reading the price's comment is given its lines in the page.
      const { annotations } = (await (
        await page.request.get(
          `${harness.apiUrl}/api/spaces/annotations/annotations?widgetId=${id}`
        )
      ).json()) as { annotations: Array<{ id: string; body: string }> }
      const context = async (body: string) =>
        (
          (await (
            await page.request.get(
              `${harness.apiUrl}/api/spaces/annotations/annotations/${
                annotations.find((annotation) => annotation.body === body)!.id
              }/context`
            )
          ).json()) as { context: Record<string, unknown> }
        ).context
      expect(await context("Show the yearly price.")).toMatchObject({
        selectorMatch: "fuzzy",
        startLine: 3,
        excerpt: '<div class="price">$39 per month, billed yearly</div>',
      })
      expect(await context("Cut this line.")).toMatchObject({
        targetExists: false,
        selectorMatch: "stale",
      })
    })
  })
}
