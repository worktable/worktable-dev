import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react"
import { Link, useRouterState, type LinkProps } from "@tanstack/react-router"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import {
  Database,
  History,
  LayoutDashboard,
  Library as LibraryIcon,
  MessageCircle,
  ChevronDown,
  Search,
  Settings,
  X,
} from "lucide-react"
import {
  type FoundResult,
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@worktable/ui/components/dropdown-menu"
import { cn } from "@worktable/ui/lib/utils"
import { DocumentFormatIcon } from "@/components/document-format-icon"
import { RecentOpenIcon } from "@/components/sidebar/recent-open-icon"
import { SpaceIcon } from "@/components/spaces/space-icon"
import { useSkillLibrariesEnabled } from "@/hooks/use-deployment-info"
import { useIsMobile } from "@/hooks/use-mobile"
import { libraryKey } from "@/lib/library"
import { getSpaceArchiveInfo } from "@/lib/spaces"
import { searchQueryOptions, useSpaces, useWorkspace } from "@/lib/queries"
import {
  readRecentOpens,
  recentOpenSpace,
  type RecentOpen,
} from "@/lib/recent-opens"
import { countMessageOpening } from "@/lib/message-openings"
import { matchPlaces } from "@/lib/search-places"
import { openSettings } from "@/lib/settings-open"

/** How long typing rests before a search is sent. */
const SEARCH_DELAY_MS = 180

/** Each file type, with the format its rows show the icon of. */
const KINDS: ReadonlyArray<{
  kind: SearchKind
  label: string
  formatId?: string
}> = [
  { kind: "doc", label: "Docs", formatId: "worktable.rich-text" },
  { kind: "html", label: "HTML Docs", formatId: "worktable.html" },
  { kind: "drawing", label: "Drawings", formatId: "worktable.quickdraw" },
  { kind: "file", label: "Files", formatId: "worktable.file" },
  { kind: "record", label: "Records" },
  { kind: "thread", label: "Threads" },
]

/** A filter left open: the menu needs a value for "no filter". */
const ANY = "any"

/**
 * Where a row leads. Rows of every kind share one list, so each names its
 * route here and the list hands it to the router's link.
 */
interface LinkTarget {
  to: string
  params?: Record<string, string>
  search?: Record<string, string>
}

interface Row {
  key: string
  title: string
  icon: ReactNode
  /** Where the row leads; a row without one can't be opened. */
  target?: LinkTarget
  /** Runs when the row is chosen, before its navigation or in place of one. */
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
          part
        )
      )}
    </>
  )
}

/** Where a skill opens: in the Library, under its library. */
const skillSplat = (skill: NonNullable<SearchResult["skill"]>) =>
  `${libraryKey(skill.library)}/${skill.id}`

const ICON = "size-4"

/** The folder a path is in, if any. */
function folderOf(path: string | undefined): string | undefined {
  const at = path?.lastIndexOf("/") ?? -1
  return at > 0 ? path!.slice(0, at) : undefined
}

/** Where a result lives, as one line: its Space, then its folders. */
function place(spaceName: string | undefined, folder: string | undefined) {
  const text = [spaceName, ...(folder ? folder.split("/") : [])]
    .filter(Boolean)
    .join(" / ")
  return text ? (
    <span className="truncate font-mono text-[0.7rem] text-muted-foreground/80">
      {text}
    </span>
  ) : undefined
}

function resultRow(
  result: FoundResult,
  spaces: ReadonlyMap<string, SpaceFile>,
  worktableName: string
): Row {
  if (result.type === "thread") {
    // Opens at the message that matched, in the thread's own place.
    const search = { message: result.messageId }
    return {
      key: `result:thread:${result.spaceId ?? ""}:${result.threadId}`,
      title: result.title,
      icon: <MessageCircle className={ICON} />,
      // Shows the message again when this result is chosen again.
      action: countMessageOpening,
      target:
        result.location.kind === "space"
          ? {
              to: "/spaces/$spaceId/threads/$",
              params: { spaceId: result.location.spaceId, _splat: result.threadId },
              search,
            }
          : {
              to: "/threads/$",
              params: { _splat: `worktable/${result.threadId}` },
              search,
            },
      ...(result.excerpt ? { excerpt: result.excerpt } : {}),
      location: place(
        result.location.kind === "space"
          ? spaces.get(result.location.spaceId)?.name
          : worktableName,
        undefined
      ),
    }
  }
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
      ...(result.excerpt ? { excerpt: result.excerpt } : {}),
      location: place(
        result.skill.library.kind === "worktable"
          ? worktableName
          : (result.skill.libraryName ?? "Library"),
        undefined
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
        ...(result.recordId ? { search: { record: result.recordId } } : {}),
      },
      ...(result.excerpt ? { excerpt: result.excerpt } : {}),
      location: place(spaceName, result.collectionId),
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
    ...(result.excerpt ? { excerpt: result.excerpt } : {}),
    location: place(spaceName, folderOf(path)),
  }
}

