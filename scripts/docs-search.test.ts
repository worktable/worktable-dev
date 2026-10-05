import { expect, test } from "bun:test"
import { SearchResults, type SearchPage, type SearchMatch } from "../apps/docs/src/lib/search-results"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const page = (title: string): SearchPage => ({ url: `/${title}/`, meta: { title }, excerpt: title })
const match = (title: string): SearchMatch => ({ data: async () => page(title) })
function fixture(search: (query: string) => Promise<{ results: SearchMatch[] }>) {
  let visible: SearchPage[] = []
  let error = false
  let pending = false
  const results = new SearchResults(search, {
    pending() { pending = true; error = false },
    clear() { visible = []; pending = false; error = false },
    commit(pages, _total, append) { visible = append ? [...visible, ...pages] : pages; pending = false },
    error() { error = true; pending = false },
  })
  return { results, state: () => ({ titles: visible.map((p) => p.meta.title), error, pending }) }
}

test("keeps previous results until every replacement excerpt is ready", async () => {
  const excerpt = deferred<SearchPage>()
  const started = deferred<void>()
  const { results, state } = fixture(async (query) => ({ results: query === "old" ? [match("old")] : [
    match("new"), { data: () => { started.resolve(); return excerpt.promise } },
  ] }))
  await results.update("old", 0)
  const next = results.update("new", 0)
  await started.promise
  expect(state()).toEqual({ titles: ["old"], pending: true, error: false })
  excerpt.resolve(page("second"))
  await next
  expect(state()).toEqual({ titles: ["new", "second"], pending: false, error: false })
})

test("new input invalidates older requests before debounce; clear invalidates excerpts", async () => {
  const slow = deferred<{ results: SearchMatch[] }>()
  const excerpt = deferred<SearchPage>()
  const started = deferred<void>()
  const { results, state } = fixture(async (query) => query === "slow" ? slow.promise : {
    results: [{ data: () => { started.resolve(); return excerpt.promise } }],
  })
  const old = results.update("slow", 0)
  const next = results.update("new")
  slow.resolve({ results: [match("stale")] })
  await old
  expect(state().titles).toEqual([])
  await started.promise
  await results.update("")
  excerpt.resolve(page("also stale"))
  await next
  expect(state()).toEqual({ titles: [], pending: false, error: false })
})

test("failed refresh preserves results, can recover, and a late failure cannot replace success", async () => {
  const slow = deferred<{ results: SearchMatch[] }>()
  let fail = true
  const { results, state } = fixture(async (query) => {
    if (query === "slow") return slow.promise
    if (query === "new" && fail) throw new Error("offline")
    return { results: query === "empty" ? [] : [match(query)] }
  })
  await results.update("old", 0)
  await results.update("new", 0)
  expect(state()).toEqual({ titles: ["old"], pending: false, error: true })
  fail = false
  const late = results.update("slow", 0)
  await results.update("new", 0)
  slow.reject(new Error("late failure"))
  await late
  expect(state()).toEqual({ titles: ["new"], pending: false, error: false })
  await results.update("empty", 0)
  expect(state().titles).toEqual([])
})

test("pagination appends complete pages, retries failures, and cannot append to a newer search", async () => {
  const extra = deferred<SearchPage>()
  let fail = true
  let hold = false
  const { results, state } = fixture(async (query) => ({ results: query === "new" ? [match("new")] : [
    ...Array.from({ length: 5 }, (_, i) => match(String(i))),
    { data: async () => { if (fail) throw new Error("offline"); return page("5") } },
    { data: async () => hold ? extra.promise : page("6") },
  ] }))
  await results.update("old", 0)
  await results.more()
  expect(state().titles).toHaveLength(5)
  expect(state().error).toBe(true)
  fail = false
  await results.more()
  expect(state().titles).toEqual(["0", "1", "2", "3", "4", "5", "6"])
  hold = true
  await results.update("old", 0)
  const more = results.more()
  await results.update("new", 0)
  extra.resolve(page("stale"))
  await more
  expect(state()).toEqual({ titles: ["new"], pending: false, error: false })
})
