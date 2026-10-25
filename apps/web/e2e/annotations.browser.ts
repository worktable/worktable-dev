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
          name: "Annotate",
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
      await composer
        .getByRole("button", { name: "Cancel", exact: true })
        .click()
      await expect(composer).not.toBeVisible()
      expect(await savedAnnotations()).toEqual([])

      await selectQuote()
      await expectQuote()
      await expect(composer.getByRole("textbox")).toBeFocused()
      if (mobile) {
        await page.keyboard.insertText("Please clarify the wording.")
        await composer
          .getByRole("button", { name: "Instruction", exact: true })
          .tap()
      } else {
        await composer.getByRole("textbox").fill("Please clarify the wording.")
      }
      await composer
        .getByRole("button", {
          name: mobile ? "Add Instruction" : "Add Comment",
          exact: true,
        })
        .click()
      await expect.poll(savedAnnotations).toMatchObject([
        {
          category: mobile ? "instruction" : "comment",
          body: "Please clarify the wording.",
          target: { type: "block", blockId: "selected-block", quote },
        },
      ])
      await expect(composer).not.toBeVisible()
      // On a phone the next comment is a tap away; the panel stays shut.
      await expect(
        page
          .getByRole("complementary")
          .filter({ has: page.getByRole("heading", { name: "Annotations", exact: true }) })
          .getByText("Please clarify the wording.", { exact: true })
      ).toBeVisible({ visible: !mobile })
      await expect(paragraph).toHaveText(`${quote} before publishing.`)
      expect(await savedAnnotations()).toHaveLength(1)

      // A second annotation on the same block starts from a blank draft.
      await selectQuote()
      await expect(composer.getByRole("textbox")).toHaveValue("")
      await expect(
        composer.getByRole("button", { name: "Comment", exact: true })
      ).toHaveAttribute("aria-pressed", "true")
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
        "# Reading\n\nKeep this line.\n\nThe **launch date** moves to May.\n\n<details>\n<summary>Background</summary>\n\nThe plan from April.\n\n</details>\n"
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

      // A section opened before commenting stays open, and stays the same
      // element, through the re-renders a new comment brings.
      const section = article.locator(".worktable-details")
      await section.getByText("Background").click()
      await expect(section.getByText("The plan from April.")).toBeVisible()
      await section.evaluate((element) => {
        element.setAttribute("data-test-kept", "")
      })

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
      await composer
        .getByRole("button", { name: "Add Comment", exact: true })
        .click()

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
      await expect
        .poll(() => highlighted(page, "worktable-comment"))
        .toEqual(["launch date moves"])
      await expect(article.locator(".worktable-details[data-test-kept]")).toHaveCount(1)
      await expect(section.getByText("The plan from April.")).toBeVisible()

      // An agent rewrites the file around the passage.
      await writeFile(
        file,
        "# Reading\n\nA new opening.\n\n- The **launch date** moves to May, for now.\n"
      )
      await expect(article.locator("li")).toContainText("for now")
      await expect
        .poll(() => highlighted(page, "worktable-comment"))
        .toEqual(["launch date moves"])
    })
  })
}
