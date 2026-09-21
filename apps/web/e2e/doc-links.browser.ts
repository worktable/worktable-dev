import { expect, test } from "@playwright/test"
import { readFile, writeFile } from "node:fs/promises"
import { startWebHarness, type WebHarness } from "./harness"

let harness: WebHarness
let sourcePath: string
let corruptedSourcePath: string

function appUrl(path = "/"): string {
  return new URL(path, harness.webUrl).href
}

async function flushDocPersist(docPath: string): Promise<void> {
  const response = await fetch(
    `${harness.apiUrl}/api/spaces/link-regression/docs/${docPath}?format=markdown`
  )
  if (!response.ok) {
    throw new Error(
      `Failed to flush ${docPath}: ${response.status} ${await response.text()}`
    )
  }
}

async function writeFixture(): Promise<void> {
  const jsonHeaders = { "Content-Type": "application/json" }
  const spaceResponse = await fetch(`${harness.apiUrl}/api/spaces`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ name: "Link Regression" }),
  })
  expect(spaceResponse.status).toBe(201)

  const targetResponse = await fetch(
    `${harness.apiUrl}/api/spaces/link-regression/docs/target`,
    {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Target document", styles: {} }],
          },
        ],
      }),
    }
  )
  expect(targetResponse.ok).toBe(true)

  const sourceResponse = await fetch(
    `${harness.apiUrl}/api/spaces/link-regression/docs/source`,
    {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Open ", styles: {} },
              {
                type: "link",
                href: "./target",
                content: [{ type: "text", text: "the target", styles: {} }],
              },
            ],
          },
        ],
      }),
    }
  )
  expect(sourceResponse.ok).toBe(true)

  const corruptedSourceResponse = await fetch(
    `${harness.apiUrl}/api/spaces/link-regression/docs/corrupted-source`,
    {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Open ", styles: {} },
              {
                type: "link",
                href: "/spaces/link-regression/docs/spaces/link-regression/docs/target",
                content: [
                  { type: "text", text: "the damaged target", styles: {} },
                ],
              },
            ],
          },
        ],
      }),
    }
  )
  expect(corruptedSourceResponse.ok).toBe(true)

  const recordCollectionResponse = await fetch(
    `${harness.apiUrl}/api/spaces/link-regression/records?ifAbsent=true`,
    {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        id: "projects",
        name: "Projects",
        fields: {
          title: { type: "string", required: true },
          status: { type: "enum", values: ["open", "done"] },
          notes: { type: "text" },
        },
      }),
    }
  )
  expect(recordCollectionResponse.status).toBe(201)

  const recordResponse = await fetch(
    `${harness.apiUrl}/api/spaces/link-regression/records/projects`,
    {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        id: "resize-audit",
        data: {
          title: "Resize audit",
          status: "open",
          notes: "Exercises the right-hand detail rail.",
        },
      }),
    }
  )
  expect(recordResponse.status).toBe(201)

  // Write this one directly so neither the REST path nor a Yjs state cache
  // pre-warms its room. The large first import makes Bun's real async
  // websocket-open/message overlap deterministic for the cold-sync regression.
  const coldSyncBlocks = [
    {
      id: "cold-sync-heading",
      type: "heading",
      props: {
        level: 1,
        textColor: "default",
        backgroundColor: "default",
        textAlignment: "left",
      },
      content: [{ type: "text", text: "Cold Sync Proof", styles: {} }],
      children: [],
    },
    ...Array.from({ length: 5_000 }, (_, index) => ({
      id: `cold-sync-${index}`,
      type: "paragraph",
      props: {
        textColor: "default",
        backgroundColor: "default",
        textAlignment: "left",
      },
      content: [
        {
          type: "text",
          text: `Cold sync paragraph ${index}`,
          styles: {},
        },
      ],
      children: [],
    })),
  ]
  await writeFile(
    harness.workspacePath("spaces/link-regression/docs/cold-sync-proof.json"),
    JSON.stringify(coldSyncBlocks)
  )
}

test.beforeAll(async () => {
  harness = await startWebHarness("doc-link-browser")
  await writeFixture()

  sourcePath = harness.workspacePath("spaces/link-regression/docs/source.json")
  corruptedSourcePath = harness.workspacePath(
    "spaces/link-regression/docs/corrupted-source.json"
  )
})

test.afterAll(async () => {
  await harness?.stop()
})

