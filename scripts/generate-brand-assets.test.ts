import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import sharp from "sharp"
import targets from "./generation-targets.json"

import {
  extractPngFromIco,
  generatedBrandBinaryOutputs,
  generatedBrandRasterSpecs,
  generatedBrandTextOutputs,
} from "./generate-brand-assets"

const repoRoot = resolve(import.meta.dir, "..")
const faviconCopies = targets.favicons

async function decodeRgba(buffer: Buffer) {
  return sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
}

describe("brand asset generation", () => {
  test("committed text artifacts exactly match their generated output", async () => {
    for (const [relativePath, expected] of generatedBrandTextOutputs) {
      expect(await readFile(resolve(repoRoot, relativePath), "utf8")).toBe(
        expected
      )
    }
  })

  test("every favicon consumer receives the canonical filled SVG byte-for-byte", async () => {
    const canonical = await readFile(
      resolve(repoRoot, "assets/brand/worktable-icon-filled.svg")
    )
    for (const relativePath of faviconCopies) {
      expect(
        (await readFile(resolve(repoRoot, relativePath))).equals(canonical)
      ).toBe(true)
    }
  })

  test("committed PNG and ICO pixels exactly match fresh renders", async () => {
    for (const [
      relativePath,
      generatedFile,
    ] of await generatedBrandBinaryOutputs()) {
      const committedFile = await readFile(resolve(repoRoot, relativePath))
      const committedPng = relativePath.endsWith(".ico")
        ? extractPngFromIco(committedFile)
        : committedFile
      const generatedPng = relativePath.endsWith(".ico")
        ? extractPngFromIco(generatedFile)
        : generatedFile
      const [committed, generated] = await Promise.all([
        decodeRgba(committedPng),
        decodeRgba(generatedPng),
      ])
      expect(committed.info.width).toBe(generated.info.width)
      expect(committed.info.height).toBe(generated.info.height)
      expect(committed.data.equals(generated.data)).toBe(true)
    }
  })

  test("raster dimensions match their public file contracts", async () => {
    for (const spec of generatedBrandRasterSpecs) {
      const metadata = await sharp(
        await readFile(resolve(repoRoot, spec.path))
      ).metadata()
      expect(metadata.width).toBe(spec.size)
      expect(metadata.height).toBe(spec.size)
    }
  })

  test("favicon.ico contains one 48px 32-bit PNG entry", async () => {
    const ico = await readFile(resolve(repoRoot, "apps/web/public/favicon.ico"))
    expect(ico.readUInt16LE(0)).toBe(0)
    expect(ico.readUInt16LE(2)).toBe(1)
    expect(ico.readUInt16LE(4)).toBe(1)
    expect(ico.readUInt8(6)).toBe(48)
    expect(ico.readUInt8(7)).toBe(48)
    expect(ico.readUInt16LE(10)).toBe(1)
    expect(ico.readUInt16LE(12)).toBe(32)
    expect(extractPngFromIco(ico).subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    )
  })
})
