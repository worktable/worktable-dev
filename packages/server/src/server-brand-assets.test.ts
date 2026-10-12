import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BOOT_FACTS_MARKER } from "./boot-facts.ts"

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

/** Start a production server over a static build holding `files`. */
async function startProductionServer(
  files: Record<string, string | Uint8Array>
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "worktable-production-static-"))
  roots.push(root)
  const staticDir = join(root, "web")
  const workspaceDir = join(root, "workspace")
  const appDir = join(root, "app")
  await Promise.all([
    mkdir(staticDir, { recursive: true }),
    mkdir(workspaceDir, { recursive: true }),
    mkdir(appDir, { recursive: true }),
  ])
  await Promise.all(
    Object.entries(files).map(([name, bytes]) =>
      writeFile(join(staticDir, name), bytes)
    )
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
  return waitForServerUrl(child.stdout)
}

describe("production brand asset serving", () => {
  it("serves every PWA raster and the service worker retirement instead of the SPA shell", async () => {
    const iconNames = ["pwa-64x64.png", "pwa-192x192.png", "pwa-512x512.png"]
    const iconBytes = new TextEncoder().encode("canonical-brand-png")
    const serverUrl = await startProductionServer({
      "_shell.html": "<!doctype html>",
      ...Object.fromEntries(iconNames.map((name) => [name, iconBytes])),
    })
    for (const name of iconNames) {
      const response = await fetch(`${serverUrl}/${name}`)
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe("image/png")
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(iconBytes)
    }

    // Browsers that installed the retired service worker get one that
    // unregisters itself, never the page shell.
    const worker = await fetch(`${serverUrl}/sw.js`)
    expect(worker.headers.get("content-type")).toContain("text/javascript")
    expect(await worker.text()).toContain("registration.unregister()")
    const page = await fetch(`${serverUrl}/spaces/notes`)
    expect(page.headers.get("content-type")).toContain("text/html")
    expect(await page.text()).toBe("<!doctype html>")
  })
})

describe("production page shell", () => {
  it("writes a signed-in navigation's boot facts into a page it never stores, and serves anyone else the shared shell", async () => {
    const shell = `<!doctype html><html><head>${BOOT_FACTS_MARKER}</head><body></body></html>`
    const serverUrl = await startProductionServer({
      "_shell.html": shell,
      "build-id.txt": "build-1\n",
    })
    // Authored text must not be able to end the script element it rides in.
    const name = `Notes </script><script>alert(1)</script> ${String.fromCharCode(0x2028)} end`
    const renamed = await fetch(`${serverUrl}/api/workspace`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    })
    expect(renamed.status).toBe(200)
    const read = async (path: string) =>
      (
        await fetch(`${serverUrl}${path}`, {
          headers: { "Sec-Fetch-Site": "same-origin" },
        })
      ).json()
    const navigate = (site: string) =>
      fetch(`${serverUrl}/spaces/notes`, {
        headers: {
          "Sec-Fetch-Site": site,
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Dest": "document",
        },
      })

    const page = await navigate("none")
    expect(page.headers.get("cache-control")).toBe("private, no-store")
    expect(page.headers.get("vary")).toContain("Cookie")
    expect(page.headers.get("etag")).toBeNull()
    const html = await page.text()
    expect(html).not.toContain("</script><script>alert")
    expect(html).not.toContain(String.fromCharCode(0x2028))
    const facts = html.match(
      /<script id="worktable-boot" type="application\/json">(.*?)<\/script>/
    )?.[1]
    expect(JSON.parse(facts!)).toEqual({
      build: "build-1",
      storageUpgrade: await read("/api/workspace/storage-upgrade"),
      workspace: await read("/api/workspace"),
    })
    expect(JSON.parse(facts!).workspace.name).toBe(name)

    // Another site's navigation carries no ambient authority: it gets the
    // shared, revalidated shell with nothing filled in.
    const foreign = await navigate("cross-site")
    expect(await foreign.text()).toBe(shell)
    expect(foreign.headers.get("cache-control")).toBe("no-cache")
    expect(foreign.headers.get("etag")).toBeTruthy()
  })
})
