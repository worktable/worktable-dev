import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import sharp from "sharp"

import {
  extractPngFromIco,
  generatedBrandRasterSpecs,
} from "./generate-brand-assets"

const repoRoot = resolve(import.meta.dir, "..")

describe("brand asset generation", () => {
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
