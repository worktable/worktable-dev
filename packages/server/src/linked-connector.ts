import { createHash, randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { ensureAppDir } from "./app-storage.ts"
import { withCrossProcessLock } from "./cross-process-lock.ts"

const VERSION = "2026.9.1"
const ASSETS: Record<string, [string, string]> = {
  "linux-x64": [
    "cloudflared-linux-amd64",
    "03f1f25d1cc93b9ad6c60569d44060bc4f17ed97075760ed8cfca4b12dcd68cc",
  ],
  "linux-arm64": [
    "cloudflared-linux-arm64",
    "3d97437c71848bd8df68041e12436b484a661d95073ea1937f01a845ce88faa3",
  ],
  "darwin-x64": [
    "cloudflared-darwin-amd64.tgz",
    "ff0d3b51d5ff70eceef89d6b32145fee985018a2174596a5dbe405e2766e2ac4",
  ],
  "darwin-arm64": [
    "cloudflared-darwin-arm64.tgz",
    "c27ab8fd0aa489449e3d201eb02f957ef460a13b613662928b1b23394bf1bcfe",
  ],
  "win32-x64": [
    "cloudflared-windows-amd64.exe",
    "2837888cc0f5d58f15b6dc478376de90b4d3ba5241c7947455d1e0a0df429712",
  ],
}

/** Pinned official release; verify the archive before ever executing its contents. */
export async function linkedConnectorBinary(
  signal: AbortSignal
): Promise<string> {
  const asset = ASSETS[`${process.platform}-${process.arch}`]
  if (!asset) throw new Error("CONNECTOR_PLATFORM_UNSUPPORTED")
  const dir = join(
    ensureAppDir(),
    "connectors",
    VERSION,
    `${process.platform}-${process.arch}`
  )
  await mkdir(dir, { recursive: true, mode: 0o700 })
  return withCrossProcessLock(
    `${dir}.lock`,
    { label: "linked connector download" },
    async () => {
      signal.throwIfAborted()
      const archive = join(dir, asset[0])
      let bytes = await readFile(archive).catch(() => null)
      if (
        !bytes ||
        createHash("sha256").update(bytes).digest("hex") !== asset[1]
      ) {
        const response = await fetch(
          `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/${asset[0]}`,
          { signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) }
        )
        if (!response.ok) throw new Error("CONNECTOR_DOWNLOAD_FAILED")
        const reader = response.body?.getReader()
        if (!reader) throw new Error("CONNECTOR_DOWNLOAD_FAILED")
        const chunks: Uint8Array[] = []
        let size = 0
        try {
          for (;;) {
            const next = await reader.read()
            if (next.done) break
            size += next.value.byteLength
            if (size > 128 * 1024 * 1024)
              throw new Error("CONNECTOR_DOWNLOAD_TOO_LARGE")
            chunks.push(next.value)
          }
        } catch (error) {
          await reader.cancel().catch(() => undefined)
          throw error
        } finally {
          reader.releaseLock()
        }
        bytes = Buffer.concat(chunks)
        if (createHash("sha256").update(bytes).digest("hex") !== asset[1])
          throw new Error("CONNECTOR_CHECKSUM_FAILED")
        const temporary = `${archive}.${randomUUID()}.tmp`
        try {
          await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" })
          await rename(temporary, archive)
        } finally {
          await rm(temporary, { force: true })
        }
      }
      if (asset[0].endsWith(".tgz")) {
        const extraction = Bun.spawn(
          ["tar", "-xzf", archive, "-C", dir, "cloudflared"],
          { stdout: "ignore", stderr: "ignore" }
        )
        if ((await extraction.exited) !== 0)
          throw new Error("CONNECTOR_EXTRACTION_FAILED")
        const binary = join(dir, "cloudflared")
        await chmod(binary, 0o700)
        return binary
      }
      await chmod(archive, 0o700)
      return archive
    }
  )
}
