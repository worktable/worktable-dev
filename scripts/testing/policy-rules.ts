export function isBareSleepLine(sourceLines: string[], index: number): boolean {
  const line = sourceLines[index] ?? ""
  if (/\.waitForTimeout\s*\(/.test(line)) return true
  if (/setTimeout\s*\([^,]+,\s*0\s*\)/.test(line)) return false
  if (
    !/await\s+Bun\.sleep\s*\(/.test(line) &&
    !/await\s+new Promise[^\n]*setTimeout\s*\(/.test(line)
  ) {
    return false
  }
  return !`${sourceLines[index - 1] ?? ""}\n${line}`.includes(
    "test-policy: external-readiness-backoff"
  )
}