test("a cold rich-text doc completes its first websocket sync without refresh", async ({
  page,
}) => {
  // Trace DOM snapshots query styles throughout the entire editor, forcing
  // skipped content-visibility subtrees to lay out between every assertion.
  // Keep visual/network diagnostics without changing the rendering behavior
  // this 5,000-block regression is intended to exercise.
  await page.context().tracing.stop()
  await page.context().tracing.start({ screenshots: true, snapshots: false })
  await page.goto(appUrl(), { waitUntil: "domcontentloaded" })
  await page
    .getByRole("button", { name: "Link Regression", exact: true })
    .click()
  await page.getByRole("link", { name: "Cold Sync Proof", exact: true }).click()

  await expect(page).toHaveURL(
    /\/spaces\/link-regression\/documents\/cold-sync-proof$/
  )
  const firstParagraph = page.locator(
    '.bn-editor .bn-block-outer[data-id="cold-sync-0"] .bn-inline-content'
  )
  await expect(firstParagraph).toBeVisible({ timeout: 30_000 })
  await expect(firstParagraph).toHaveText("Cold sync paragraph 0")
  // Long documents keep offscreen blocks mounted while deferring their layout.
  // Address the fixture IDs directly rather than repeatedly walking all 5,000
  // text subtrees, then verify the last paragraph after actually scrolling there.
  const lastBlock = page.locator(
    '.bn-editor .bn-block-outer[data-id="cold-sync-4999"]'
  )
  await expect(lastBlock).toBeAttached()
  await lastBlock.evaluate((element) => element.scrollIntoView())
  await expect(lastBlock.locator(".bn-inline-content")).toBeVisible()
  await expect(lastBlock).toHaveText("Cold sync paragraph 4999")
  await expect(page.locator('[contenteditable="true"]')).toBeVisible()
  await expect(page.getByText("Syncing", { exact: true })).toHaveCount(0, {
    timeout: 30_000,
  })

  const completedTurns = await page.evaluate(async () => {
    let turns = 0
    while (turns < 5) {
      await new Promise((resolveTurn) => setTimeout(resolveTurn, 0))
      turns += 1
    }
    return turns
  })
  expect(completedTurns).toBe(5)
})

test("an internal link settles without hanging or rewriting the document", async ({
  page,
}) => {
  await page.clock.install()
  const sourceBefore = await readFile(sourcePath)

  await page.goto(appUrl("/spaces/link-regression/documents/source"), {
    waitUntil: "domcontentloaded",
  })
  const docLink = page.getByRole("link", { name: "the target" })
  await expect(docLink).toBeVisible({
    timeout: 30_000,
  })
  await expect(docLink).toHaveAttribute("href", "./target")
  await expect(page.locator('[contenteditable="true"]')).toBeVisible()

  await test.step("the browser event loop remains responsive", async () => {
    const completedTurns = await page.evaluate(async () => {
      let turns = 0
      while (turns < 5) {
        await new Promise((resolveTurn) => setTimeout(resolveTurn, 0))
        turns += 1
      }
      return turns
    })
    expect(completedTurns).toBe(5)
  })

  await test.step("viewing the document does not change its stored bytes", async () => {
    await page.clock.runFor(1_500)
    await flushDocPersist("source")
    expect(await readFile(sourcePath)).toEqual(sourceBefore)
  })
})

test("an already-amplified link opens without further rewriting", async ({
  page,
}) => {
  await page.clock.install()
  const sourceBefore = await readFile(corruptedSourcePath)

  await page.goto(
    appUrl("/spaces/link-regression/documents/corrupted-source"),
    {
      waitUntil: "domcontentloaded",
    }
  )
  const docLink = page.getByRole("link", { name: "the damaged target" })
  await expect(docLink).toBeVisible({ timeout: 30_000 })
  await expect(docLink).toHaveAttribute(
    "href",
    "/spaces/link-regression/docs/spaces/link-regression/docs/target"
  )

  const completedTurns = await page.evaluate(async () => {
    let turns = 0
    while (turns < 5) {
      await new Promise((resolveTurn) => setTimeout(resolveTurn, 0))
      turns += 1
    }
    return turns
  })
  expect(completedTurns).toBe(5)

  await page.clock.runFor(1_500)
  await flushDocPersist("corrupted-source")
  expect(await readFile(corruptedSourcePath)).toEqual(sourceBefore)
})

