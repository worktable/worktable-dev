import { expect, test } from "@playwright/test"
import { execFileSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { writeFile } from "node:fs/promises"
import { startWebHarness, type WebHarness } from "./harness"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const outside =
  '<img src=x onerror="alert(1)"> https://outside.example.test/request'

/** Seed synthetic private storage without adding a test-only product endpoint. */
function privateFixture(
  harness: WebHarness,
  path: string,
  kind: "doc" | "html",
  operation: "receive" | "retain" | "spike"
) {
  const script = `
    import { defaultSharingPolicy, DEFAULT_SHARE_LINK_COMMENT_SETTINGS } from "./packages/types/src/index.ts";
    import { useResolvedDocumentHandle } from "./packages/server/src/document-query.ts";
    import { getWorkspaceCollaborationEpoch } from "./packages/server/src/collaboration-epoch.ts";
    import { ensureWorkspaceManifest } from "./packages/server/src/workspace.ts";
    import { createShareLink, saveSharingPolicy, closeShareLinkStores } from "./packages/server/src/share-links-store.ts";
    import { receiveVisitorComment, sweepVisitorComments, commentPause, closeVisitorCommentStores, VisitorCommentRefused } from "./packages/server/src/visitor-comment-store.ts";
    const input = JSON.parse(process.argv.at(-1));
    if (input.operation === "retain") {
      sweepVisitorComments(Date.now() + 31 * 86400000);
      closeVisitorCommentStores();
      console.log("{}");
    } else {
      const documentId = await useResolvedDocumentHandle({spaceId: "visitor-review", path: input.path, materializeIdentity: true}, h => h.documentId);
      if (typeof documentId !== "string") throw new Error("Missing synthetic document");
      const worktableId = ensureWorkspaceManifest().id;
      saveSharingPolicy({...defaultSharingPolicy(), levels: ["view", "comment"], allowComments: true}, "local:owner");
      const {link} = createShareLink({workspaceEpoch: await getWorkspaceCollaborationEpoch(), spaceId: "visitor-review", documentId, kind: input.kind, label: "Audit comments", level: "comment", createdBy: {id: "local:owner", name: "Owner"}, expiresAt: null, comments: DEFAULT_SHARE_LINK_COMMENT_SETTINGS});
      const receive = index => receiveVisitorComment({worktableId, linkId: link.id, linkLabel: link.label, linkCreator: link.createdById, documentId, spaceId: link.spaceId, kind: input.kind, visitorName: "Auditor <unverified>", visitorKey: index.toString(16).padStart(64, "0"), clientKey: index.toString(16).padStart(32, "0"), body: input.operation === "receive" ? input.outside : "Synthetic review " + index, requestId: "fixture-request-" + index});
      const first = receive(0);
      if (input.operation === "spike") {
        for (let index=1; index<30; index++) receive(index);
        try { receive(30); throw new Error("Expected the thirty-first comment to be refused"); }
        catch (error) { if (!(error instanceof VisitorCommentRefused)) throw error; }
        if (commentPause(worktableId, link.id) !== "spike") throw new Error("Expected durable automatic pause");
      }
      closeVisitorCommentStores(); closeShareLinkStores();
      console.log(JSON.stringify({documentId, linkId: link.id, commentId: first.id}));
    }
  `
  const output = execFileSync(
    "bun",
    ["-e", script, JSON.stringify({ path, kind, operation, outside })],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        WORKTABLE_WORKSPACE: harness.workspacePath(),
        WORKTABLE_APP_DIR: harness.workspacePath("..", "app"),
      },
      encoding: "utf8",
    }
  )
  return JSON.parse(output.trim().split("\n").at(-1)!) as {
    documentId: string
    linkId: string
    commentId: string
  }
}

