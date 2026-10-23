import { createElement, type ReactElement } from "react"
import Markdown, { defaultUrlTransform } from "react-markdown"
import rehypeRaw from "rehype-raw"
import remarkGfm from "remark-gfm"

const DATA_RASTER_IMAGE =
  /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/i

/**
 * A Markdown Doc as the app renders it, authored HTML included. For pages
 * rendered outside the app (public shares), which sanitize the result.
 * Images a shared page carries in itself keep their data URLs.
 */
export function markdownDocument(content: string): ReactElement {
  return createElement(Markdown, {
    remarkPlugins: [remarkGfm],
    rehypePlugins: [rehypeRaw],
    urlTransform: (url, key, node) =>
      key === "src" && node.tagName === "img" && DATA_RASTER_IMAGE.test(url)
        ? url
        : defaultUrlTransform(url),
    children: content,
  })
}
