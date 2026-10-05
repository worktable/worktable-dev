/** Pagefind loads the match list and each page's excerpt separately. */
export interface SearchPage {
  url: string
  meta: { title?: string; url?: string }
  excerpt: string
  sub_results?: { url: string; title: string; excerpt: string; locations: unknown[] }[]
}
export interface SearchMatch {
  data(): Promise<SearchPage>
}
export interface SearchView {
  pending(): void
  clear(): void
  commit(pages: SearchPage[], total: number, append: boolean): void
  error(): void
}

/** Publish complete pages together; invalidate requests as soon as input changes. */
export class SearchResults {
  private revision = 0
  private matches: SearchMatch[] = []
  private shown = 0
  private busy = false

  constructor(
    private search: (query: string) => Promise<{ results: SearchMatch[] }>,
    private view: SearchView,
  ) {}

  async update(query: string, debounce = 180) {
    const revision = ++this.revision
    this.busy = true
    this.matches = []
    this.shown = 0
    if (!query.trim()) {
      this.busy = false
      this.view.clear()
      return
    }
    this.view.pending()
    try {
      if (debounce) await new Promise((resolve) => setTimeout(resolve, debounce))
      if (revision !== this.revision) return
      const { results } = await this.search(query.trim())
      if (revision !== this.revision) return
      const pages = await Promise.all(results.slice(0, 5).map((result) => result.data()))
      if (revision !== this.revision) return
      this.matches = results
      this.shown = pages.length
      this.busy = false
      this.view.commit(pages, results.length, false)
    } catch {
      if (revision !== this.revision) return
      this.busy = false
      this.view.error()
    }
  }

  async more() {
    if (this.busy || this.shown >= this.matches.length) return
    const revision = this.revision
    this.busy = true
    this.view.pending()
    try {
      const pages = await Promise.all(this.matches.slice(this.shown, this.shown + 5).map((result) => result.data()))
      if (revision !== this.revision) return
      this.shown += pages.length
      this.busy = false
      this.view.commit(pages, this.matches.length, true)
    } catch {
      if (revision !== this.revision) return
      this.busy = false
      this.view.error()
    }
  }
}
