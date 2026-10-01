import { test, expect } from "bun:test"
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createProductFontResolver } from "./product-fonts.ts"
import {
  stageProductFonts,
  verifyProductFontParity,
} from "../../../scripts/product-fonts.ts"

test("trusted product fonts have optional development fallback and verified packaged identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "worktable-product-fonts-"))
  try {
    const source = join(root, "source"),
      runtime = join(root, "runtime")
    mkdirSync(source)
    const resolver = createProductFontResolver(() => ({
      root: source,
      packaged: false,
    }))
    expect(resolver.productFontAssets()).toEqual([])
    expect(resolver.productFontVersion()).toBe("unavailable")
    expect(resolver.productFontIssue()).toContain("not installed")
    const incomplete = createProductFontResolver(() => ({
      root: source,
      packaged: true,
    }))
    expect(incomplete.productFontAssets()).toEqual([])
    expect(incomplete.productFontIssue()).toContain("missing")
    expect(await resolver.fulfillProductFont("../package.json")).toBeNull()
    expect(() => stageProductFonts(source, runtime)).toThrow(
      "Missing General Sans"
    )
    // Test packaging with an existing open-licensed font, without requiring the
    // separately supplied General Sans binary in public source or test runners.
    const fonts = fileURLToPath(
      new URL("../../../apps/desktop/ui/fonts", import.meta.url)
    )
    copyFileSync(
      join(fonts, "fraunces-variable-latin.woff2"),
      join(source, "general-sans-variable.woff2")
    )
    copyFileSync(
      join(fonts, "GeneralSans-LICENSE.txt"),
      join(source, "GeneralSans-LICENSE.txt")
    )
    const staged = stageProductFonts(source, runtime)
    const packaged = createProductFontResolver(() => ({
      root: join(runtime, "fonts"),
      packaged: true,
    }))
    expect(packaged.productFontVersion()).toBe(resolver.productFontVersion())
    expect(packaged.productFontVersion()).toBe(staged.font.sha256)
    expect(packaged.productFontAssets()[0]!.url).toContain(staged.font.sha256)
    expect(await packaged.fulfillProductFont(staged.font.file)).toEqual(
      await resolver.fulfillProductFont(staged.font.file)
    )
    expect(() => verifyProductFontParity(source, runtime)).not.toThrow()
    const bundled = join(runtime, "fonts", staged.font.file)
    writeFileSync(
      bundled,
      Buffer.concat([readFileSync(bundled), Buffer.from("changed")])
    )
    expect(packaged.productFontVersion()).toBe("unavailable")
    expect(packaged.productFontAssets()).toEqual([])
    expect(await packaged.fulfillProductFont(staged.font.file)).toBeNull()
    expect(packaged.productFontIssue()).toContain("does not match")
    expect(() => verifyProductFontParity(source, runtime)).toThrow(
      "fonts differ"
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
