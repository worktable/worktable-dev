import { expect, test } from "@playwright/test"
import { buildWidgetShareRuntimeScript } from "../../../packages/server/src/widget-share-runtime"

test("a live share SDK starts first in an opaque frame and uses only the visitor broker", async ({
  page,
}) => {
  await page.clock.install()
  await page.emulateMedia({ colorScheme: "dark" })
  const html = `<!doctype html><html data-theme="light"><head>${buildWidgetShareRuntimeScript()}<script>
    window.authoredTheme = document.documentElement.getAttribute('data-theme');
    window.addEventListener('DOMContentLoaded', async () => {
      document.querySelector('#theme').textContent = window.authoredTheme;
      const records = await worktable.records.query('deals');
      document.querySelector('#records').textContent = records[0].data.name;
      document.querySelector('button').addEventListener('click', async () => {
        try { await worktable.records.create('deals', {name:'attempt'}); }
        catch(error) { document.querySelector('#write').textContent = error.code; }
      });
    });
  </script></head><body><p id="theme"></p><p id="records"></p><p id="write"></p><button>Attempt write</button><a href="https://outside.example.test/report">External page</a></body></html>`
  await page.route("https://html.example.test/frame", (route) =>
    route.fulfill({
      contentType: "text/html",
      headers: {
        "Content-Security-Policy":
          "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-ancestors https://share.example.test",
      },
      body: html,
    })
  )
  await page.route("https://share.example.test/preview", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><script>
    window.messages = [];
    window.addEventListener('message', event => {
      if (event.source !== document.querySelector('iframe').contentWindow) return;
      window.messages.push({ origin:event.origin, value:event.data });
      const request = event.data;
      if (request.type === 'worktable.api.request') event.source.postMessage({ type:'worktable.api.response', id:request.id, ok:true, status:200, body:{records:[{id:'opaque',data:{name:'Granted data'}}]} }, '*');
    });
  </script><iframe title="Live tool" sandbox="allow-scripts" src="https://html.example.test/frame"></iframe>`,
    })
  )
  await page.goto("https://share.example.test/preview")
  const frame = page.frameLocator('iframe[title="Live tool"]')
  await expect(frame.locator("#theme")).toHaveText("dark")
  await expect(frame.locator("#records")).toHaveText("Granted data")
  const authored = page
    .frames()
    .find((candidate) => candidate !== page.mainFrame())!
  await authored.evaluate(() =>
    (document.querySelector("a") as HTMLAnchorElement).click()
  )
  // One round trip through the real parent message queue, not a timing sleep.
  await authored.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const channel = new MessageChannel()
        channel.port1.onmessage = () => {
          channel.port1.close()
          channel.port2.close()
          resolve()
        }
        channel.port2.postMessage(null)
      })
  )
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { messages: Array<{ value: { type: string } }> }
      ).messages.some(
        (message) => message.value.type === "worktable.share.open-link"
      )
    )
  ).toBe(false)
  await frame.getByRole("button", { name: "Attempt write" }).click()
  await expect(frame.locator("#write")).toHaveText("LINK_READ_ONLY")
  // A trusted click still works after a long press, without a recent
  // pointerdown or keydown. Synthetic authored clicks above stay rejected.
  const anchor = await frame
    .getByRole("link", { name: "External page" })
    .boundingBox()
  expect(anchor).not.toBeNull()
  await page.mouse.move(
    anchor!.x + anchor!.width / 2,
    anchor!.y + anchor!.height / 2
  )
  await page.mouse.down()
  await page.clock.fastForward(2000)
  await page.mouse.up()
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as { messages: Array<{ value: { type: string } }> }
        ).messages.some(
          (message) => message.value.type === "worktable.share.open-link"
        )
      )
    )
    .toBe(true)
  const messages = await page.evaluate(
    () =>
      (
        window as unknown as {
          messages: Array<{ origin: string; value: Record<string, unknown> }>
        }
      ).messages
  )
  expect(messages[0]?.value.type).toBe("worktable.navigation.handshake")
  expect(messages.every((message) => message.origin === "null")).toBe(true)
  expect(
    messages.filter((message) => message.value.type === "worktable.api.request")
  ).toHaveLength(1)
  expect(
    messages.some((message) => message.value.type === "worktable.interaction")
  ).toBe(true)
  expect(
    messages.some(
      (message) =>
        message.value.type === "worktable.share.open-link" &&
        message.value.url === "https://outside.example.test/report"
    )
  ).toBe(true)
  expect(JSON.stringify(messages)).not.toContain("private-space")
  expect(JSON.stringify(messages)).not.toContain("private-path")
  expect(
    page
      .frames()
      .find((candidate) => candidate !== page.mainFrame())
      ?.url()
  ).toBe("https://html.example.test/frame")
})
