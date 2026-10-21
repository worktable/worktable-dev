// Only successful reads are shared. Callers key by authorization and workspace
// generation, and still charge every visitor request to its own link budget.
export class LinkReadMemo {
  private readonly entries = new Map<
    string,
    { value: Promise<unknown>; expires: number; bytes: number }
  >()
  private bytes = 0

  read<T>(key: string, load: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key)
    if (existing && existing.expires > Date.now())
      return existing.value as Promise<T>
    if (existing) {
      this.entries.delete(key)
      this.bytes -= existing.bytes
    }
    const entry = {
      value: Promise.resolve(undefined) as Promise<unknown>,
      expires: Infinity,
      bytes: 0,
    }
    entry.value = Promise.resolve()
      .then(load)
      .then((value) => {
        const bytes = Buffer.byteLength(JSON.stringify(value))
        if (this.entries.get(key) !== entry) return value
        if (bytes > 1024 * 1024) this.entries.delete(key)
        else {
          entry.bytes = bytes
          entry.expires = Date.now() + 2000
          this.bytes += bytes
        }
        this.trim()
        return value
      })
      .catch((error: unknown) => {
        if (this.entries.get(key) === entry) {
          this.entries.delete(key)
          this.bytes -= entry.bytes
        }
        throw error
      })
    this.entries.set(key, entry)
    this.trim()
    return entry.value as Promise<T>
  }

  private trim(): void {
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= 256 && this.bytes <= 8 * 1024 * 1024) break
      this.entries.delete(key)
      this.bytes -= entry.bytes
    }
  }
}
export const linkReadMemo = new LinkReadMemo()
