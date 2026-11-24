import { expect, test } from "bun:test"
import { frameImages } from "./frame-images"

const picture = (src: string) => ({ src, alt: "Harbor", width: 120, height: 80 })

test("a page opens only the images it shows, never an address it names", () => {
  expect(
    frameImages({ images: [picture("data:image/png;base64,AAAA")], index: 0 })
  ).toEqual({
    images: [
      {
        src: "data:image/png;base64,AAAA",
        alt: "Harbor",
        size: { width: 120, height: 80 },
      },
    ],
    index: 0,
  })
  for (const src of [
    "https://example.com/track.png",
    "/api/spaces/team/files/raw?path=secret.png",
    "blob:null/1234",
    "data:text/html,<p>hi</p>",
  ])
    expect(frameImages({ images: [picture(src)], index: 0 })).toBeNull()
  expect(
    frameImages({ images: [picture("data:image/png;base64,AAAA")], index: 1 })
  ).toBeNull()
})
