import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export const PRODUCT_FONT_FILE = "general-sans-variable.woff2"
const licenseFile = "GeneralSans-LICENSE.txt"
export function readProductFontSource(fontsRoot: string) {
  let bytes: Buffer
  try {
    bytes = readFileSync(join(fontsRoot, PRODUCT_FONT_FILE))
  } catch {
    throw new Error(
      "Missing General Sans product font. Run bun scripts/provision-product-font.ts or supply apps/desktop/ui/fonts/general-sans-variable.woff2 as described in its README before assembling a release."
    )
  }
  if (bytes.length < 48 || bytes.subarray(0, 4).toString() !== "wOF2")
    throw new Error("Invalid General Sans product WOFF2 font")
  const license = readFileSync(join(fontsRoot, licenseFile))
  if (!license.includes(Buffer.from("ITF Free Font License")))
    throw new Error("Missing General Sans license notice")
  return {
    bytes,
    license,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }
}
export function stageProductFonts(fontsRoot: string, runtimeRoot: string) {
  const source = readProductFontSource(fontsRoot)
  const output = join(runtimeRoot, "fonts")
  mkdirSync(output, { recursive: true })
  writeFileSync(join(output, PRODUCT_FONT_FILE), source.bytes)
  writeFileSync(join(output, licenseFile), source.license)
  const manifest = {
    type: "worktable.product-fonts",
    version: 1,
    font: {
      file: PRODUCT_FONT_FILE,
      family: "General Sans",
      weight: "200 700",
      bytes: source.bytes.length,
      sha256: source.sha256,
      source: "https://www.fontshare.com/fonts/general-sans",
      license: licenseFile,
      licenseSha256: createHash("sha256").update(source.license).digest("hex"),
      licenseSource: "https://www.fontshare.com/licenses/itf-ffl",
    },
  }
  writeFileSync(
    join(output, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n"
  )
  return manifest
}

/** Release validation requires only shipped bytes, never a private source font. */
export function verifyPackagedProductFonts(runtimeRoot: string): void {
  const root = join(runtimeRoot, "fonts")
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"))
  if (
    manifest.type !== "worktable.product-fonts" ||
    manifest.version !== 1 ||
    manifest.font?.file !== PRODUCT_FONT_FILE ||
    manifest.font.license !== licenseFile ||
    manifest.font.family !== "General Sans" ||
    manifest.font.weight !== "200 700"
  )
    throw new Error("Invalid packaged product font manifest")
  const bytes = readFileSync(join(root, PRODUCT_FONT_FILE))
  const license = readFileSync(join(root, licenseFile))
  if (
    bytes.length < 48 ||
    bytes.subarray(0, 4).toString() !== "wOF2" ||
    bytes.length !== manifest.font.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== manifest.font.sha256
  )
    throw new Error("Packaged product font hash or size mismatch")
  if (
    !license.includes(Buffer.from("ITF Free Font License")) ||
    createHash("sha256").update(license).digest("hex") !==
      manifest.font.licenseSha256
  )
    throw new Error("Packaged product font license hash mismatch")
}

/** Desktop shell and its embedded server must render with the same supplied asset. */
export function verifyProductFontParity(
  fontsRoot: string,
  runtimeRoot: string
) {
  const source = readProductFontSource(fontsRoot)
  const manifest = JSON.parse(
    readFileSync(join(runtimeRoot, "fonts", "manifest.json"), "utf8")
  )
  const bundled = readFileSync(join(runtimeRoot, "fonts", PRODUCT_FONT_FILE))
  const bundledLicense = readFileSync(join(runtimeRoot, "fonts", licenseFile))
  if (
    !bundledLicense.equals(source.license) ||
    manifest.font?.license !== licenseFile
  )
    throw new Error("Packaged product font license is missing or mismatched")
  const hash = createHash("sha256").update(bundled).digest("hex")
  if (hash !== source.sha256 || manifest.font?.sha256 !== hash)
    throw new Error(
      "Desktop shell and packaged preview General Sans fonts differ; rebuild the runtime with the supplied font"
    )
  verifyPackagedProductFonts(runtimeRoot)
}
