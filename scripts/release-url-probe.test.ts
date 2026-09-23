import { expect, test } from "bun:test"
import { probeReleaseUrls } from "./release-url-probe"

test("probes with bounded concurrency, retrying transient failures without downloading archives", async () => {
  let active = 0
  let peak = 0
  const requests = new Map<string, number>()
  const delays: number[] = []
  await probeReleaseUrls(
    [
      "https://example.test/one",
      "https://example.test/two",
      "https://example.test/three",
    ],
    {
      concurrency: 2,
      attempts: 2,
      sleep: async (ms) => {
        delays.push(ms)
      },
      fetch: async (input, init) => {
        expect(init?.method).toBe("HEAD")
        active++
        peak = Math.max(peak, active)
        await Promise.resolve()
        active--
        const url = String(input)
        const count = (requests.get(url) ?? 0) + 1
        requests.set(url, count)
        return new Response(null, {
          status: url.endsWith("one") && count === 1 ? 503 : 200,
        })
      },
    }
  )
  expect(peak).toBe(2)
  expect(requests.get("https://example.test/one")).toBe(2)
  expect(delays).toEqual([8_000])
})

test("falls back to a bounded range when HEAD is unsupported and fails closed on broken routes", async () => {
  let range = ""
  await probeReleaseUrls(["https://example.test/archive"], {
    attempts: 1,
    fetch: async (_input, init) => {
      if (init?.method === "HEAD") return new Response(null, { status: 405 })
      range = new Headers(init?.headers).get("range") ?? ""
      return new Response("x", { status: 206 })
    },
  })
  expect(range).toBe("bytes=0-0")
  await expect(
    probeReleaseUrls(["https://example.test/missing"], {
      attempts: 1,
      fetch: async () =>
        new Response("Not an archive", {
          headers: { "content-type": "text/html" },
        }),
    })
  ).rejects.toThrow("did not become available")
})
