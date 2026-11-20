import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react"
import { Link, useRouterState } from "@tanstack/react-router"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import {
  Database,
  History,
  LayoutDashboard,
  Library as LibraryIcon,
  MessageCircle,
  Search,
  Settings,
  X,
} from "lucide-react"
import {
  searchResultKind,
  type SearchKind,
  type SearchResult,
  type SpaceFile,
} from "@worktable/types"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@worktable/ui/components/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@worktable/ui/components/select"
import { cn } from "@worktable/ui/lib/utils"
import {
  DocLocation,
  DocumentFormatIcon,
} from "@/components/document-format-icon"
import { SpaceIcon } from "@/components/spaces/space-icon"
import { useSkillLibrariesEnabled } from "@/hooks/use-deployment-info"
import { useIsMobile } from "@/hooks/use-mobile"
import { libraryKey } from "@/lib/library"
import { searchQueryOptions, useSpaces, useWorkspace } from "@/lib/queries"
import { readRecentOpens, type RecentOpen } from "@/lib/recent-opens"
import { onOpenSearch } from "@/lib/search-open"
import { matchPlaces } from "@/lib/search-places"
import { openSettings } from "@/lib/settings-open"

/** How long typing rests before a search is sent. */
const SEARCH_DELAY_MS = 180

const KINDS: ReadonlyArray<{ kind: SearchKind; label: string }> = [
  { kind: "doc", label: "Docs" },
  { kind: "html", label: "HTML Docs" },
  { kind: "drawing", label: "Drawings" },
  { kind: "file", label: "Files" },
  { kind: "record", label: "Records" },
]

/** A filter left open: the Select needs a value for "no filter". */
const ANY = "any"

type LinkTarget = Pick<ComponentProps<typeof Link>, "to" | "params" | "search">

