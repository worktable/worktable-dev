export function documentSourceDisposition(fileName: string): string {
  const fallback =
    fileName.replace(/[^\x20-\x7e]|["\\]/g, "_") || "document.bin"
  const encoded = encodeURIComponent(fileName).replace(
    /[!'()*]/g,
    (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`
  )
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
}
