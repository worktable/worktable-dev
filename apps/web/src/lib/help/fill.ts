/** A help line with its {placeholders} filled in; unknown ones stay as they are. */
export function fillTip(text: string, values: Record<string, string> = {}) {
  return text.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match)
}
