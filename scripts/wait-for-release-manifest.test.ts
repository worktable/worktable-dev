import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"

const servers: ReturnType<typeof Bun.serve>[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)))
})

describe("wait for release manifest", () => {
  test("rejects failed and invalid responses before accepting the expected version", async () => {
    let requests = 0
    const server = Bun.serve({
      port: 0,
      fetch() {
        requests += 1
        if (requests === 1) {
          return new Response("temporarily unavailable", { status: 503 })
        }
        if (requests === 2) {
          return new Response('{"version":"0.0.40"', {
            headers: { "content-type": "application/json" },
          })
        }
        if (requests === 3) {
          return Response.json({ version: "0.0.39" })
        }
        return Response.json({ version: "0.0.40" })
      },
    })
    servers.push(server)

    const process = Bun.spawn(
      [
        "sh",
        "scripts/wait-for-release-manifest.sh",
        `http://127.0.0.1:${server.port}/manifest.json`,
        "v0.0.40",
      ],
      {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...Bun.env,
          WORKTABLE_RELEASE_MANIFEST_ATTEMPTS: "4",
          WORKTABLE_RELEASE_MANIFEST_DELAY: "0",
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    )

    const [exitCode, stdout] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
    ])

    expect(exitCode).toBe(0)
    expect(requests).toBe(4)
    expect(stdout).toContain("OK: latest manifest reports 0.0.40")
  })
})
