// Icons for the code block header, as SVG markup for renderers that are not
// React components (the editor's code block node view, the saved preview).
// Paths are Lucide's text-wrap, copy and check, the icons Markdown code uses.
const icon = (paths: string) =>
  // size-3.5 opts out of BlockNote's shadcn reset of unsized icons.
  `<svg class="size-3.5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`

export const WRAP_ICON = icon(
  '<path d="M3 5h18"/><path d="M3 12h14.5a1 1 0 0 1 0 7H13"/><path d="m16 16-3 3 3 3"/><path d="M3 19h6"/>'
)
export const COPY_ICON = icon(
  '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'
)
export const CHECK_ICON = icon('<path d="M20 6 9 17l-5-5"/>')
