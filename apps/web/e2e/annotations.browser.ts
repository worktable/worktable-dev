import { expect, test } from "@playwright/test"
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
      const composer = page.getByRole("dialog", { name: "Add Annotation" })
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
          editor.commands.setTextSelection({ from, to: from + length })
        }, quote.length)
        await expect
          .poll(() => page.evaluate(() => window.getSelection()?.toString()))
          .toBe(quote)
        const annotate = page.getByRole("button", {
          name: "Annotate",
          exact: true,
        })
        if (mobile) await annotate.tap()
        else await annotate.click()
        // The composer slides in on mobile, and a tap while it moves can land
        // beside its target. Wait until it has settled.
        await expect(composer).toBeVisible()
        await composer.evaluate((element) =>
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
      }

      await selectQuote()
      await expect(composer.locator("blockquote")).toHaveText(quote)
      if (mobile) await expect(composer.getByRole("textbox")).toBeFocused()
      await composer
        .getByRole("button", { name: "Cancel", exact: true })
        .click()
      await expect(composer).not.toBeVisible()
      expect(await savedAnnotations()).toEqual([])

      await selectQuote()
      await expect(composer.locator("blockquote")).toHaveText(quote)
      if (mobile) {
        await expect(composer.getByRole("textbox")).toBeFocused()
        await page.keyboard.insertText("Please clarify the wording.")
        await composer
          .getByRole("button", { name: "Instruction", exact: true })
          .tap()
      } else {
        await composer.getByRole("textbox").fill("Please clarify the wording.")
      }
      await composer
        .getByRole("button", { name: "Add Annotation", exact: true })
        .click()
      await expect.poll(savedAnnotations).toMatchObject([
        {
          category: mobile ? "instruction" : "comment",
          body: "Please clarify the wording.",
          target: { type: "block", blockId: "selected-block", quote },
        },
      ])
      await expect(composer).not.toBeVisible()
      await expect(
        page
          .getByRole("complementary")
          .filter({ has: page.getByRole("heading", { name: "Annotations", exact: true }) })
          .getByText("Please clarify the wording.", { exact: true })
      ).toBeVisible()
      await expect(paragraph).toHaveText(`${quote} before publishing.`)
      expect(await savedAnnotations()).toHaveLength(1)

      // A second annotation on the same block starts from a blank draft.
      if (mobile) {
        await page
          .getByRole("button", { name: "Close annotations", exact: true })
          .tap()
        // Closing returns focus, which would clear a selection made mid-close.
        await expect(
          page.getByRole("dialog", { name: "Annotations", exact: true })
        ).toHaveCount(0)
      }
      await selectQuote()
      await expect(composer.getByRole("textbox")).toHaveValue("")
      await expect(
        composer.getByRole("button", { name: "Comment", exact: true })
      ).toHaveAttribute("aria-pressed", "true")
    })
  })
}
