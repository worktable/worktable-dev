/**
 * Convert Markdown source to readable plain text for indexing and compact UI
 * excerpts. The function intentionally preserves content while removing the
 * syntax that would be noise outside a Markdown renderer.
 */
export function markdownPlainText(markdown: string): string {
  return markdown
    .replace(/^\s*```.*$/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*(?:>\s*)+/gm, "")
    .replace(/^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, "$1")
    .replace(/^\s*(?:[-*_]\s*){3,}$/gm, "")
    .replace(/^\s*\|?[-:| ]+\|[-:| ]*$/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\|/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__|~~|\*)/g, "")
    .replace(/(^|\s)_+([^_\s])/g, "$1$2")
    .replace(/([^_\s])_+(\s|$)/g, "$1$2")
    .replace(/<\/?[a-zA-Z][^>\n]*>/g, " ")
}
