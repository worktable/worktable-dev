import { useEffect, useMemo, useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import {
  AppWindow,
  Archive,
  Clock3,
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
import { DocumentFormatIcon } from "@/components/document-format-icon"
import {
  formatArchiveDate,
  useRecentDocuments,
  type RecentDocument,
  type RecentDocuments,
  type RecentOptions,
} from "@/lib/lifetime"
import { formatGroupLabel, getSpaceArchiveInfo } from "@/lib/spaces"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@worktable/ui/components/select"
import type { SearchResult, SpaceFile } from "@worktable/types"

export const Route = createFileRoute("/")({
  component: HomePage,
})

function RecentDocumentRow({ item }: { item: RecentDocument }) {
  const { document } = item
  return (
    <Link
      to="/spaces/$spaceId/documents/$"
      params={{ spaceId: item.spaceId, _splat: document.path }}
    >
      <ListRow
        icon={<DocumentFormatIcon formatId={document.format.id} />}
        title={document.title}
        subtitle={[
          item.spaceName,
          document.path,
          document.archiveOn
            ? `Archives ${formatArchiveDate(document.archiveOn)}`
            : undefined,
        ]
          .filter(Boolean)
          .join(" · ")}
        meta={
          document.updatedAt ? <RelativeTime iso={document.updatedAt} /> : undefined
        }
      />
    </Link>
  )
}

function RecentSection({
  spaces,
  options,
  onOptionsChange,
  data,
  isLoading,
  isError,
  onRetry,
}: {
  spaces: SpaceFile[]
  options: RecentOptions
  onOptionsChange: (options: RecentOptions) => void
  data: RecentDocuments | undefined
  isLoading: boolean
  isError: boolean
  onRetry: () => void
}) {
  const { sort, includeTemporary } = options
  const spaceId = options.spaceId ?? "all"
  const setSort = (next: RecentOptions["sort"]) => onOptionsChange({ ...options, sort: next })
  const setSpaceId = (next: string) => {
    onOptionsChange({ sort, includeTemporary, ...(next === "all" ? {} : { spaceId: next }) })
  }
  const setIncludeTemporary = (next: boolean) =>
    onOptionsChange({ ...options, includeTemporary: next })
  const spaceNames = new Map(spaces.map((space) => [space.id, space.name]))

  return (
    <section className="mb-10">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-lg font-semibold text-foreground">Recent</h2>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-border p-0.5" role="group" aria-label="Sort recent documents">
            {(["updated", "created"] as const).map((option) => (
              <Button
                key={option}
                size="xs"
                variant={sort === option ? "secondary" : "ghost"}
                aria-pressed={sort === option}
                onClick={() => setSort(option)}
              >
                {option === "updated" ? "Updated" : "Created"}
              </Button>
            ))}
          </div>
          <Select
            value={spaceId}
            onValueChange={(value) => {
              if (value) setSpaceId(value)
            }}
          >
            <SelectTrigger aria-label="Filter by Space" className="h-8 w-auto max-w-44">
              <SelectValue>
                {spaceId === "all" ? "All Spaces" : (spaceNames.get(spaceId) ?? spaceId)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Spaces</SelectItem>
              {spaces.map((space) => (
                <SelectItem key={space.id} value={space.id}>
                  {space.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant={includeTemporary ? "secondary" : "outline"}
            aria-pressed={includeTemporary}
            onClick={() => setIncludeTemporary(!includeTemporary)}
          >
            <Clock3 className="size-3.5" />
            Include temporary
          </Button>
        </div>
      </div>

      {isError && !data ? (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-dashed border-border/70 px-4 py-4 text-sm text-muted-foreground">
          <span>Couldn’t load recent documents.</span>
          <Button size="sm" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-14 animate-pulse rounded-lg bg-muted/20" />
          ))}
        </div>
      ) : data && data.items.length > 0 ? (
        <div className="space-y-1">
          {data.items.map((item) => (
            <RecentDocumentRow key={`${item.spaceId}:${item.document.path}`} item={item} />
          ))}
        </div>
      ) : (
        <p className="rounded-xl border border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
          {sort === "created" ? "No documents created through Worktable yet." : "No documents yet."}
        </p>
      )}
    </section>
  )
}

function SpacesSection({
  spaces,
  lastActivity,
}: {
  spaces: SpaceFile[]
  lastActivity: Map<string, string | undefined>
}) {
  const groups = new Map<string, SpaceFile[]>()
  for (const space of spaces) {
    const key = space.group ?? ""
    groups.set(key, [...(groups.get(key) ?? []), space])
  }
  const activity = (space: SpaceFile) => lastActivity.get(space.id) ?? ""
  // Alphabetical like the sidebar, with ungrouped Spaces last.
  const orderedGroups = [...groups.entries()].sort(([a], [b]) =>
    a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)
  )

  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold text-foreground">Spaces</h2>
      <div className="space-y-6">
        {orderedGroups.map(([group, groupSpaces]) => (
          <div key={group || "other"}>
            {orderedGroups.length > 1 && (
              <h3 className="mb-1 px-4 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
                {group ? formatGroupLabel(group) : "Other"}
              </h3>
            )}
            <div className="space-y-1">
              {[...groupSpaces]
                .sort((a, b) => activity(b).localeCompare(activity(a)))
                .map((space) => (
                  <Link key={space.id} to="/spaces/$spaceId" params={{ spaceId: space.id }}>
                    <ListRow
                      iconSlot={
                        <ListRowIcon variant="muted">{resolveIcon(space.icon)}</ListRowIcon>
                      }
                      title={space.name}
                      subtitle={space.description}
                      meta={activity(space) ? <RelativeTime iso={activity(space)} /> : undefined}
                    />
                  </Link>
                ))}
            </div>
          </div>
        ))}
      </div>
    </section>
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
            result.archiveOn
              ? `Archives ${formatArchiveDate(result.archiveOn)}`
              : documentView === "html"
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
  const activeSpaces = useMemo(
    () => (spaces ?? []).filter((space) => !getSpaceArchiveInfo(space)),
    [spaces]
  )
  const [recentOptions, setRecentOptions] = useState<RecentOptions>({
    sort: "updated",
    includeTemporary: false,
  })
  const recent = useRecentDocuments(recentOptions)
  // Each response reports every listed Space's newest change across all
  // lifetimes. The unfiltered list shares the query above, so Space ordering
  // needs no extra scan; while a Space filter is on it keeps its last result.
  const { data: activity } = useRecentDocuments(
    { sort: recentOptions.sort, includeTemporary: recentOptions.includeTemporary },
    !recentOptions.spaceId
  )
  const lastActivity = useMemo(
    () => new Map((activity?.spaces ?? []).map((entry) => [entry.spaceId, entry.lastActivityAt])),
    [activity]
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
        <>
          <RecentSection
            spaces={activeSpaces}
            options={recentOptions}
            onOptionsChange={setRecentOptions}
            data={recent.data}
            isLoading={recent.isLoading}
            isError={recent.isError}
            onRetry={() => void recent.refetch()}
          />
          <SpacesSection spaces={activeSpaces} lastActivity={lastActivity} />
        </>
      )}
    </div>
  )
}
