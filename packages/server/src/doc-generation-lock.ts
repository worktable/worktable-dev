import { assertWorkspaceAvailable } from "./workspace-safety.ts"

const tails = new Map<string, Promise<void>>()

async function withGenerationKeyLock<T>(
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => current)
  tails.set(key, tail)
  await previous
  try {
    assertWorkspaceAvailable()
    return await operation()
  } finally {
    release()
    if (tails.get(key) === tail) tails.delete(key)
  }
}

/** Serialize operations that replace or retire a bounded set of generations. */
export function withDocGenerationLocks<T>(
  documents: readonly { spaceId: string; docPath: string }[],
  operation: () => Promise<T>
): Promise<T> {
  const keys = [
    ...new Set(
      documents.map(({ spaceId, docPath }) => `${spaceId}\0${docPath}`)
    ),
  ].sort()
  const acquire = (index: number): Promise<T> => {
    const key = keys[index]
    return key
      ? withGenerationKeyLock(key, () => acquire(index + 1))
      : operation()
  }
  return acquire(0)
}

/** Serialize operations that replace or retire one document generation. */
export function withDocGenerationLock<T>(
  spaceId: string,
  docPath: string,
  operation: () => Promise<T>
): Promise<T> {
  return withDocGenerationLocks([{ spaceId, docPath }], operation)
}
