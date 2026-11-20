import { expect, test } from "bun:test"
import { encode } from "uqr"
import {
  shareLinkQr,
  shareLinkQrFileName,
  shareLinkQrPath,
} from "./share-link-qr"

const LINK =
  "https://share.worktable.cloud/s/d-0123456789abcdef0123456789abcdef/icJQfl80qxBzECa00PU-tRUatJDEHS_Qp_V4Kke13wI"

test("a link's code draws exactly the squares its encoding has dark", () => {
  const qr = shareLinkQr(LINK)
  const drawn = Array.from({ length: qr.size }, () =>
    Array<boolean>(qr.size).fill(false)
  )
  for (const run of qr.runs)
    for (let x = run.x; x < run.x + run.length; x++) drawn[run.y]![x] = true
  expect(drawn).toEqual(encode(LINK, { ecc: "M", border: 0 }).data)
  // One closed box per run, nothing outside the view box.
  expect(shareLinkQrPath(qr).match(/M/g)).toHaveLength(qr.runs.length)
  expect(shareLinkQrPath(qr)).toStartWith("M0 0h7v1h-7z")
})

test("a shorter link in capitals makes a much coarser code", () => {
  expect(shareLinkQr(LINK).size).toBe(45)
  expect(
    shareLinkQr("HTTPS://SHARE.WORKTABLE.CLOUD/K7Q2/X4PTW8ZRNC").size
  ).toBe(29)
})

test("the picture is named for the document", () => {
  expect(shareLinkQrFileName("Worktable, Demo Night")).toBe(
    "Worktable-Demo-Night-qr.png"
  )
  expect(shareLinkQrFileName("Été à Zürich")).toBe("Été-à-Zürich-qr.png")
  expect(shareLinkQrFileName("  ")).toBe("share-link-qr.png")
  expect(shareLinkQrFileName(undefined)).toBe("share-link-qr.png")
})
