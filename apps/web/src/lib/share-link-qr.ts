import { encode } from "uqr"

// A share link as a QR code. Drawn here, in the browser: the link is never
// sent anywhere to make its code.

/** The clear margin a scanner needs around a code, in squares. */
const QUIET_ZONE = 4

export interface ShareLinkQr {
  /** Squares across, without the margin. */
  size: number
  /** Each run of dark squares, by row. */
  runs: ReadonlyArray<{ x: number; y: number; length: number }>
}

export function shareLinkQr(url: string): ShareLinkQr {
  const { size, data } = encode(url, { ecc: "M", border: 0 })
  const runs: Array<{ x: number; y: number; length: number }> = []
  for (let y = 0; y < size; y++) {
    const row = data[y]!
    for (let x = 0; x < size; x++) {
      if (!row[x]) continue
      let length = 1
      while (x + length < size && row[x + length]) length++
      runs.push({ x, y, length })
      x += length - 1
    }
  }
  return { size, runs }
}

/** The dark squares as one SVG path, in a `size` by `size` view box. */
export function shareLinkQrPath(qr: ShareLinkQr): string {
  return qr.runs
    .map((run) => `M${run.x} ${run.y}h${run.length}v1h-${run.length}z`)
    .join("")
}

/**
 * The code as a PNG at least `width` pixels wide, black on white with its
 * margin, each square a whole number of pixels so its edges stay sharp.
 */
export function shareLinkQrPng(url: string, width = 1024): Promise<Blob> {
  const qr = shareLinkQr(url)
  const squares = qr.size + QUIET_ZONE * 2
  const scale = Math.ceil(width / squares)
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = squares * scale
  const context = canvas.getContext("2d")
  if (!context) return Promise.reject(new Error("Canvas is unavailable"))
  context.fillStyle = "#fff"
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = "#000"
  for (const run of qr.runs)
    context.fillRect(
      (run.x + QUIET_ZONE) * scale,
      (run.y + QUIET_ZONE) * scale,
      run.length * scale,
      scale
    )
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("Couldn’t draw the code")),
      "image/png"
    )
  )
}

/** "Launch plan" saves as "Launch-plan-qr.png". */
export function shareLinkQrFileName(title: string | undefined): string {
  const name = title
    ?.trim()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
  return `${name || "share-link"}-qr.png`
}
