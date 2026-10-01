import { createHash, randomUUID } from "node:crypto"
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { PRODUCT_FONT_FILE } from "./product-fonts.ts"

// Reviewed, unmodified variable font from the official Fontshare CSS endpoint.
// Update URL and digest together when intentionally updating the product font.
export const PRODUCT_FONT_DOWNLOAD =
  "https://cdn.fontshare.com/wf/LHQJ5KSAL7VGAEIDSTEXCCOIUKFLT2I6/GW57XUEG4ZBVMLZZTQZTGYPROITRRQ5W/JA3IZUEMJ2J6WWT2OQVJOAWDXO3YL4YG.woff2"
export const PRODUCT_FONT_SHA256 =
  "49d3fbd2f1bcc9850d8d939cabf107d6ade508ce08419fca466b06879e4a0a8e"
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex")

/** Explicit build-time command only. Rendering and release assembly never fetch fonts. */
export async function provisionProductFont(
  fontsRoot: string,
  download: typeof fetch = fetch
): Promise<void> {
  const destination = join(fontsRoot, PRODUCT_FONT_FILE)
  const verifyExisting = () => {
    if (digest(readFileSync(destination)) !== PRODUCT_FONT_SHA256)
      throw new Error(
        "Existing General Sans differs from the pinned build asset; it was not replaced. Keep a separately supplied version for manual packaging, or remove it before provisioning the pinned version."
      )
  }
  if (existsSync(destination)) {
    verifyExisting()
    return
  }
  const response = await download(PRODUCT_FONT_DOWNLOAD, {
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  })
  if (!response.ok || !response.body)
    throw new Error(
      `Fontshare product font download failed: HTTP ${response.status}`
    )
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 1_048_576)
        throw new Error("Product font download exceeds its size limit")
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const bytes = Buffer.concat(chunks)
  if (digest(bytes) !== PRODUCT_FONT_SHA256)
    throw new Error(
      "Fontshare product font digest does not match the pinned build asset"
    )
  mkdirSync(fontsRoot, { recursive: true })
  const temporary = join(fontsRoot, `.${PRODUCT_FONT_FILE}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, bytes, { flag: "wx", mode: 0o644 })
    // Atomic publication without overwriting another provisioner or supplied file.
    try {
      linkSync(temporary, destination)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      verifyExisting()
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

if (import.meta.main) {
  await provisionProductFont(
    fileURLToPath(new URL("../apps/desktop/ui/fonts", import.meta.url))
  )
  console.log(`Verified ${PRODUCT_FONT_FILE} (${PRODUCT_FONT_SHA256})`)
}