test("sidebar, record rail, and table columns support keyboard and pointer resizing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(
    appUrl("/spaces/link-regression/records/projects?record=resize-audit"),
    { waitUntil: "domcontentloaded" }
  )

  const toggle = page.getByRole("button", { name: "Toggle sidebar" })
  const recordHandle = page.getByRole("separator", {
    name: "Resize record details",
  })
  await expect(toggle).toBeVisible({ timeout: 30_000 })
  await expect(recordHandle).toBeVisible({ timeout: 30_000 })

  await toggle.click()
  await expect(
    page.getByRole("separator", { name: "Resize sidebar" })
  ).toHaveCount(0)
  await toggle.click()

  const sidebarHandle = page.getByRole("separator", {
    name: "Resize sidebar",
  })
  const columnHandle = page.getByRole("separator", {
    name: "Resize title column",
  })
  for (const handle of [sidebarHandle, recordHandle, columnHandle]) {
    await expect(handle).toBeVisible({ timeout: 30_000 })
  }

  await sidebarHandle.focus()
  const keyboardStart = Number(
    await sidebarHandle.getAttribute("aria-valuenow")
  )
  await page.keyboard.press("ArrowRight")
  await expect
    .poll(async () => Number(await sidebarHandle.getAttribute("aria-valuenow")))
    .toBeGreaterThan(keyboardStart)
  await sidebarHandle.dblclick()

  const sidebarStart = Number(await sidebarHandle.getAttribute("aria-valuenow"))
  const sidebarBox = await sidebarHandle.boundingBox()
  expect(sidebarBox).not.toBeNull()
  await page.mouse.move(
    sidebarBox!.x + sidebarBox!.width / 2,
    sidebarBox!.y + 120
  )
  await page.mouse.down()
  await page.mouse.move(sidebarBox!.x + sidebarBox!.width / 2 + 48, 120)
  await expect(sidebarHandle).toHaveAttribute("data-resizing", "")
  await page.mouse.up()
  await expect
    .poll(async () => Number(await sidebarHandle.getAttribute("aria-valuenow")))
    .toBeGreaterThan(sidebarStart)
  await sidebarHandle.dblclick()

  const recordStart = Number(await recordHandle.getAttribute("aria-valuenow"))
  const recordBox = await recordHandle.boundingBox()
  expect(recordBox).not.toBeNull()
  await page.mouse.move(recordBox!.x + recordBox!.width / 2, recordBox!.y + 120)
  await page.mouse.down()
  await page.mouse.move(recordBox!.x + recordBox!.width / 2 - 48, 120)
  await expect(recordHandle).toHaveAttribute("data-resizing", "")
  await page.mouse.up()
  await expect
    .poll(async () => Number(await recordHandle.getAttribute("aria-valuenow")))
    .toBeGreaterThan(recordStart)
  await recordHandle.dblclick()

  const columnHeader = columnHandle.locator("..")
  const columnStart = (await columnHeader.boundingBox())?.width ?? 0
  await columnHandle.hover()
  const columnBox = await columnHandle.boundingBox()
  expect(columnBox).not.toBeNull()
  await page.mouse.down()
  await page.mouse.move(
    columnBox!.x + columnBox!.width / 2 + 48,
    columnBox!.y + columnBox!.height / 2
  )
  await page.mouse.up()
  await expect
    .poll(async () => (await columnHeader.boundingBox())?.width ?? 0)
    .toBeGreaterThan(columnStart)
  await columnHandle.dblclick()
})

test("mobile navigation opens the new-space sheet and returns to navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(appUrl(), { waitUntil: "domcontentloaded" })

  const sidebarToggle = page.getByRole("button", { name: "Toggle sidebar" })
  await expect(sidebarToggle).toBeVisible({ timeout: 30_000 })
  await sidebarToggle.click()

  await expect(page.getByRole("button", { name: "All Spaces" })).toBeVisible()
  await page.getByRole("button", { name: "Create new space" }).click()
  await expect(page.getByRole("heading", { name: "New Space" })).toBeVisible()
  await page.getByRole("button", { name: "Cancel" }).click()
  await expect(page.getByRole("heading", { name: "New Space" })).toHaveCount(0)
})

test("markdown document links navigate without restarting the application", async ({
  page,
}) => {
  await writeFile(
    harness.workspacePath("spaces/link-regression/docs/markdown-links.md"),
    "# Navigation\n\n[Open target](./target)\n"
  )
  await page.goto(appUrl("/spaces/link-regression/documents/markdown-links"))
  const link = page.getByRole("link", { name: "Open target", exact: true })
  await expect(link).toBeVisible()
  const timeOrigin = await page.evaluate(() => performance.timeOrigin)
  await link.click()
  await expect(page).toHaveURL(/\/documents\/target$/)
  await expect(page.locator(".bn-editor")).toContainText("Target document", {
    timeout: 30_000,
  })
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin)
})


