export const TOOL_SOURCE_CHARACTERS = 512 * 1024

export interface ToolEnvironment {
  theme: "light" | "dark"
  viewport: { width: number; height: number }
}

/** Copy only the small environment contract into startup and update messages. */
export function toolEnvironment(value: ToolEnvironment): ToolEnvironment {
  if (!value || !["light", "dark"].includes(value.theme) || !value.viewport)
    throw new Error("Invalid tool environment.")
  const { width, height } = value.viewport
  if (
    ![width, height].every(
      (size) =>
        typeof size === "number" &&
        Number.isFinite(size) &&
        size >= 0 &&
        size <= 32768
    )
  )
    throw new Error("Invalid tool viewport.")
  return { theme: value.theme, viewport: { width, height } }
}
