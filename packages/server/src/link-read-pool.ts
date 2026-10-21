// Visitor reads have their own small pool. They never occupy a member lease.
export class LinkReadPool {
  private active = 0
  private readonly byLink = new Map<string, number>()
  private readonly waiting: Array<{
    linkId: string
    take: (release: (() => void) | null) => void
    timer: ReturnType<typeof setTimeout>
  }> = []

  private readonly limits: {
    active: number
    perLink: number
    queued: number
    waitMs: number
  }
  constructor(limits = { active: 4, perLink: 2, queued: 32, waitMs: 2000 }) {
    this.limits = limits
  }

  acquire(linkId: string): Promise<(() => void) | null> {
    if (this.available(linkId)) return Promise.resolve(this.start(linkId))
    if (this.waiting.length >= this.limits.queued) return Promise.resolve(null)
    return new Promise((take) => {
      const entry = {
        linkId,
        take,
        timer: setTimeout(() => {
          const index = this.waiting.indexOf(entry)
          if (index >= 0) this.waiting.splice(index, 1)
          take(null)
        }, this.limits.waitMs),
      }
      this.waiting.push(entry)
    })
  }

  private available(linkId: string): boolean {
    return (
      this.active < this.limits.active &&
      (this.byLink.get(linkId) ?? 0) < this.limits.perLink
    )
  }

  private start(linkId: string): () => void {
    this.active++
    this.byLink.set(linkId, (this.byLink.get(linkId) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      this.active--
      const left = this.byLink.get(linkId)! - 1
      if (left) this.byLink.set(linkId, left)
      else this.byLink.delete(linkId)
      // Oldest eligible request first. One busy link cannot block others.
      for (
        let index = 0;
        index < this.waiting.length && this.active < this.limits.active;
      ) {
        const entry = this.waiting[index]!
        if (!this.available(entry.linkId)) {
          index++
          continue
        }
        this.waiting.splice(index, 1)
        clearTimeout(entry.timer)
        entry.take(this.start(entry.linkId))
      }
    }
  }
}

const configured = Number(process.env["WORKTABLE_LINK_CONCURRENCY"])
export const linkReadPool = new LinkReadPool({
  active:
    Number.isInteger(configured) && configured > 0
      ? Math.min(configured, 32)
      : 4,
  perLink: 2,
  queued: 32,
  waitMs: 2000,
})
