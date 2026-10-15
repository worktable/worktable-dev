import { readFile } from "node:fs/promises"

export async function readJsonFileWithFallback<T>(
  filePath: string,
  fallback: T
): Promise<{ value: T; exists: boolean }> {
  let text: string
  try {
    text = await readFile(filePath, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { value: fallback, exists: false }
    }
    throw error
  }
  try {
    return { value: JSON.parse(text) as T, exists: true }
  } catch {
    // Callers validate existing state and refuse to replace corrupt files.
    return { value: fallback, exists: true }
  }
}
