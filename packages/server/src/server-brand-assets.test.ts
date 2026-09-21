import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const children: Array<ReturnType<typeof Bun.spawn>> = []
const roots: string[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill()
    await child.exited
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

async function waitForServerUrl(
  stdout: ReadableStream<Uint8Array>
): Promise<string> {
  const reader = stdout.getReader()
  const decoder = new TextDecoder()
  let output = ""

  return await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      void reader.cancel()
      reject(new Error(`server did not start:\n${output}`))
    }, 10_000)

    const read = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) throw new Error(`server exited before startup:\n${output}`)
          output += decoder.decode(value, { stream: true })
          const match = output.match(
            /\[Worktable server\] running on (http:\/\/127\.0\.0\.1:\d+)/
          )
          if (match?.[1]) {
            clearTimeout(timeout)
            resolve(match[1])
            return
          }
        }
      } catch (error) {
        clearTimeout(timeout)
        reject(error)
      }
    }

    void read()
  })
}

describe("production brand asset serving", () => {
  it("serves every PWA raster as an image instead of the SPA shell", async () => {
    const root = await mkdtemp(join(tmpdir(), "worktable-brand-static-"))
    roots.push(root)
    const staticDir = join(root, "web")
    const workspaceDir = join(root, "workspace")
    const appDir = join(root, "app")
    await Promise.all([
      mkdir(staticDir, { recursive: true }),
      mkdir(workspaceDir, { recursive: true }),
      mkdir(appDir, { recursive: true }),
    ])
    await writeFile(join(staticDir, "_shell.html"), "<!doctype html>")

    const iconNames = ["pwa-64x64.png", "pwa-192x192.png", "pwa-512x512.png"]
    const iconBytes = new TextEncoder().encode("canonical-brand-png")
    await Promise.all(
      iconNames.map((name) => writeFile(join(staticDir, name), iconBytes))
    )

    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "index.ts")],
      {
        env: {
          ...process.env,
          HOST: "127.0.0.1",
          PORT: "0",
          WORKTABLE_APP_DIR: appDir,
          WORKTABLE_STATIC_DIR: staticDir,
          WORKTABLE_WORKSPACE: workspaceDir,
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    )
    children.push(child)

    const serverUrl = await waitForServerUrl(child.stdout)
    for (const name of iconNames) {
      const response = await fetch(`${serverUrl}/${name}`)
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe("image/png")
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(iconBytes)
    }
  })
})
