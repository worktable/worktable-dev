import { createElement, type ReactElement } from "react"
import Markdown from "react-markdown"
import rehypeRaw from "rehype-raw"
import remarkGfm from "remark-gfm"

/**
 * A Markdown Doc as the app renders it, authored HTML included. For pages
 * rendered outside the app (public shares), which sanitize the result.
 */
export function markdownDocument(content: string): ReactElement {
  return createElement(Markdown, {
    remarkPlugins: [remarkGfm],
    rehypePlugins: [rehypeRaw],
    children: content,
  })
}
