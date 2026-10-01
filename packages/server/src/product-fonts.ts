import { createHash } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { DrawingFontAsset } from "@worktable/ui/lib/drawing-fonts"

const filename = "general-sans-variable.woff2"
function defaultLocation() {
  const release = process.env.WORKTABLE_RELEASE_DIR
  const sibling = join(dirname(process.execPath), "..", "preview-runtime")
  if (release || existsSync(sibling))
    return {
      root: release
        ? join(release, "preview-runtime", "fonts")
        : join(sibling, "fonts"),
      packaged: true,
    }
  return {
    root: fileURLToPath(
      new URL("../../../apps/desktop/ui/fonts", import.meta.url)
    ),
    packaged: false,
  }
}

/** Only trusted application assets are resolved; document input never supplies
 * filesystem paths. An absent optional development asset uses the shared fallback. */
export function createProductFontResolver(
  location: () => { root: string; packaged: boolean } = defaultLocation
) {
  let cached: { identity: string; bytes: Buffer; hash: string } | undefined
  function resolve() {
    const { root, packaged } = location()
    const path = join(root, filename)
    let identity: string
    try {
      const stat = statSync(path)
      identity = `${path}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
      if (packaged) {
        const manifestStat = statSync(join(root, "manifest.json"))
        identity += `:${manifestStat.ino}:${manifestStat.size}:${manifestStat.mtimeMs}:${manifestStat.ctimeMs}`
      }
    } catch (error) {
      if (!packaged && (error as NodeJS.ErrnoException).code === "ENOENT") {
        cached = undefined
        return null
      }
      throw new Error(
        "Worktable product font is missing from this installation"
      )
    }
    if (cached?.identity === identity) return cached
    const bytes = readFileSync(path)
    if (bytes.length < 48 || bytes.subarray(0, 4).toString() !== "wOF2")
      throw new Error("Invalid Worktable product font")
    const hash = createHash("sha256").update(bytes).digest("hex")
    if (packaged) {
      const manifest = JSON.parse(
        readFileSync(join(root, "manifest.json"), "utf8")
      )
      if (
        manifest.type !== "worktable.product-fonts" ||
        manifest.version !== 1 ||
        manifest.font?.file !== filename ||
        manifest.font.sha256 !== hash
      )
        throw new Error(
          "Worktable product font does not match its installation manifest"
        )
    }
    return (cached = { identity, bytes, hash })
  }
  function available() {
    try {
      return { asset: resolve(), issue: undefined as string | undefined }
    } catch (error) {
      cached = undefined
      return {
        asset: null,
        issue:
          error instanceof Error
            ? error.message
            : "Worktable product font is unavailable",
      }
    }
  }
  return {
    productFontAssets(): DrawingFontAsset[] {
      const { asset } = available()
      return asset
        ? [
            {
              id: filename,
              family: "General Sans",
              weight: "200 700",
              unicodeRange: "U+0-10FFFF",
              url: `/worktable-preview/fonts/${filename}?v=${asset.hash}`,
            },
          ]
        : []
    },
    async fulfillProductFont(id: string): Promise<Uint8Array | null> {
      if (id !== filename) return null
      const { asset } = available()
      return asset ? new Uint8Array(asset.bytes) : null
    },
    productFontVersion(): string {
      return available().asset?.hash ?? "unavailable"
    },
    productFontIssue(): string | undefined {
      const { asset, issue } = available()
      return (
        issue ??
        (asset
          ? undefined
          : "General Sans is not installed; fallback fonts are in use")
      )
    },
  }
}
const resolver = createProductFontResolver()
export const {
  productFontAssets,
  fulfillProductFont,
  productFontVersion,
  productFontIssue,
} = resolver
