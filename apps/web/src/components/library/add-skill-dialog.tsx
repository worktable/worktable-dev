import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { Search } from "lucide-react"
import { useDeferredValue, useState } from "react"
import { Input } from "@worktable/ui/components/input"
import { cn } from "@worktable/ui/lib/utils"
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@worktable/ui/components/responsive-dialog"
import {
  DocLocation,
  DocumentFormatIcon,
} from "@/components/document-format-icon"
import { AddToLibraryDialog } from "@/components/library/add-to-library-dialog"
import { useIsMobile } from "@/hooks/use-mobile"
import { type LibraryEntry, type LibraryRef } from "@/lib/library"
import { recentQueryOptions } from "@/lib/lifetime"
import { searchQueryOptions, useSpaces } from "@/lib/queries"

/** A Doc that could become a skill. */
export interface DocChoice {
  spaceId: string
  path: string
  title: string
  formatId?: string
}

/** Formats a skill can be: the Docs agents read as text. */
const SKILL_FORMATS = new Set(["worktable.markdown", "worktable.rich-text"])

/**
 * Find the Doc agents should follow: the Docs worked on lately until a search
 * is typed, then what it finds. Docs that are skills already aren't offered.
 * A Space's library offers that Space's Docs.
 */
export function DocPicker({
  library,
  skills,
  shown,
  autoFocus = false,
  className,
  listClassName,
  recentLabel = false,
  onPick,
}: {
  library?: LibraryRef
  skills: LibraryEntry[]
  /** How many Docs to offer at most. */
  shown: number
  autoFocus?: boolean
  className?: string
  /** Where the found Docs sit, under the field. */
  listClassName?: string
  /** Name the Docs offered before a search as recent ones. */
  recentLabel?: boolean
  onPick: (doc: DocChoice) => void
}) {
  const { data: spaces } = useSpaces()
  const spaceId = library?.kind === "space" ? library.spaceId : undefined
  const [query, setQuery] = useState("")
  const asked = useDeferredValue(query.trim())
  const found = useQuery({
    ...searchQueryOptions({ query: asked, spaceId, maxResults: 30 }),
    enabled: asked.length > 0,
    placeholderData: keepPreviousData,
  })
  // Before a search, the Docs worked on lately are the likely ones.
  const recent = useQuery({
    ...recentQueryOptions({
      ...(spaceId ? { spaceId } : {}),
      sort: "updated",
      includeTemporary: false,
      limit: 30,
    }),
    staleTime: 30_000,
  })
  const spaceNames = new Map(
    (spaces ?? []).map((space) => [space.id, space.name])
  )
  const taken = new Set(
    skills.map((entry) => `${entry.doc.spaceId}/${entry.docPath}`)
  )
  const choices: DocChoice[] = (
    asked
      ? (found.data ?? [])
          .filter(
            (result) =>
              result.type === "doc" &&
              result.path &&
              result.documentKind !== "conflict" &&
              (!result.format || SKILL_FORMATS.has(result.format.id))
          )
          .map((result) => ({
            spaceId: result.spaceId,
            path: result.path!,
            title: result.title,
            formatId: result.format?.id,
          }))
      : (recent.data?.items ?? [])
          .filter((item) => SKILL_FORMATS.has(item.document.format.id))
          .map((item) => ({
            spaceId: item.spaceId,
            path: item.document.path,
            title: item.document.title,
            formatId: item.document.format.id,
          }))
  ).filter((doc) => !taken.has(`${doc.spaceId}/${doc.path}`))

  return (
    <div className={className}>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          placeholder="Find a Doc"
          aria-label="Find a Doc"
          autoFocus={autoFocus}
          autoComplete="off"
          className="pl-9"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query) {
              event.stopPropagation()
              setQuery("")
            }
          }}
        />
      </div>
      <div className={cn("mt-1", listClassName)}>
        {recentLabel && !asked && choices.length > 0 && (
          <p className="px-2.5 pt-2 pb-1 text-xs text-muted-foreground">
            Recent Docs
          </p>
        )}
        {choices.length === 0
          ? asked &&
            !found.isFetching && (
              <p className="flex h-10 items-center px-2.5 text-sm text-muted-foreground">
                No Docs found.
              </p>
            )
          : choices.slice(0, shown).map((doc) => (
              <button
                key={`${doc.spaceId}/${doc.path}`}
                type="button"
                className="group flex h-10 w-full min-w-0 items-center gap-3 rounded-lg px-2.5 text-left text-sm transition-colors hover:bg-accent"
                onClick={() => onPick(doc)}
              >
                <DocumentFormatIcon
                  formatId={doc.formatId}
                  name={doc.path}
                  className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
                />
                <span className="min-w-0 truncate font-medium text-foreground">
                  {doc.title}
                </span>
                <DocLocation
                  spaceName={spaceId ? undefined : spaceNames.get(doc.spaceId)}
                  path={doc.path}
                />
              </button>
            ))}
      </div>
    </div>
  )
}

/**
 * Add a skill: find the Doc agents should follow, then say when they use it
 * and whose library it goes in.
 */
export function AddSkillDialog({
  library,
  skills,
  doc,
  onClose,
}: {
  /** The library the skill is for, when started from one. */
  library?: LibraryRef
  /** The skills there are, whose Docs aren't offered again. */
  skills: LibraryEntry[]
  /** The Doc, when it was chosen already. */
  doc?: DocChoice
  onClose: () => void
}) {
  const isMobile = useIsMobile()
  const [choice, setChoice] = useState<DocChoice | null>(doc ?? null)

  if (choice) {
    return (
      <AddToLibraryDialog
        spaceId={choice.spaceId}
        docPath={choice.path}
        title={choice.title}
        library={library}
        onClose={onClose}
      />
    )
  }
  return (
    <ResponsiveDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <ResponsiveDialogContent className="sm:max-w-md">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Add Skill</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody>
          {/* Room for the likely Docs; a search finds the rest. */}
          <DocPicker
            library={library}
            skills={skills}
            shown={7}
            autoFocus={!isMobile}
            className="min-h-80"
            onPick={setChoice}
          />
        </ResponsiveDialogBody>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
