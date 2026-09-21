import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
  type Ref,
} from "react"
import { Link, useNavigate, useRouterState } from "@tanstack/react-router"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { Database, FileSearch, FileText, Search, X } from "lucide-react"
import { Input } from "@worktable/ui/components/input"
import { searchQueryOptions, useSpaces } from "@/lib/queries"
import { resolveIcon } from "@/lib/icons"
import type { SearchResult, SpaceFile } from "@worktable/types"

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Wrap case-insensitive occurrences of the query tokens in a highlight span. */
function Highlighted({ text, tokens }: { text: string; tokens: string[] }) {
  const pattern = useMemo(() => {
    const escaped = tokens.filter(Boolean).map(escapeRegExp)
    return escaped.length > 0
      ? new RegExp(`(${escaped.join("|")})`, "gi")
      : null
  }, [tokens])

  if (!pattern) return <>{text}</>
  const parts = text.split(pattern)
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <span
            key={i}
            className="rounded-[3px] bg-surface-selected text-sidebar-foreground"
          >
            {part}
          </span>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  )
}

export function SidebarSearchInput({
  query,
  onQueryChange,
  onSubmit,
}: {
  query: string
  onQueryChange: (value: string) => void
  /** Called on Enter with a non-empty query — opens the top search result. */
  onSubmit?: () => void
}) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-sidebar-foreground/40" />
      <Input
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && query) {
            e.stopPropagation()
            onQueryChange("")
          } else if (
            e.key === "Enter" &&
            query.trim() &&
            !e.nativeEvent.isComposing
          ) {
            // IME composition uses Enter to commit the candidate, not to submit.
            onSubmit?.()
          }
        }}
        placeholder="Search workspace…"
        aria-label="Search workspace"
        className="h-9 pr-8 pl-9"
      />
      {query && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onQueryChange("")}
          className="absolute top-1/2 right-2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-sidebar-foreground/40 transition-colors hover:bg-sidebar-hover hover:text-sidebar-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
}

function resultKey(result: SearchResult): string {
  return `${result.type}:${result.spaceId}:${result.path ?? `${result.collectionId}/${result.recordId}`}`
}