interface Row {
  key: string
  title: string
  icon: ReactNode
  /** Where the row leads; a row without one can't be opened. */
  target?: LinkTarget
  /** Runs in place of a navigation. */
  action?: () => void
  excerpt?: string
  location?: ReactNode
  /** The heading over this row, when it starts a group. */
  heading?: string
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Marks the words typed where they occur in a result's text. */
function Highlighted({ text, tokens }: { text: string; tokens: string[] }) {
  const pattern = useMemo(() => {
    const escaped = tokens.filter(Boolean).map(escapeRegExp)
    return escaped.length > 0
      ? new RegExp(`(${escaped.join("|")})`, "gi")
      : null
  }, [tokens])
  if (!pattern) return <>{text}</>
  return (
    <>
      {text.split(pattern).map((part, index) =>
        index % 2 === 1 ? (
          <mark
            key={index}
            className="rounded-[3px] bg-surface-selected text-foreground"
          >
            {part}
          </mark>
        ) : (
          <span key={index}>{part}</span>
        )
      )}
    </>
  )
}

/** Where a skill opens: in the Library, under its library. */
const skillSplat = (skill: NonNullable<SearchResult["skill"]>) =>
  `${libraryKey(skill.library)}/${skill.id}`

const ICON = "size-4"

function resultRow(
  result: SearchResult,
  spaces: ReadonlyMap<string, SpaceFile>,
  worktableName: string
): Row {
  const spaceName = spaces.get(result.spaceId)?.name
  const key = `result:${result.type}:${result.spaceId}:${
    result.path ?? `${result.collectionId}/${result.recordId}`
  }`
  if (result.skill) {
    return {
      key,
      title: result.title,
      icon: <LibraryIcon className={ICON} />,
      target: {
        to: "/library/$",
        params: { _splat: skillSplat(result.skill) },
      },
      excerpt: result.excerpt,
      location: (
        <span className="truncate text-xs text-muted-foreground">
          {result.skill.library.kind === "worktable"
            ? worktableName
            : (result.skill.libraryName ?? "Library")}
        </span>
      ),
    }
  }
  if (result.type === "record") {
    return {
      key,
      title: result.title,
      icon: <Database className={ICON} />,
      target: {
        to: "/spaces/$spaceId/records/$",
        params: { spaceId: result.spaceId, _splat: result.collectionId ?? "" },
        search: result.recordId ? { record: result.recordId } : undefined,
      },
      excerpt: result.excerpt,
      location: (
        <DocLocation
          spaceName={spaceName}
          path={`${result.collectionId ?? ""}/`}
        />
      ),
    }
  }
  const path = result.path
  return {
    key,
    title: result.title,
    icon: (
      <DocumentFormatIcon
        formatId={result.format?.id}
        name={path?.split("/").pop()}
        className={ICON}
      />
    ),
    ...(path
      ? {
          target: {
            to: "/spaces/$spaceId/documents/$",
            params: { spaceId: result.spaceId, _splat: path },
          },
        }
      : {}),
    excerpt: result.excerpt,
    location: <DocLocation spaceName={spaceName} path={path ?? ""} />,
  }
}

function recentRow(
  open: RecentOpen,
  spaces: ReadonlyMap<string, SpaceFile>
): Row {
  const [, spaceId, section, rest] =
    open.path.match(/^\/spaces\/([^/]+)(?:\/([^/]+)\/(.*))?$/) ?? []
  const spaceName = spaceId ? spaces.get(spaceId)?.name : undefined
  const name = rest?.split("/").pop()
  return {
    key: `recent:${open.path}`,
    title: open.title,
    icon:
      open.role === "document" ? (
        <DocumentFormatIcon
          formatId={open.formatId}
          name={name}
          className={ICON}
        />
      ) : open.role === "thread" ? (
        <MessageCircle className={ICON} />
      ) : open.role === "skill" ? (
        <LibraryIcon className={ICON} />
      ) : (
        <Database className={ICON} />
      ),
    // A path this app showed; the router takes it as it is.
    target: { to: open.path as "/" },
    location: spaceName ? (
      <DocLocation
        spaceName={spaceName}
        path={section === "documents" ? (rest ?? "") : ""}
      />
    ) : undefined,
  }
}

/** Opens search when asked, and keeps what was typed while the app is open. */
export function SearchPalette() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [kind, setKind] = useState<SearchKind | null>(null)
  const [spaceId, setSpaceId] = useState<string | null>(null)
  useEffect(() => onOpenSearch(() => setOpen(true)), [])
  const isMobile = useIsMobile()
  const input = useRef<HTMLInputElement>(null)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        initialFocus={input}
        className={cn(
          "gap-0 p-0",
          isMobile
            ? // The whole screen, down to the keyboard when it is up.
              "top-0 left-0 h-[var(--app-visual-viewport-height,100dvh)] max-h-none max-w-none translate-x-0 translate-y-0 rounded-none border-0 sm:max-w-none"
            : // Held by its top edge, so the field stays put as results come.
              "top-[12vh] max-h-[min(36rem,76vh)] translate-y-0 sm:max-w-2xl"
        )}
      >
        <DialogTitle className="sr-only">Search</DialogTitle>
        {open && (
          <PaletteBody
            input={input}
            query={query}
            onQueryChange={setQuery}
            kind={kind}
            onKindChange={setKind}
            spaceId={spaceId}
            onSpaceChange={setSpaceId}
            isMobile={isMobile}
            onClose={() => setOpen(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function PaletteBody({
  input,
  query,
  onQueryChange,
  kind,
  onKindChange,
  spaceId,
  onSpaceChange,
  isMobile,
  onClose,
}: {
  input: RefObject<HTMLInputElement | null>
  query: string
  onQueryChange: (query: string) => void
  kind: SearchKind | null
  onKindChange: (kind: SearchKind | null) => void
  spaceId: string | null
  onSpaceChange: (spaceId: string | null) => void
  isMobile: boolean
  onClose: () => void
}) {
  const listId = useId()
  const currentPath = useRouterState({ select: (s) => s.location.pathname })
  const workspace = useWorkspace().data
  const worktableName = workspace?.name ?? "Worktable"
  const { data: spaces } = useSpaces()
  const skillLibraries = useSkillLibrariesEnabled()
  const spacesById = useMemo(
    () =>
      new Map((spaces ?? []).map((space) => [space.id, space as SpaceFile])),
    [spaces]
  )
  // Menus opened from the filters belong inside the dialog.
  const [container, setContainer] = useState<HTMLElement | null>(null)

  // What was typed last time is still there, selected, so typing replaces it.
  useEffect(() => {
    input.current?.select()
  }, [input])

  const typed = query.trim()
  const [searched, setSearched] = useState(typed)
  useEffect(() => {
    const timeout = window.setTimeout(() => setSearched(typed), SEARCH_DELAY_MS)
    return () => window.clearTimeout(timeout)
  }, [typed])

  const { data: results, isPlaceholderData } = useQuery({
    ...searchQueryOptions({
      query: searched,
      maxResults: 50,
      includeArchived: true,
      archivedLast: true,
      ...(kind ? { kind } : {}),
      ...(spaceId ? { spaceId } : {}),
    }),
    placeholderData: keepPreviousData,
  })
  // The rows on screen answer what is typed now, not an earlier query.
  const settled = searched === typed && !isPlaceholderData

  // Read once per opening: this component mounts when search opens. The
  // page already open is no use to offer.
  const [recent] = useState(() =>
    (workspace?.id ? readRecentOpens(workspace.id) : []).filter(
      (open) => open.path !== currentPath
    )
  )

  const places = useMemo(
    () => [
      {
        id: "home",
        name: "Home",
        icon: <LayoutDashboard className={ICON} />,
        target: { to: "/" } as LinkTarget,
      },
      {
        id: "threads",
        name: "Threads",
        icon: <MessageCircle className={ICON} />,
        target: {
          to: "/threads/$",
          params: { _splat: "" },
          search: { location: "all" },
        } as LinkTarget,
      },
      {
        id: "activity",
        name: "Activity",
        icon: <History className={ICON} />,
        target: { to: "/activity" } as LinkTarget,
      },
      ...(skillLibraries
        ? [
            {
              id: "library",
              name: "Library",
              icon: <LibraryIcon className={ICON} />,
              target: {
                to: "/library/$",
                params: { _splat: "" },
              } as LinkTarget,
            },
          ]
        : []),
      {
        id: "settings",
        name: "Settings",
        icon: <Settings className={ICON} />,
        action: () => openSettings(),
      },
      ...(spaces ?? []).map((space) => ({
        id: `space:${space.id}`,
        name: space.name,
        icon: <SpaceIcon space={space} size="xs" variant="glyph" />,
        target: {
          to: "/spaces/$spaceId",
          params: { spaceId: space.id },
        } as LinkTarget,
      })),
    ],
    [skillLibraries, spaces]
  )

  const tokens = useMemo(
    () => searched.split(/\s+/).filter(Boolean),
    [searched]
  )

  const rows = useMemo<Row[]>(() => {
    if (!typed) {
      return recent.map((open, index) => ({
        ...recentRow(open, spacesById),
        ...(index === 0 ? { heading: "Recent" } : {}),
      }))
    }
    const found: Row[] = matchPlaces(places, typed).map((place) => ({
      key: `place:${place.id}`,
      title: place.name,
      icon: place.icon,
      ...("target" in place ? { target: place.target } : {}),
      ...("action" in place ? { action: place.action } : {}),
    }))
    let archived = false
    for (const result of searched ? (results ?? []) : []) {
      const row = resultRow(result, spacesById, worktableName)
      if (result.archived && !archived) {
        archived = true
        row.heading = "Archived"
      }
      found.push(row)
    }
    return found
  }, [typed, searched, recent, places, results, spacesById, worktableName])

  // The row the keys act on: the one last pointed at or moved to, or the
  // first. Typing puts it back at the top.
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const activeAt = Math.max(
    0,
    rows.findIndex((row) => row.key === activeKey)
  )
  const activeRow = rows[activeAt]
  // By place in the list: a row's key can hold a path, which an id can't.
  const optionId = (at: number) => `${listId}-${at}`

  const move = (by: number) => {
    if (rows.length === 0) return
    const to = (activeAt + by + rows.length) % rows.length
    setActiveKey(rows[to]?.key ?? null)
    document.getElementById(optionId(to))?.scrollIntoView({ block: "nearest" })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // An IME uses these keys to choose what is being composed.
    if (event.nativeEvent.isComposing) return
    if (event.key === "ArrowDown") {
      event.preventDefault()
      move(1)
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      move(-1)
    } else if (event.key === "Enter") {
      event.preventDefault()
      if (!activeRow) return
      // Results still on screen from an earlier query aren't an answer yet.
      if (typed && !settled && activeRow.key.startsWith("result:")) return
      const element = document.getElementById(optionId(activeAt))
      if (
        (event.metaKey || event.ctrlKey) &&
        element instanceof HTMLAnchorElement
      ) {
        window.open(element.href, "_blank", "noopener")
        return
      }
      element?.click()
    }
  }

  const kindLabel = KINDS.find((item) => item.kind === kind)?.label
  const spaceName = spaceId ? spacesById.get(spaceId)?.name : undefined
  const noMatches =
    typed !== "" && settled && results !== undefined && rows.length === 0

  return (
    <div ref={setContainer} className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border/60 px-4">
        <Search className="size-4 shrink-0 text-muted-foreground" />
        <input
          ref={input}
          value={query}
          onChange={(event) => {
            onQueryChange(event.target.value)
            setActiveKey(null)
          }}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-label="Search"
          aria-autocomplete="list"
          aria-expanded={rows.length > 0}
          aria-controls={listId}
          aria-activedescendant={activeRow ? optionId(activeAt) : undefined}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          placeholder={`Search ${worktableName}…`}
          className="h-full min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground md:text-sm"
        />
        {isMobile && (
          <DialogClose
            aria-label="Close"
            className="-mr-2 flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-hover hover:text-foreground"
          >
            <X className="size-4" />
          </DialogClose>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
        <Select
          value={kind ?? ANY}
          onValueChange={(next) =>
            onKindChange(KINDS.find((item) => item.kind === next)?.kind ?? null)
          }
        >
          <FilterTrigger label="Kind" set={kind !== null}>
            {kindLabel ?? "Kind"}
          </FilterTrigger>
          <SelectContent container={container}>
            <SelectItem value={ANY}>Any Kind</SelectItem>
            <SelectSeparator />
            {KINDS.map((item) => (
              <SelectItem key={item.kind} value={item.kind}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={spaceId ?? ANY}
          onValueChange={(next) =>
            onSpaceChange(next && next !== ANY ? next : null)
          }
        >
          <FilterTrigger label="Space" set={spaceId !== null}>
            {spaceName ?? "Space"}
          </FilterTrigger>
          <SelectContent container={container} className="max-h-72">
            <SelectItem value={ANY}>Any Space</SelectItem>
            <SelectSeparator />
            {(spaces ?? []).map((space) => (
              <SelectItem key={space.id} value={space.id}>
                {space.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div
        id={listId}
        role="listbox"
        aria-label="Results"
        data-worktable-search-results
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2 empty:hidden"
      >
        {rows.map((row, at) => (
          <PaletteRow
            key={row.key}
            id={optionId(at)}
            row={row}
            tokens={row.key.startsWith("result:") ? tokens : []}
            active={row === activeRow}
            onPoint={() => setActiveKey(row.key)}
            onOpen={() => {
              row.action?.()
              onClose()
            }}
          />
        ))}
        {noMatches && (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            No matches
          </p>
        )}
      </div>
    </div>
  )
}

function FilterTrigger({
  label,
  set,
  children,
}: {
  label: string
  /** The filter narrows the search. */
  set: boolean
  children: ReactNode
}) {
  return (
    <SelectTrigger
      aria-label={label}
      className={cn(
        "h-8 w-auto max-w-[45%] gap-1.5 rounded-full px-3",
        set ? "bg-surface-selected text-foreground" : "text-muted-foreground"
      )}
    >
      <SelectValue>{children}</SelectValue>
    </SelectTrigger>
  )
}

function PaletteRow({
  id,
  row,
  tokens,
  active,
  onPoint,
  onOpen,
}: {
  id: string
  row: Row
  tokens: string[]
  active: boolean
  onPoint: () => void
  onOpen: () => void
}) {
  const body = (
    <>
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-muted-foreground">
        {row.icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-3">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            <Highlighted text={row.title} tokens={tokens} />
          </span>
          {row.location && (
            <span className="flex max-w-[45%] min-w-0 shrink-0 justify-end">
              {row.location}
            </span>
          )}
        </span>
        {row.excerpt && (
          <span className="truncate text-xs text-muted-foreground">
            <Highlighted text={row.excerpt} tokens={tokens} />
          </span>
        )}
      </span>
    </>
  )
  const className =
    "flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left outline-none aria-selected:bg-surface-hover"
  const common = {
    id,
    role: "option" as const,
    "aria-selected": active,
    onPointerMove: active ? undefined : onPoint,
    className,
  }
  return (
    <>
      {row.heading && (
        <div
          role="presentation"
          className="px-3 pt-3 pb-1 text-xs font-medium text-muted-foreground first:pt-1"
        >
          {row.heading}
        </div>
      )}
      {row.target ? (
        <Link
          {...row.target}
          {...common}
          // The field keeps the focus; rows are chosen from it.
          tabIndex={-1}
          onClick={onOpen}
        >
          {body}
        </Link>
      ) : row.action ? (
        <button type="button" {...common} tabIndex={-1} onClick={onOpen}>
          {body}
        </button>
      ) : (
        <div
          {...common}
          aria-disabled="true"
          className={cn(className, "opacity-60")}
        >
          {body}
        </div>
      )}
    </>
  )
}
