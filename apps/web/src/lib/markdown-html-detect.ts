/**
 * Cheap test for authored HTML, so most Markdown Docs never load a parser.
 * Tags shown inside code are not HTML.
 */
export function containsHtml(markdown: string): boolean {
  const prose = markdown
    .replace(/^(\s*)(`{3,}|~{3,})[\s\S]*?^\1\2[^\n]*$/gm, "")
    .replace(/`[^`\n]*`/g, "")
  return /<\/?[a-z][\w-]*[\s/>]/i.test(prose)
}
