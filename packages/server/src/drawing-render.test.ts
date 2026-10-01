import { previewTest as test } from "./test-support/synthetic-preview.ts"
import { describe, expect } from "bun:test"
import sharp from "sharp"
import {
  emptyQuickdrawDocument,
  type QuickdrawDocument,
} from "@worktable/types"
import { renderDrawing } from "./drawing-render.ts"
import { drawingObjectBounds, type DrawingShape } from "./drawing-geometry.ts"

const base = { typeName: "shape" as const, x: 20, y: 20, rot: 0, z: 0 }
function board(...shapes: DrawingShape[]): QuickdrawDocument {
  const doc = emptyQuickdrawDocument("Synthetic preview")
  for (const shape of shapes) doc.snapshot.document.store[shape.id] = shape
  return doc
}
const box: DrawingShape = {
  ...base,
  id: "box",
  type: "geo",
  props: {
    geo: "rectangle",
    w: 200,
    h: 100,
    color: "blue",
    size: "m",
    dash: "solid",
    fill: "solid",
    font: "sans",
    label: "Browser → API",
  },
}

describe("headless drawing previews", () => {
  test("renders labeled geometry as visible PNG with bounded dimensions in both themes", async () => {
    const light = await renderDrawing(board(box), { width: 600 })
    const dark = await renderDrawing(board(box), { width: 600, theme: "dark" })
    const image = sharp(Buffer.from(light.data, "base64"))
    expect((await image.metadata()).width).toBe(600)
    const stats = await image.stats()
    expect(stats.channels.some((channel) => channel.stdev > 10)).toBe(true)
    expect(dark.data).not.toBe(light.data)
    const labeled = await renderDrawing(
      board({ ...box, id: "shape:long-stable-object-id" }),
      { format: "svg", labels: true }
    )
    expect(labeled.labels).toEqual([
      { label: "1", id: "shape:long-stable-object-id" },
    ])
    expect(Buffer.from(labeled.data, "base64").toString()).not.toContain(
      ">shape:long-stable-object-id</text>"
    )
    expect(light.rendererVersion).toContain("quickdraw")
    const textless = await renderDrawing(
      board({ ...box, props: { ...box.props, label: "" } }),
      { width: 600 }
    )
    expect(light.data).not.toBe(textless.data)
  })
  test("retains pressure outlines, curved arrow tangents, pattern fill, rotation, and selected-object crops", async () => {
    const doc = board(
      { ...box, rot: Math.PI / 4, props: { ...box.props, fill: "pattern" } },
      {
        ...base,
        id: "arrow",
        type: "arrow",
        x: 250,
        props: {
          dx: 200,
          dy: 0,
          bend: 80,
          color: "red",
          size: "m",
          dash: "dashed",
        },
      },
      {
        ...base,
        id: "ink",
        type: "draw",
        y: 200,
        props: {
          pts: [0, 0, 0.1, 30, 20, 0.2, 60, 10, 0.9, 100, 20, 1],
          color: "black",
          size: "xl",
          isPen: true,
        },
      },
      {
        ...base,
        id: "marker",
        type: "highlight",
        y: 260,
        props: { pts: [0, 0, 0.5, 100, 0, 0.5], color: "yellow", size: "m" },
      }
    )
    const svg = Buffer.from(
      (await renderDrawing(doc, { format: "svg" })).data,
      "base64"
    ).toString()
    expect(svg).toContain("rotate(45")
    expect(svg).toContain("Q100 160 200 0")
    expect(svg).toContain("url(#hatch-0)")
    expect(svg).toContain("mix-blend-mode:multiply")
    const changed = structuredClone(doc)
    const ink = changed.snapshot.document.store.ink as Extract<
      DrawingShape,
      { type: "draw" }
    >
    ink.props.pts = ink.props.pts.map((value, index) =>
      index % 3 === 2 ? 0.1 : value
    )
    expect((await renderDrawing(changed)).data).not.toBe(
      (await renderDrawing(doc)).data
    )
    const selected = await renderDrawing(doc, { ids: ["box"], format: "svg" })
    expect(Buffer.from(selected.data, "base64").toString()).not.toContain(
      'data-object-id="arrow"'
    )
    const bounds = drawingObjectBounds(
      doc.snapshot.document.store.box as DrawingShape
    )
    expect(bounds.w).toBeGreaterThan(200)
    expect(bounds.h).toBeGreaterThan(100)
  })
  test("includes embedded images and safely escapes labels without fetching resources", async () => {
    const doc = board(
      {
        ...base,
        id: "image",
        type: "image",
        props: { w: 100, h: 100, assetId: "asset" },
      },
      {
        ...box,
        id: "label",
        y: 140,
        props: { ...box.props, label: '<script>alert("x")</script>' },
      }
    )
    const png = await sharp({
      create: { width: 2, height: 2, channels: 4, background: "red" },
    })
      .png()
      .toBuffer()
    doc.snapshot.document.store.asset = {
      id: "asset",
      typeName: "asset",
      w: 2,
      h: 2,
      src: `data:image/png;base64,${png.toString("base64")}`,
    }
    const svg = Buffer.from(
      (await renderDrawing(doc, { format: "svg" })).data,
      "base64"
    ).toString()
    expect(svg).toContain('href="data:image/png;base64,')
    expect(svg).not.toContain("<script>")
    expect(svg).toContain("&lt;script&gt;")
    expect((await renderDrawing(doc)).mimeType).toBe("image/png")
    doc.snapshot.document.store.asset.src = "https://example.com/image.png"
    await expect(renderDrawing(doc)).rejects.toThrow(
      "Invalid drawing image asset"
    )
  })
  test("renders embedded PNG, JPEG, GIF and static WebP visibly", async () => {
    for (const format of ["png", "jpeg", "gif", "webp"] as const) {
      const doc = board({
        ...base,
        id: "image",
        type: "image",
        props: { w: 100, h: 100, assetId: "asset" },
      })
      const bytes = await sharp({
        create: { width: 20, height: 20, channels: 3, background: "red" },
      })
        [format]()
        .toBuffer()
      doc.snapshot.document.store.asset = {
        id: "asset",
        typeName: "asset",
        w: 20,
        h: 20,
        src: `data:image/${format};base64,${bytes.toString("base64")}`,
      }
      const png = await renderDrawing(doc)
      const stats = await sharp(Buffer.from(png.data, "base64")).stats()
      expect(stats.channels[1].stdev).toBeGreaterThan(30)
      if (format === "webp") {
        const svg = await renderDrawing(doc, { format: "svg" })
        expect(Buffer.from(svg.data, "base64").toString()).toContain(
          "data:image/webp;base64,"
        )
        // Conversion is preview-only; the original persisted asset is unchanged.
        expect(doc.snapshot.document.store.asset.src).toContain(
          "data:image/webp;base64,"
        )
        // A forged extended header must not bypass the decoded pixel budget.
        const extended = Buffer.alloc(18)
        extended.write("VP8X")
        extended.writeUInt32LE(10, 4)
        const forged = Buffer.concat([
          bytes.subarray(0, 12),
          extended,
          bytes.subarray(12),
        ])
        forged.writeUInt32LE(forged.length - 8, 4)
        doc.snapshot.document.store.asset.src = `data:image/webp;base64,${forged.toString("base64")}`
        await expect(renderDrawing(doc)).rejects.toThrow("decode drawing image")
      }
    }
  }, 60_000)
  test("keeps handwriting, serif and monospace distinct and renders mixed supported scripts", async () => {
    const outputs = []
    for (const font of ["draw", "sans", "serif", "mono"] as const) {
      const doc = board({
        ...base,
        id: "text",
        type: "text",
        props: {
          text: "Wide iii WWW café Ελληνικά Привет Tiếng Việt",
          font,
          size: "m",
          color: "black",
        },
      })
      const preview = await renderDrawing(doc, { width: 900 })
      outputs.push(preview.data)
      const stats = await sharp(Buffer.from(preview.data, "base64")).stats()
      expect(stats.channels[0].stdev).toBeGreaterThan(10)
      expect(
        preview.warnings?.some((warning) => warning.includes("unavailable")) ??
          false
      ).toBe(false)
      const svg = Buffer.from(
        (await renderDrawing(doc, { format: "svg" })).data,
        "base64"
      ).toString()
      expect(svg).toContain("Привет")
      expect(svg).toContain("data:font/woff;base64,")
    }
    expect(new Set(outputs).size).toBe(4)
    const multilingual = await renderDrawing(
      board({
        ...base,
        id: "text",
        type: "text",
        props: { text: "漢字 😀", font: "sans", size: "m", color: "black" },
      })
    )
    expect(
      multilingual.warnings?.some((warning) =>
        warning.includes("unavailable")
      ) ?? false
    ).toBe(false)
    // Loaded font faces can still paint blank glyphs. Isolate emoji so other
    // text or a shape background cannot make this pixel assertion pass.
    const emoji = await renderDrawing(
      board({
        ...base,
        id: "emoji",
        type: "text",
        props: {
          text: "😀 👩🏽‍💻 🚀 ✅",
          font: "sans",
          size: "xl",
          color: "black",
        },
      }),
      { background: false }
    )
    const { data, info } = await sharp(Buffer.from(emoji.data, "base64"))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    let colored = 0
    for (let i = 0; i < data.length; i += info.channels) {
      if (
        data[i + 3]! > 128 &&
        Math.max(data[i]!, data[i + 1]!, data[i + 2]!) -
          Math.min(data[i]!, data[i + 1]!, data[i + 2]!) >
          40
      )
        colored++
    }
    expect(colored).toBeGreaterThan(300)
  }, 60_000)
  test("rejects unbounded requests and unknown selections; transparent empty boards remain valid", async () => {
    await expect(renderDrawing(board(box), { width: 100000 })).rejects.toThrow(
      "width"
    )
    await expect(
      renderDrawing(board(box), { region: { x: 0, y: 0, w: 0, h: 10 } })
    ).rejects.toThrow("region")
    await expect(
      renderDrawing(board(box), { ids: ["missing"] })
    ).rejects.toThrow("not found")
    const result = await renderDrawing(board(), { background: false })
    expect(
      (await sharp(Buffer.from(result.data, "base64")).stats()).channels[3].max
    ).toBe(0)
  })
})
