import { readFileSync } from "node:fs"
import { join } from "node:path"

/** Packaging requires local fonts; development uses Fontshare for General Sans. */
export function verifyDesktopFonts(fontsRoot: string): void {
  for (const name of [
    "general-sans-variable.woff2",
    "fraunces-variable-latin.woff2",
    "jetbrains-mono-variable-latin.woff2",
  ]) {
    let bytes: Buffer
    try {
      bytes = readFileSync(join(fontsRoot, name))
    } catch {
      throw new Error(
        `Missing Desktop font ${name}. See apps/desktop/ui/fonts/README.md before packaging.`
      )
    }
    if (bytes.length <= 4 || bytes.subarray(0, 4).toString() !== "wOF2") {
      throw new Error(`Invalid Desktop WOFF2 font: ${name}`)
    }
  }
}

if (import.meta.main) {
  verifyDesktopFonts(join(import.meta.dir, "../ui/fonts"))
}
