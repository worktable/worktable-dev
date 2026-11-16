/**
 * Help loads only where it's on, from a lazy import in its wrappers
 * (src/components/help/help.tsx) and Home's Next Steps. Left to itself,
 * Rollup splits the parts those share into a file each, so a page opened
 * cold fetches ten small help files. Keep them in one.
 *
 * Only modules no page imports up front belong here: one that a page does
 * import would put this whole chunk on that page.
 */
const HELP_MODULES = [
  /\/apps\/web\/src\/lib\/help\/(?:registry|rules|state|fill|settings-help|try-next|welcome-content)\.ts$/,
  /\/apps\/web\/src\/components\/help\/help-tip\.tsx$/,
  /\/apps\/web\/src\/components\/home\/try-next\.tsx$/,
  /\/packages\/ui\/src\/components\/help-band\.tsx$/,
]

export function helpChunk(id: string): string | undefined {
  return HELP_MODULES.some((pattern) => pattern.test(id)) ? "help" : undefined
}