for (const appearance of [
  { kind: "html" as const, mobile: false, theme: "dark" },
  { kind: "doc" as const, mobile: true, theme: "light" },
]) {
  test.describe(`${appearance.kind} ${appearance.mobile ? "mobile" : "desktop"}`, () => {
    test.use({
      viewport: appearance.mobile
        ? { width: 390, height: 844 }
        : { width: 1280, height: 900 },
      isMobile: appearance.mobile,
      hasTouch: appearance.mobile,
    })

    test("reviews outside input privately, keeps the team copy and resumes only explicitly", async ({
      page,
    }, info) => {
      test.setTimeout(120_000)
      const previousPreview = process.env["WORKTABLE_SHARING_PREVIEW"]
      process.env["WORKTABLE_SHARING_PREVIEW"] = "1"
      const harness = await startWebHarness("visitor-review")
      const errors: string[] = []
      const requests: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      page.on("request", (request) => requests.push(request.url()))
      try {
        await page.addInitScript(
          (theme) => localStorage.setItem("theme", theme),
          appearance.theme
        )
        expect(
          (
            await page.request.post(`${harness.apiUrl}/api/spaces`, {
              data: { name: "Visitor Review" },
            })
          ).status()
        ).toBe(201)
        const path =
          appearance.kind === "html" ? "review-dashboard" : "review-report"
        if (appearance.kind === "html") {
          expect(
            (
              await page.request.post(
                `${harness.apiUrl}/api/spaces/visitor-review/widgets`,
                {
                  data: {
                    id: path,
                    name: "Review dashboard",
                    html: "<!doctype html><h1>Review dashboard</h1>",
                  },
                }
              )
            ).status()
          ).toBe(201)
        } else {
          await writeFile(
            harness.workspacePath(
              "spaces/visitor-review/docs/review-report.md"
            ),
            "# Review report\nSynthetic member report.\n"
          )
        }
        const seeded = privateFixture(harness, path, appearance.kind, "receive")
        const url = `${harness.webUrl}/spaces/visitor-review/documents/${path}`
        const listUrl = `${harness.apiUrl}/api/spaces/visitor-review/visitor-comments?documentId=${seeded.documentId}`
        const listReads = () =>
          requests.filter((url) =>
            /\/api\/spaces\/visitor-review\/visitor-comments\?/.test(url)
          ).length
        await page.goto(url, { waitUntil: "networkidle" })
        await expect(page.locator("main")).toBeVisible()
        expect(listReads()).toBe(0)
        await page.goto(`${url}#visitors`, { waitUntil: "networkidle" })
        await expect(
          page.getByRole("tab", { name: /^Visitors/ })
        ).toHaveAttribute("aria-selected", "true")
        const row = page
          .locator("article")
          .filter({ has: page.getByText(outside, { exact: true }) })
        await expect(row).toBeVisible()
        await expect(
          row.getByText("Auditor <unverified>", { exact: true })
        ).toBeVisible()
        await expect(row.getByText("Unverified", { exact: true })).toBeVisible()
        expect(await row.locator("a,img,svg[onload]").count()).toBe(0)
        expect(listReads()).toBe(1)
        await page.screenshot({
          path: info.outputPath("visitors.png"),
          fullPage: true,
        })

        await row
          .getByRole("button", { name: "Visitor comment actions" })
          .click()
        await page.getByRole("menuitem", { name: "Reply", exact: true }).click()
        await row
          .getByLabel("Reply to visitor", { exact: true })
          .fill("Thanks. We will check the figures.")
        await row.getByRole("button", { name: "Reply", exact: true }).click()
        await expect(
          row.getByText("Thanks. We will check the figures.", { exact: true })
        ).toBeVisible()
        await row
          .getByRole("button", { name: "Visitor comment actions" })
          .click()
        await page
          .getByRole("menuitem", { name: "Mark done", exact: true })
          .click()
        await expect(row.getByText("Done", { exact: true })).toBeVisible()
        await row
          .getByRole("button", { name: "Pass to Team", exact: true })
          .click()
        const form = row.locator("form")
        const pass = form.getByRole("button", {
          name: "Pass to Team",
          exact: true,
        })
        await expect(pass).toBeDisabled()
        await form
          .getByLabel("What should happen?", { exact: true })
          .fill("Please check the forecast before publishing.")
        await form
          .getByRole("button", { name: "Edit quote", exact: true })
          .click()
        await form
          .getByLabel("Outside input, unverified", { exact: true })
          .fill("Check the forecast totals.")
        await pass.click()
        await expect(row.getByText(/^Passed by /)).toBeVisible()
        await row
          .getByRole("button", { name: "View comment", exact: true })
          .click()
        await expect(
          page.getByRole("tab", { name: /^Comments/ })
        ).toHaveAttribute("aria-selected", "true")
        await expect(
          page.getByText(/Please check the forecast before publishing\./).last()
        ).toBeVisible()
        const retainedBefore = await (await page.request.get(listUrl)).json()
        const annotationId = retainedBefore.comments[0].passed.annotationId
        const teamUrl = `${harness.apiUrl}/api/spaces/visitor-review/annotations/${annotationId}?includeTargetContext=true`
        const teamBefore = await (await page.request.get(teamUrl)).json()
        expect(teamBefore.annotation.body).toContain(
          "> Check the forecast totals."
        )
        expect(
          teamBefore.annotation.metadata["worktable.origin"]
        ).toMatchObject({ visitorName: null, quoteEdited: true })

        privateFixture(harness, path, appearance.kind, "retain")
        await expect(page).toHaveURL(`${url}#visitors`)
        await page.reload({ waitUntil: "networkidle" })
        const receipt = page
          .locator("article")
          .filter({ hasText: "Visitor text has been erased." })
        await expect(receipt).toBeVisible()
        await expect(
          receipt.getByText("Visitor", { exact: true })
        ).toBeVisible()
        await expect(
          receipt.getByRole("button", { name: "View comment", exact: true })
        ).toBeVisible()
        await receipt
          .getByRole("button", { name: "Visitor comment actions" })
          .click()
        await expect(
          page.getByRole("menuitem", { name: "Reply", exact: true })
        ).toHaveCount(0)
        await page
          .getByRole("menuitem", { name: "Delete", exact: true })
          .click()
        const confirmation = page.getByRole("dialog", {
          name: "Delete visitor comment?",
          exact: true,
        })
        await expect(confirmation).toContainText("The team’s comment remains.")
        await confirmation
          .getByRole("button", { name: "Delete", exact: true })
          .click()
        await expect(receipt).toHaveCount(0)
        expect((await page.request.get(teamUrl)).status()).toBe(200)
        expect(
          (await (await page.request.get(listUrl)).json()).comments
        ).toEqual([])

        const spike = privateFixture(harness, path, appearance.kind, "spike")
        await page.goto(harness.webUrl, { waitUntil: "networkidle" })
        const pending = page
          .getByRole("link")
          .filter({ hasText: "Comments paused on Audit comments" })
        await expect(pending).toBeVisible()
        await pending.click()
        const resume = page.getByRole("button", {
          name: "Resume comments",
          exact: true,
        })
        await expect(resume).toBeVisible()
        const edit = await page.request.patch(
          `${harness.apiUrl}/api/shares/links/${spike.linkId}`,
          {
            data: {
              label: "Audit follow-up",
              comments: { visitorsSee: "all" },
            },
          }
        )
        expect(edit.status()).toBe(200)
        expect((await edit.json()).link.comments.autoPaused).toBe(true)
        await page.reload({ waitUntil: "networkidle" })
        await expect(
          page.getByText("Comments paused after a burst on Audit follow-up.", {
            exact: true,
          })
        ).toBeVisible()
        await page.screenshot({
          path: info.outputPath("paused.png"),
          fullPage: true,
        })
        await page
          .getByRole("button", { name: "Resume comments", exact: true })
          .click()
        await expect(
          page.getByRole("button", { name: "Resume comments", exact: true })
        ).toHaveCount(0)
        await writeFile(
          info.outputPath("page-errors.json"),
          JSON.stringify(errors)
        )
        expect(errors).toEqual([])
      } finally {
        await harness.stop()
        if (previousPreview === undefined)
          delete process.env["WORKTABLE_SHARING_PREVIEW"]
        else process.env["WORKTABLE_SHARING_PREVIEW"] = previousPreview
      }
    })
  })
}