test("pasting nested blocks assigns new IDs and preserves existing identities", async ({ page }) => {
  const response = await fetch(`${harness.apiUrl}/api/spaces/link-regression/docs/id-regression`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: [
      { id: "original-parent", type: "paragraph", content: "Parent text", children: [
        { id: "original-child", type: "paragraph", content: "Nested text" },
      ] },
      { id: "paste-target", type: "paragraph", content: "Paste here" },
    ] }),
  });
  expect(response.ok).toBe(true);
  await page.goto(appUrl("/spaces/link-regression/documents/id-regression"));
  const editor = page.locator('.bn-editor[contenteditable="true"]');
  await expect(editor).toBeVisible();
  const parent = editor.locator('.bn-block-outer[data-id="original-parent"]');
  const html = await parent.evaluate((node) => node.outerHTML);
  const target = editor.locator('.bn-block-outer[data-id="paste-target"] .bn-inline-content');
  for (let i = 0; i < 2; i++) {
    const last = editor.locator('.bn-inline-content').last();
    await last.click();
    // Use a DOM range: the shared browser's platform key bindings can make
    // End a no-op, leaving the caret in the middle of the clicked paragraph.
    await last.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      range.collapse(false);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
    });
    await page.keyboard.press("Enter");
    await editor.evaluate((node, html) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("blocknote/html", html);
      clipboardData.setData("text/plain", "Parent text\nNested text");
      node.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
    }, html);
    await expect(editor.getByText("Nested text", { exact: true })).toHaveCount(i + 2);
  }
  const allIds = await editor.locator('.bn-block-outer[data-id]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-id")));
  expect(new Set(allIds).size).toBe(allIds.length);
  expect(allIds.every(Boolean)).toBe(true);
  await expect(parent.locator('.bn-block-outer[data-id="original-child"]')).toHaveText("Nested text");
  await expect(target).toHaveText("Paste here");
  await flushDocPersist("id-regression");
  await page.reload();
  await expect(editor).toBeVisible();
  await expect(editor.getByText("Nested text", { exact: true })).toHaveCount(3);
  const savedIds = await editor.locator('.bn-block-outer[data-id]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-id")));
  expect(savedIds).toEqual(allIds);

  // Exercise the installed ID plugin on a multi-step transaction, including
  // nested inserts and a later change to an already-inserted block. Each new
  // block must receive exactly one ID; existing annotation anchors stay intact.
  const transactionResult = await editor.evaluate((element) => {
    const tiptap = (element as HTMLElement & {
      editor: import("@tiptap/core").Editor
    }).editor;
    const view = tiptap.view;
    const source = view.state.doc.firstChild!.firstChild!;
    type NodeJSON = { attrs?: Record<string, unknown>; content?: NodeJSON[] };
    const copy: NodeJSON = structuredClone(source.toJSON());
    const clearIds = (node: NodeJSON) => {
      if (node.attrs && "id" in node.attrs) node.attrs.id = null;
      node.content?.forEach(clearIds);
    };
    clearIds(copy);
    const inserted = view.state.schema.nodeFromJSON(copy);
    const tr = view.state.tr.insert(1, inserted);
    tr.insert(tr.doc.content.size - 1, view.state.schema.nodeFromJSON(copy));
    tr.insertText("Edited ", 3);
    tr.setNodeMarkup(1, undefined, { ...tr.doc.nodeAt(1)!.attrs, id: null });
    const plugin = view.state.plugins.find((candidate) =>
      (candidate as unknown as { key: string }).key.startsWith("uniqueID$")
    )!;
    const append = plugin.spec.appendTransaction!;
    let assigned = 0;
    plugin.spec.appendTransaction = (...args) => {
      const result = append.apply(plugin, args);
      if (result) assigned += result.steps.length;
      return result;
    };
    try {
      view.dispatch(tr);
    } finally {
      plugin.spec.appendTransaction = append;
    }
    const ids: string[] = [];
    view.state.doc.descendants((node) => {
      if (node.type.name === "blockContainer") ids.push(node.attrs.id);
    });
    return { assigned, ids };
  });
  expect(transactionResult.assigned).toBe(4);
  expect(transactionResult.ids.length).toBe(savedIds.length + 4);
  expect(new Set(transactionResult.ids).size, JSON.stringify(transactionResult)).toBe(transactionResult.ids.length);
  expect(transactionResult.ids.every(Boolean)).toBe(true);
  expect(savedIds.every((id) => transactionResult.ids.includes(id!))).toBe(true);
});