function ResultRow({
  result,
  tokens,
  currentPath,
  currentRecordId,
  onNavigate,
}: {
  result: SearchResult
  tokens: string[]
  currentPath: string
  currentRecordId: string | undefined
  onNavigate: () => void
}) {
  const isDoc = result.type === "doc"
  const folder =
    isDoc && result.path && result.path.includes("/")
      ? result.path.slice(0, result.path.lastIndexOf("/"))
      : null
  const targetPath = isDoc
    ? `/spaces/${result.spaceId}/documents/${result.path ?? ""}`
    : `/spaces/${result.spaceId}/records/${result.collectionId ?? ""}`
  // Record results share a collection route; only the peeked record is active.
  const active =
    currentPath === targetPath && (isDoc || currentRecordId === result.recordId)

  const body = (
    <div
      className={`flex flex-col gap-0.5 rounded-md px-3 py-2 text-sm transition-all duration-180 ${
        active
          ? "bg-sidebar-accent text-sidebar-primary"
          : "text-sidebar-foreground/60 hover:bg-sidebar-hover hover:text-sidebar-foreground"
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        {isDoc ? (
          <FileText className="size-3.5 shrink-0 opacity-70" />
        ) : (
          <Database className="size-3.5 shrink-0 opacity-70" />
        )}
        <span
          className={`truncate ${active ? "font-medium" : "text-sidebar-foreground/80"}`}
        >
          <Highlighted text={result.title} tokens={tokens} />
        </span>
      </div>
      {result.excerpt && (
        <p className="line-clamp-2 pl-[22px] text-xs leading-relaxed text-sidebar-foreground/45">
          <Highlighted text={result.excerpt} tokens={tokens} />
        </p>
      )}
      {(folder ?? (!isDoc && result.collectionId)) && (
        <p className="truncate pl-[22px] text-[11px] text-sidebar-foreground/35">
          {isDoc ? folder : result.collectionId}
        </p>
      )}
    </div>
  )

  if (isDoc && result.path) {
    return (
      <Link
        to="/spaces/$spaceId/documents/$"
        params={{ spaceId: result.spaceId, _splat: result.path }}
        onClick={onNavigate}
      >
        {body}
      </Link>
    )
  }
  if (isDoc) {
    return (
      <div aria-disabled="true" title="Unavailable">
        {body}
      </div>
    )
  }
  return (
    <Link
      to="/spaces/$spaceId/records/$"
      params={{ spaceId: result.spaceId, _splat: result.collectionId ?? "" }}
      search={result.recordId ? { record: result.recordId } : undefined}
      onClick={onNavigate}
    >
      {body}
    </Link>
  )
}

export interface SidebarSearchResultsHandle {
  /** Navigate to the top-ranked result, if any. */
  openTopResult: () => void
}

export function SidebarSearchResults({
  query,
  currentPath,
  onNavigate,
  ref,
}: {
  query: string
  currentPath: string
  onNavigate: () => void
  ref?: Ref<SidebarSearchResultsHandle>
}) {
  const [debouncedQuery, setDebouncedQuery] = useState(query.trim())
  useEffect(() => {
    const timeout = window.setTimeout(
      () => setDebouncedQuery(query.trim()),
      180
    )
    return () => window.clearTimeout(timeout)
  }, [query])

  // The peeked record id (?record=) — record rows need it for active state.
  const currentRecordId = useRouterState({
    select: (s) => {
      const record = (s.location.search as Record<string, unknown>)["record"]
      return typeof record === "string" ? record : undefined
    },
  })

  const {
    data: results,
    isLoading,
    isPlaceholderData,
  } = useQuery({
    ...searchQueryOptions({ query: debouncedQuery, maxResults: 50 }),
    placeholderData: keepPreviousData,
  })

  const navigate = useNavigate()
  useImperativeHandle(
    ref,
    () => ({
      openTopResult() {
        // Enter must act on results for the CURRENT input: within the debounce
        // window (or while the fetch is showing keepPreviousData) the visible
        // top hit still belongs to the previous query — do nothing rather than
        // navigate somewhere stale.
        if (debouncedQuery !== query.trim() || isPlaceholderData) return
        const top = results?.[0]
        if (!top) return
        if (top.type === "doc" && top.path) {
          void navigate({
            to: "/spaces/$spaceId/documents/$",
            params: { spaceId: top.spaceId, _splat: top.path },
          })
        } else if (top.collectionId) {
          void navigate({
            to: "/spaces/$spaceId/records/$",
            params: { spaceId: top.spaceId, _splat: top.collectionId },
            search: top.recordId ? { record: top.recordId } : undefined,
          })
        } else {
          return
        }
        onNavigate()
      },
    }),
    [results, navigate, onNavigate, debouncedQuery, query, isPlaceholderData]
  )
  const { data: spaces } = useSpaces()
  const spacesById = useMemo(
    () =>
      new Map((spaces ?? []).map((space) => [space.id, space as SpaceFile])),
    [spaces]
  )

  const tokens = useMemo(
    () => debouncedQuery.split(/\s+/).filter(Boolean),
    [debouncedQuery]
  )

  // Group by space, preserving the server's relevance order: groups appear in
  // the order of their best hit, rows keep their rank within the group.
  const groups = useMemo(() => {
    const bySpace = new Map<string, SearchResult[]>()
    for (const result of results ?? []) {
      const group = bySpace.get(result.spaceId)
      if (group) group.push(result)
      else bySpace.set(result.spaceId, [result])
    }
    return [...bySpace.entries()]
  }, [results])

  if (isLoading && !results) {
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="h-12 animate-pulse rounded-md bg-sidebar-accent/50"
          />
        ))}
      </div>
    )
  }

  if (results && results.length === 0) {
    return (
      <div className="px-3 py-8 text-center">
        <FileSearch className="mx-auto mb-2 size-5 text-sidebar-foreground/30" />
        <p className="text-xs text-sidebar-foreground/40">
          No matches for “{debouncedQuery}”
        </p>
        <p className="mt-1 text-[11px] text-sidebar-foreground/30">
          Try a broader term
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {groups.map(([spaceId, spaceResults]) => {
        const space = spacesById.get(spaceId)
        return (
          <div key={spaceId}>
            <div className="mb-1 flex items-center gap-1.5 px-3 text-sidebar-foreground/40">
              {resolveIcon(space?.icon, "size-3")}
              <p className="truncate text-[10px] font-semibold tracking-wider uppercase">
                {space?.name ?? spaceId}
              </p>
            </div>
            {/* flex gap, not space-y: router <Link>s render inline <a>s, which ignore vertical margins */}
            <div className="flex flex-col gap-1">
              {spaceResults.map((result) => (
                <ResultRow
                  key={resultKey(result)}
                  result={result}
                  tokens={tokens}
                  currentPath={currentPath}
                  currentRecordId={currentRecordId}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
