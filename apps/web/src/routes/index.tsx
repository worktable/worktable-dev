import type { JSX } from "react"
import { useEffect, useMemo, useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import {
  AppWindow,
  Archive,
  File,
  FileSearch,
  FileText,
  Search,
} from "lucide-react"
import { WorktableAppIcon } from "@/components/worktable-app-icon"
import { Button } from "@worktable/ui/components/button"
import { Input } from "@worktable/ui/components/input"
import { useSearchResults, useSpaces } from "@/lib/queries"
import { resolveIcon } from "@/lib/icons"
import { RelativeTime } from "@/lib/time"
import { ListRow, ListRowIcon } from "@/components/list-row"
import { searchResultDocumentView } from "@/lib/document-views"
import type { SearchResult, SpaceFile } from "@worktable/types"

export const Route = createFileRoute("/")({
  component: HomePage,
})

function RecentSpaceCard({ space }: { space: SpaceFile }) {
  const subtitle = [space.description].filter(Boolean).join(" · ")

  return (
    <Link to="/spaces/$spaceId" params={{ spaceId: space.id }}>
      <ListRow
        iconSlot={
          <ListRowIcon variant="muted">{resolveIcon(space.icon)}</ListRowIcon>
        }
        title={space.name}
        subtitle={subtitle}
        meta={<RelativeTime iso={space.updatedAt} />}
      />
    </Link>
  )
}

function SearchResultRow({
  result,
  space,
}: {
  result: SearchResult
  space?: SpaceFile
}) {
  const documentView = searchResultDocumentView(result)
  if (result.type === "doc" && result.path) {
    return (
      <Link
        to="/spaces/$spaceId/documents/$"
        params={{ spaceId: result.spaceId, _splat: result.path }}
      >
        <ListRow
          icon={
            documentView === "html" ? (
              <AppWindow className="size-4" />
            ) : documentView === "doc" ? (
              <FileText className="size-4" />
            ) : (
              <File className="size-4" />
            )
          }
          title={result.title}
          subtitle={`${space?.name ?? result.spaceId} · ${result.path}`}
          meta={
            documentView === "html"
              ? "HTML doc"
              : documentView === "doc"
                ? "Doc"
                : "Document"
          }
        />
      </Link>
    )
  }

  if (result.type === "doc") {
    return (
      <div aria-disabled="true" title="Unavailable">
        <ListRow
          icon={<File className="size-4" />}
          title={result.title}
          subtitle={`${space?.name ?? result.spaceId} · ${result.path ?? "Document"}`}
          meta="Unavailable"
        />
      </div>
    )
  }

  return null
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <WorktableAppIcon className="mb-5 size-14" />
      <h2 className="text-base font-medium text-foreground">
        Welcome to Worktable
      </h2>
      <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted-foreground">
        Create documents in the sidebar, or ask an AI agent to create a visual
        HTML doc.
      </p>
    </div>
  )
}

function SearchPanel({
  query,
  onQueryChange,
  includeArchived,
  onIncludeArchivedChange,
}: {
  query: string
  onQueryChange: (value: string) => void
  includeArchived: boolean
  onIncludeArchivedChange: (value: boolean) => void
}) {
  return (
    <div className="mb-6 rounded-2xl border border-border/60 bg-card/70 p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <div className="flex size-9 items-center justify-center rounded-xl bg-surface-tint text-primary">
          <Search className="size-4" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-foreground">Search</h1>
        </div>
      </div>

      <div className="space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search documents..."
            className="pl-9"
          />
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={includeArchived ? "secondary" : "outline"}
            onClick={() => onIncludeArchivedChange(!includeArchived)}
          >
            <Archive className="size-3.5" />
            Include archived
          </Button>
        </div>
      </div>
    </div>
  )
}

function SearchResultsSection({
  query,
  results,
  isLoading,
  spacesById,
}: {
  query: string
  results: SearchResult[] | undefined
  isLoading: boolean
  spacesById: Map<string, SpaceFile>
}) {
  if (!query.trim()) return null

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-base font-semibold text-foreground">
          Search Results
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Documents for “{query.trim()}”
        </p>
      </div>

      {isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-14 animate-pulse rounded-lg bg-muted/20"
            />
          ))}
        </div>
      )}

      {!isLoading && results && results.length === 0 && (
        <div className="rounded-xl border border-dashed border-border/70 bg-card/40 px-4 py-6 text-center">
          <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-full bg-muted/40">
            <FileSearch className="size-5 text-muted-foreground/60" />
          </div>
          <p className="text-sm font-medium text-foreground">No matches yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Try a broader term.
          </p>
        </div>
      )}

      {!isLoading && results && results.length > 0 && (
        <div className="space-y-1">
          {results.map((result) => (
            <div
              key={`${result.type}:${result.spaceId}:${result.path ?? result.title}`}
            >
              <SearchResultRow
                result={result}
                space={spacesById.get(result.spaceId)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function HomePage() {
  const { data: spaces, isLoading } = useSpaces()
  const [query, setQuery] = useState("")
  const [debouncedQuery, setDebouncedQuery] = useState("")
  const [includeArchived, setIncludeArchived] = useState(false)

  useEffect(() => {
    const timeout = window.setTimeout(
      () => setDebouncedQuery(query.trim()),
      180
    )
    return () => window.clearTimeout(timeout)
  }, [query])

  const { data: results, isLoading: searchLoading } = useSearchResults({
    query: debouncedQuery,
    includeArchived,
    maxResults: 30,
  })

  const spacesById = useMemo(
    () => new Map((spaces ?? []).map((space) => [space.id, space])),
    [spaces]
  )

  if (isLoading) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <div className="mb-6 h-32 animate-pulse rounded-2xl bg-muted/20" />
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-14 animate-pulse rounded-lg bg-muted/20"
            />
          ))}
        </div>
      </div>
    )
  }

  if (!spaces || spaces.length === 0) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
        <EmptyState />
      </div>
    )
  }

  const recentItems: {
    key: string
    updatedAt: string
    render: () => JSX.Element
  }[] = spaces.map((space) => ({
    key: `space-${space.id}`,
    updatedAt: space.updatedAt,
    render: () => <RecentSpaceCard space={space} />,
  }))

  recentItems.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  )

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
      <SearchPanel
        query={query}
        onQueryChange={setQuery}
        includeArchived={includeArchived}
        onIncludeArchivedChange={setIncludeArchived}
      />

      {debouncedQuery ? (
        <SearchResultsSection
          query={debouncedQuery}
          results={results}
          isLoading={searchLoading}
          spacesById={spacesById}
        />
      ) : (
        <div>
          <div className="mb-6">
            <h2 className="text-lg font-semibold text-foreground">
              Recent Activity
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Your latest spaces across all projects
            </p>
          </div>

          <div className="space-y-1">
            {recentItems.slice(0, 20).map((item) => (
              <div key={item.key}>{item.render()}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