function recentRow(
  open: RecentOpen,
  spaces: ReadonlyMap<string, SpaceFile>
): Row {
  const [, spaceId, section, rest] =
    open.path.match(/^\/spaces\/([^/]+)(?:\/([^/]+)\/(.*))?$/) ?? []
  const spaceName = spaceId ? spaces.get(spaceId)?.name : undefined
  return {
    key: `recent:${open.path}`,
    title: open.title,
    icon: <RecentOpenIcon open={open} className={ICON} />,
    // A path this app showed; the router takes it as it is.
    target: { to: open.path },
    ...(spaceName
      ? {
          location: place(
            spaceName,
            section === "documents" ? folderOf(rest) : undefined
          ),
        }
      : {}),
  }
}

/** Recent pages search offers before anything is typed. */
const SEARCH_RECENT_ROWS = 12

/** What a search remembers between openings while the app is open. */
export interface SearchState {
  query: string
  kind: SearchKind | null
  spaceId: string | null
}

/**
 * Search over the page. Its code loads on its own, when the tab is idle or
 * search first opens; the sidebar's host keeps what was typed.
 */
export default function SearchPalette({
  open,
  onOpenChange,
  state,
  onStateChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  state: SearchState
  onStateChange: (state: SearchState) => void
}) {
  const { query, kind, spaceId } = state
  const setOpen = onOpenChange
  const setQuery = (next: string) => onStateChange({ ...state, query: next })
  const setKind = (next: SearchKind | null) =>
    onStateChange({ ...state, kind: next })
  const setSpaceId = (next: string | null) =>
    onStateChange({ ...state, spaceId: next })
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

  const {
    data: found,
    isPlaceholderData,
    isError,
  } = useQuery({
    ...searchQueryOptions({
      query: searched,
      maxResults: 50,
      includeArchived: true,
      archivedLast: true,
      ...(kind ? { kind } : {}),
      ...(spaceId ? { spaceId } : {}),
    }),
    select: (answer) => answer,
    placeholderData: keepPreviousData,
  })
  const results = found?.results
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
        target: { to: "/" } satisfies LinkTarget,
      },
      {
        id: "threads",
        name: "Threads",
        icon: <MessageCircle className={ICON} />,
        target: {
          to: "/threads/$",
          params: { _splat: "" },
          search: { location: "all" },
        } satisfies LinkTarget,
      },
      {
        id: "activity",
        name: "Activity",
        icon: <History className={ICON} />,
        target: { to: "/activity" } satisfies LinkTarget,
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
              } satisfies LinkTarget,
            },
          ]
        : []),
      {
        id: "settings",
        name: "Settings",
        icon: <Settings className={ICON} />,
        action: () => openSettings(),
      },
      // Archived Spaces are found by what's in them, under Archived.
      ...(spaces ?? [])
        .filter((space) => !getSpaceArchiveInfo(space))
        .map((space) => ({
          id: `space:${space.id}`,
          name: space.name,
          icon: <SpaceIcon space={space} size="xs" variant="glyph" />,
          target: {
            to: "/spaces/$spaceId",
            params: { spaceId: space.id },
          } satisfies LinkTarget,
        })),
    ],
    [skillLibraries, spaces]
  )

  // The words typed, and the words a misspelled one was searched as.
  const tokens = useMemo(
    () => [...searched.split(/\s+/).filter(Boolean), ...(found?.corrected ?? [])],
    [searched, found?.corrected]
  )

  const rows = useMemo<Row[]>(() => {
    if (!typed) {
      // Only pages in Spaces this person can still open.
      const reachable = recent
        .filter((open) => {
          const spaceId = recentOpenSpace(open)
          // A Space's pages show once its list confirms access.
          return !spaceId || spacesById.has(spaceId)
        })
        .slice(0, SEARCH_RECENT_ROWS)
      return reachable.map((open, index) => ({
        ...recentRow(open, spacesById),
        ...(index === 0 ? { heading: "Recent" } : {}),
      }))
    }
    // A filter narrows to content, so places only show without one.
    const placeRows =
      kind === null && spaceId === null ? matchPlaces(places, typed) : []
    const found: Row[] = placeRows.map((place) => ({
      key: `place:${place.id}`,
      title: place.name,
      icon: place.icon,
      ...("target" in place ? { target: place.target } : {}),
      ...("action" in place ? { action: place.action } : {}),
    }))
    let archived = false
    // A search that failed shows none of an earlier query's results.
    for (const result of searched && !isError ? (results ?? []) : []) {
      const row = resultRow(result, spacesById, worktableName)
      if (result.archived && !archived) {
        archived = true
        row.heading = "Archived"
      }
      found.push(row)
    }
    return found
  }, [
    typed,
    searched,
    recent,
    places,
    results,
    spaces,
    spacesById,
    worktableName,
    isError,
    kind,
    spaceId,
  ])

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

  // Current Spaces by name, then archived ones apart: archived work is
  // searched too.
  const spaceOptions = useMemo<FilterOption[]>(
    () =>
      [...(spaces ?? [])]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((space) => ({
          value: space.id,
          label: space.name,
          icon: <SpaceIcon space={space} size="xs" variant="glyph" />,
          ...(getSpaceArchiveInfo(space) ? { archived: true } : {}),
        })),
    [spaces]
  )

  const kindLabel = KINDS.find((item) => item.kind === kind)?.label
  const spaceName = spaceId ? spacesById.get(spaceId)?.name : undefined
  const noMatches =
    typed !== "" && settled && results !== undefined && rows.length === 0
  // Places still match without the server; results can't.
  const failed = typed !== "" && searched === typed && isError

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
        <FilterMenu
          label="File Type"
          anyLabel="Any File Type"
          value={kind}
          valueLabel={kindLabel}
          options={KINDS.map((item) => ({
            value: item.kind,
            label: item.label,
            icon: item.formatId ? (
              <DocumentFormatIcon formatId={item.formatId} className={ICON} />
            ) : item.kind === "thread" ? (
              <MessageCircle className={ICON} />
            ) : (
              <Database className={ICON} />
            ),
          }))}
          onChange={(next) =>
            onKindChange(KINDS.find((item) => item.kind === next)?.kind ?? null)
          }
          returnFocus={input}
        />
        <FilterMenu
          label="Space"
          anyLabel="Any Space"
          value={spaceId}
          valueLabel={spaceName}
          options={spaceOptions}
          onChange={onSpaceChange}
          returnFocus={input}
        />
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
        {failed ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            Couldn't search. Try again.
          </p>
        ) : (
          noMatches && (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              No matches
            </p>
          )
        )}
      </div>
    </div>
  )
}

