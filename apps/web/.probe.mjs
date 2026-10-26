import { chromium } from "playwright";
const browser = await chromium.connectOverCDP("http://127.0.0.1:18800");
const page = await browser.contexts()[0].newPage();
try {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("http://127.0.0.1:5231/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(15000);
  if (await page.getByLabel("Your name").count()) {
    await page.getByLabel("Your name").fill("Sam Tester");
    await page.getByLabel("Worktable name").fill("Probe");
    await page.getByRole("button", { name: "Create Worktable" }).click();
    await page.waitForTimeout(5000);
    if (await page.getByRole("button", { name: "Skip for now" }).count()) await page.getByRole("button", { name: "Skip for now" }).click();
    await page.waitForTimeout(4000);
  }
  await page.evaluate(() => {
    window.__seen = [];
    document.addEventListener("click", (e) => window.__seen.push({ prevented: e.defaultPrevented, href: e.target.closest?.("a")?.href ?? null }));
    window.open = (u) => { window.__seen.push({ open: String(u) }); return null };
  });
  await page.locator('button[aria-label="Settings"], [aria-label*="ettings"]').first().click();
  await page.waitForTimeout(2000);
  await page.getByRole("button", { name: "Help" }).or(page.getByText("Help", { exact: true })).first().click();
  await page.waitForTimeout(1500);
  const popup = page.waitForEvent("popup", { timeout: 4000 }).then((p) => p.url()).catch(() => null);
  await page.getByText("Documentation", { exact: true }).click();
  console.log("popup:", await popup);
  console.log(JSON.stringify(await page.evaluate(() => window.__seen)));
} finally { await page.close(); await browser.close().catch(() => {}); }
