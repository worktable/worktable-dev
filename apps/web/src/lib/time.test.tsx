import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { formatDate, RelativeTime } from "./time"

test("relative timestamps keep an absolute date for server rendering and hover", () => {
  const iso = "2026-10-21T10:00:00.000Z"
  const date = formatDate(iso)
  expect(renderToStaticMarkup(<RelativeTime iso={iso} />)).toBe(
    `<span title="${date}">${date}</span>`
  )
})