/**
 * One filter under the field: a chip naming what it narrows to, opening a
 * menu of choices. Closing the menu hands the keys back to the field, so the
 * arrows move through results again.
 */
function FilterMenu({
  label,
  anyLabel,
  value,
  valueLabel,
  options,
  onChange,
  returnFocus,
}: {
  label: string
  anyLabel: string
  value: string | null
  valueLabel: string | undefined
  options: ReadonlyArray<FilterOption>
  onChange: (value: string | null) => void
  returnFocus: RefObject<HTMLInputElement | null>
}) {
  return (
    <DropdownMenu
      // Once the menu has finished closing, the keys go back to the field.
      onOpenChangeComplete={(open) => {
        if (!open) returnFocus.current?.focus()
      }}
    >
      <DropdownMenuTrigger
        aria-label={label}
        className={cn(
          "well well-interactive flex h-8 max-w-[45%] min-w-0 items-center gap-1.5 rounded-full border border-input px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
          value !== null
            ? "bg-surface-selected text-foreground"
            : "text-muted-foreground"
        )}
      >
        <span className="truncate">{valueLabel ?? label}</span>
        <ChevronDown className="size-3.5 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        finalFocus={false}
        // Never taller than the room the screen leaves.
        className="max-h-[min(18rem,var(--available-height))] w-auto min-w-44"
      >
        <DropdownMenuRadioGroup
          aria-label={label}
          value={value ?? ANY}
          onValueChange={(next: string) => onChange(next === ANY ? null : next)}
        >
          <DropdownMenuRadioItem value={ANY} closeOnClick>
            {anyLabel}
          </DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          {options
            .filter((option) => !option.archived)
            .map((option) => (
              <FilterItem key={option.value} option={option} />
            ))}
          {options.some((option) => option.archived) && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>Archived</DropdownMenuLabel>
                {options
                  .filter((option) => option.archived)
                  .map((option) => (
                    <FilterItem key={option.value} option={option} />
                  ))}
              </DropdownMenuGroup>
            </>
          )}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface FilterOption {
  value: string
  label: string
  icon?: ReactNode
  /** Listed apart, after the rest. */
  archived?: boolean
}

function FilterItem({ option }: { option: FilterOption }) {
  return (
    <DropdownMenuRadioItem value={option.value} closeOnClick>
      {option.icon}
      <span className="truncate">{option.label}</span>
    </DropdownMenuRadioItem>
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
      {/* The place sits beside the title; a phone gives the title the whole
          width and the place the last line. */}
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          <Highlighted text={row.title} tokens={tokens} />
        </span>
        {row.location && (
          <span className="order-last flex min-w-0 basis-full sm:order-none sm:max-w-[45%] sm:basis-auto sm:justify-end">
            {row.location}
          </span>
        )}
        {row.excerpt && (
          <span className="basis-full truncate text-xs text-muted-foreground">
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
          // The targets are this app's own routes, named as plain text.
          {...(row.target as LinkProps)}
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
