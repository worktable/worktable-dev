import { authenticatedFetch } from "@/lib/http"

/** Text larger than this shows as a card with Download instead. */
export const PREVIEW_MAX_BYTES = 5 * 1024 * 1024

/** The query that reads a file's text for its page, by the file's address. */
export function filePreviewTextKey(url: string) {
  return ["file-preview", url] as const
}

/** The file's text, or null once it passes the preview limit. */
export async function readPreviewText(url: string): Promise<string | null> {
  const response = await authenticatedFetch(url)
  if (!response.ok) throw new Error(`File read failed: ${response.status}`)
  const length = Number(response.headers.get("content-length") ?? "0")
  if (length > PREVIEW_MAX_BYTES) return null
  // Without a length to trust, read only as far as the limit.
  const reader = response.body?.getReader()
  if (!reader) return response.text()
  const decoder = new TextDecoder()
  let text = ""
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text + decoder.decode()
    bytes += value.byteLength
    if (bytes > PREVIEW_MAX_BYTES) {
      await reader.cancel()
      return null
    }
    text += decoder.decode(value, { stream: true })
  }
}
