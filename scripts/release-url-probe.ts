export interface ProbeOptions {
  attempts?: number
  delayMs?: number
  timeoutMs?: number
  concurrency?: number
  fetch?: (input: string, init?: RequestInit) => Promise<Response>
  sleep?: (ms: number) => Promise<unknown>
}

/** Probe routing/availability only. Byte integrity and installs have separate owners. */
export async function probeReleaseUrls(
  urls: string[],
  options: ProbeOptions = {}
): Promise<void> {
  const request = options.fetch ?? fetch
  const sleep = options.sleep ?? ((ms) => Bun.sleep(ms))
  const attempts = options.attempts ?? 8
  const delayMs = options.delayMs ?? 8_000
  const timeoutMs = options.timeoutMs ?? 15_000
  const concurrency = options.concurrency ?? 4
  if (
    !Number.isInteger(attempts) ||
    attempts < 1 ||
    !Number.isInteger(concurrency) ||
    concurrency < 1
  )
    throw new Error("Invalid probe budget")
  let next = 0
  const failures: string[] = []
  async function worker(): Promise<void> {
    while (next < urls.length) {
      const url = urls[next++]!
      let healthy = false
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          let response = await request(url, {
            method: "HEAD",
            redirect: "follow",
            signal: AbortSignal.timeout(timeoutMs),
          })
          // Some storage proxies reject HEAD but still support range reads.
          if (response.status === 405 || response.status === 501) {
            await response.body?.cancel()
            response = await request(url, {
              headers: { Range: "bytes=0-0" },
              redirect: "follow",
              signal: AbortSignal.timeout(timeoutMs),
            })
          }
          healthy =
            response.ok &&
            !response.headers.get("content-type")?.includes("text/html") &&
            response.headers.get("content-length") !== "0"
          await response.body?.cancel()
          if (healthy) break
        } catch {
          /* A transient network/edge error uses the same bounded budget. */
        }
        if (attempt < attempts) await sleep(delayMs)
      }
      if (!healthy) failures.push(url)
      else console.log(`OK: ${url}`)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, urls.length) }, worker)
  )
  if (failures.length)
    throw new Error(
      `Public release URLs did not become available: ${failures.join(", ")}`
    )
}

if (import.meta.main) {
  const [base, ...artifacts] = process.argv.slice(2)
  if (
    !base?.startsWith("https://") ||
    !artifacts.length ||
    artifacts.some((name) => !/^[a-zA-Z0-9._-]+$/.test(name))
  )
    throw new Error("Usage: release-url-probe.ts <https-base> <artifact...>")
  await probeReleaseUrls(
    artifacts.map((name) => `${base.replace(/\/$/, "")}/${name}`)
  )
}
