const ID_BYTES = 16

/**
 * Generate an opaque browser-side identifier without requiring a secure
 * context. `crypto.getRandomValues()` is available on the LAN HTTP origins
 * supported by local Worktable installs, while `crypto.randomUUID()` is not.
 */
export function createClientId(prefix: string): string {
  const normalizedPrefix = prefix.trim()
  if (!/^[a-z][a-z0-9-]*$/i.test(normalizedPrefix)) {
    throw new Error("Client ID prefix must contain only letters, digits, or -")
  }

  const bytes = new Uint8Array(ID_BYTES)
  globalThis.crypto.getRandomValues(bytes)
  const value = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
  return `${normalizedPrefix}_${value}`
}
