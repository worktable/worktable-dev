/** Cheap test for authored HTML, so most Markdown Docs never load a parser. */
export function containsHtml(markdown: string): boolean {
  return /<\/?[a-z][\w-]*[\s/>]/i.test(markdown)
}
