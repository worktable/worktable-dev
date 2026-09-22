export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let cursor = 0
  let failed = false
  let failure: unknown
  const worker = async () => {
    while (!failed) {
      const index = cursor
      cursor += 1
      if (index >= values.length) return
      try {
        results[index] = await operation(values[index]!, index)
      } catch (error) {
        if (!failed) failure = error
        failed = true
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, worker)
  )
  // Do not release a caller's lease or clean its files while started I/O is active.
  if (failed) throw failure
  return results
}
