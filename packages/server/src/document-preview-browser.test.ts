import { describe, expect, test } from "bun:test"
import type { Browser, BrowserServer, Page } from "playwright-core"
import { PreviewBrowserPool } from "./document-preview-browser"

function fakeWorkers() {
  const events: string[] = []
  let contexts = 0
  return {
    events,
    launch: async (kind: string) => {
      events.push(`launch:${kind}`)
      let connected = true
      return {
        server: {
          kill: async () => {
            connected = false
            events.push(`kill:${kind}`)
          },
        } as unknown as BrowserServer,
        browser: {
          isConnected: () => connected,
          close: async () => {},
          newContext: async (options: Record<string, unknown>) => {
            expect(options.serviceWorkers).toBe("allow")
            expect(options.acceptDownloads).toBe(false)
            const id = ++contexts
            events.push(`context:${id}`)
            return {
              route: async (
                _pattern: string,
                handler: (route: { abort: (reason: string) => void }) => void
              ) =>
                handler({
                  abort: (reason) => {
                    expect(reason).toBe("blockedbyclient")
                  },
                }),
              routeWebSocket: async (
                _pattern: string,
                handler: (socket: { close: () => void }) => void
              ) =>
                handler({
                  close: () => {
                    events.push("socket-blocked")
                  },
                }),
              addInitScript: async () => {},
              on: () => {},
              newPage: async () =>
                ({
                  id,
                  setDefaultTimeout: () => {},
                  setDefaultNavigationTimeout: () => {},
                  on: () => {},
                }) as unknown as Page,
              close: async () => {
                await delay(2)
                events.push(`closed:${id}`)
              },
            }
          },
        } as unknown as Browser,
      }
    },
  }
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("isolated preview browser lifecycle", () => {
  test("reuses only same-kind processes with fresh contexts and disposes failures", async () => {
    const fake = fakeWorkers()
    const pool = new PreviewBrowserPool({ launch: fake.launch })
    await pool.run("drawing", async () => "first")
    expect(fake.events).toContain("closed:1")
    await expect(
      pool.run("drawing", async () => {
        throw new Error("bad source")
      })
    ).rejects.toThrow("bad source")
    expect(fake.events).toContain("closed:2")
    await pool.run("html", async () => "html")
    await delay(0)
    expect(fake.events.filter((e) => e.startsWith("launch:"))).toEqual([
      "launch:drawing",
      "launch:html",
    ])
    expect(fake.events.filter((e) => e.startsWith("closed:"))).toHaveLength(3)
    await pool.close()
    expect(fake.events.filter((e) => e.startsWith("kill:"))).toHaveLength(2)
  })

  test("bounds admission, cancels hung tasks, kills worker and allows queued recovery", async () => {
    const fake = fakeWorkers()
    const pool = new PreviewBrowserPool({
      launch: fake.launch,
      deadlineMs: 500,
      queueLimit: 1,
    })
    const controller = new AbortController()
    const first = pool.run("html", async () => new Promise<never>(() => {}), {
      signal: controller.signal,
    })
    const firstRejection = first.catch((error) => error)
    await delay(5)
    const next = pool.run("html", async () => "recovered")
    await expect(
      pool.run("drawing", async () => "overflow")
    ).rejects.toMatchObject({ code: "PREVIEW_BUSY" })
    controller.abort()
    expect(await firstRejection).toMatchObject({ code: "PREVIEW_CANCELLED" })
    expect(await next).toBe("recovered")
    expect(fake.events.filter((e) => e === "launch:html")).toHaveLength(2)
    await pool.close()
  })

  test("deadline includes queue wait and idle workers stop", async () => {
    const fake = fakeWorkers()
    const pool = new PreviewBrowserPool({
      launch: fake.launch,
      deadlineMs: 15,
      idleMs: 5,
    })
    await expect(
      pool.run("drawing", async () => new Promise<never>(() => {}))
    ).rejects.toMatchObject({ code: "PREVIEW_TIMEOUT" })
    await pool.run("drawing", async () => "ok")
    await delay(15)
    expect(fake.events.filter((e) => e === "kill:drawing")).toHaveLength(2)
    await pool.close()
  })
  test("deadline cancels stalled context setup and cleanup, then recovers with a new worker", async () => {
    const fake = fakeWorkers()
    let launches = 0
    const pool = new PreviewBrowserPool({
      deadlineMs: 100,
      launch: async (kind) => {
        const worker = await fake.launch(kind)
        const attempt = ++launches
        const newContext = worker.browser.newContext.bind(worker.browser)
        worker.browser.newContext = async (options) => {
          if (attempt === 1) return new Promise(() => {})
          const context = await newContext(options)
          if (attempt === 2) context.close = () => new Promise(() => {})
          return context
        }
        return worker
      },
    })
    for (let attempt = 0; attempt < 2; attempt++) {
      const error = await pool
        .run("drawing", async () => "result", {
          signal: AbortSignal.timeout(80),
        })
        .catch((error) => error)
      expect(error.code).toBe("PREVIEW_TIMEOUT")
    }
    expect(await pool.run("drawing", async () => "recovered")).toBe("recovered")
    expect(launches).toBe(3)
    await pool.close()
  })

  test("shutdown drains an in-flight launch and rejects queued work", async () => {
    const fake = fakeWorkers()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const pool = new PreviewBrowserPool({
      launch: async (kind) => {
        await gate
        return fake.launch(kind)
      },
    })
    const running = pool
      .run("html", async () => "must not run")
      .catch((error) => error)
    const queued = pool
      .run("drawing", async () => "must not run")
      .catch((error) => error)
    const stopping = pool.close()
    release()
    await stopping
    expect(await running).toMatchObject({ code: "PREVIEW_CANCELLED" })
    expect(await queued).toMatchObject({ code: "PREVIEW_CANCELLED" })
    expect(fake.events).toEqual(["launch:html", "kill:html"])
    await expect(
      pool.run("drawing", async () => "later")
    ).rejects.toMatchObject({ code: "PREVIEW_CANCELLED" })
  })
})
