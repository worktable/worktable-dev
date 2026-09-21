export function parseRustHostTuple(verbose: string): string | null {
  return verbose.match(/^host:\s+(\S+)$/m)?.[1] ?? null
}

export function resolveRustHostTuple(): string {
  const direct = Bun.spawnSync(["rustc", "--print", "host-tuple"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (direct.success) return direct.stdout.toString().trim()

  const verbose = Bun.spawnSync(["rustc", "-Vv"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (!verbose.success) {
    throw new Error(
      `rustc host lookup failed: ${verbose.stderr.toString().trim()}`
    )
  }

  const hostTuple = parseRustHostTuple(verbose.stdout.toString())
  if (!hostTuple) throw new Error("rustc -Vv did not report a host tuple")
  return hostTuple
}
