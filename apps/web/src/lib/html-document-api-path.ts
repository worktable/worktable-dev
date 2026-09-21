function base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")
}

/** Collision-free route for the specialized HTML compatibility API. */
export function htmlDocumentApiPath(spaceId: string, path: string): string {
  return `/api/spaces/${encodeURIComponent(spaceId)}/widgets/__document/${base64Url(path)}`
}
