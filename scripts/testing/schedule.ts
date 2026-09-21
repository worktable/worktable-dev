interface NamedSuite {
  id: string
}

const portableCompanions = new Set([
  "bun-standard",
  "cli-boundary",
  "packaged-boundaries",
  "control-plane",
  "gateway-bun",
  "gateway-worker",
])

// Portable lanes already own separate processes and temporary state. Keep the
// long server lane busy alongside one sequential companion pipeline. Browser,
// desktop, host, and unknown future lanes retain exclusive execution.
export async function runSuiteSchedule<T extends NamedSuite>(
  selected: T[],
  execute: (suite: T, signal: AbortSignal, fail: () => void) => Promise<boolean>
): Promise<boolean> {
  const server = selected.filter((suite) => suite.id === "bun-server")
  const companions = selected.filter((suite) =>
    portableCompanions.has(suite.id)
  )
  const portable = new Set([...server, ...companions])
  let scheduledPortable = false
  let failed = false
  const cancellation = new AbortController()
  function fail() {
    failed = true
    cancellation.abort()
  }
  async function pipeline(suites: T[]): Promise<void> {
    for (const suite of suites) {
      if (failed) return
      try {
        if (await execute(suite, cancellation.signal, fail)) fail()
      } catch (error) {
        fail()
        throw error
      }
    }
  }
  for (const suite of selected) {
    if (failed) break
    if (!portable.has(suite)) {
      await pipeline([suite])
      continue
    }
    if (scheduledPortable) continue
    scheduledPortable = true
    const results = await Promise.allSettled([
      pipeline(server),
      pipeline(companions),
    ])
    const rejected = results.find((result) => result.status === "rejected")
    if (rejected?.status === "rejected") throw rejected.reason
  }
  return failed
}
