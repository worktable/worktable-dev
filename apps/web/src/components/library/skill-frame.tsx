import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { toast } from "@worktable/ui/components/sonner"
import { ChangeBar } from "@/components/library/change-bar"
import { LibraryMark } from "@/components/library/library-mark"
import { DOCUMENT_BYLINE_CHIP } from "@/components/document-organize"
import { libraryKey, skillTitle, type LibraryEntry } from "@/lib/library"
import {
  useLibraryActions,
  useLibraryName,
  useSavedBy,
  type LibraryAction,
} from "@/lib/library-actions"

/**
 * When agents use the skill, typed in place under its title, as a Space's
 * description is under its name. Enter or leaving the line keeps it; Escape
 * puts back what it said.
 */
function WhenToUse({ entry }: { entry: LibraryEntry }) {
  const { describe } = useLibraryActions()
  const [value, setValue] = useState(entry.description)
  const [shown, setShown] = useState(entry.description)
  // Someone else's change, or this one once saved, is what the line says.
  if (entry.description !== shown) {
    setShown(entry.description)
    setValue(entry.description)
  }
  const keep = async () => {
    const next = value.replace(/\s+/g, " ").trim()
    if (!next || next === entry.description) return setValue(entry.description)
    const refused = await describe(entry.id, { description: next })
    if (refused) {
      toast.error(refused)
      setValue(entry.description)
    }
  }
  const className = "block w-full pb-3 text-[0.9375rem] leading-6"
  if (!entry.mayChange || entry.removed) {
    // Not a paragraph: the Doc's paragraph spacing would move the line below.
    return <div className={className}>{entry.description}</div>
  }
  return (
    <textarea
      rows={1}
      value={value}
      maxLength={280}
      aria-label="When To Use"
      placeholder="When to use this"
      className={`${className} field-sizing-content resize-none bg-transparent text-muted-foreground transition-colors outline-none placeholder:text-muted-foreground/60 hover:text-foreground focus:text-foreground`}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => void keep()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault()
          event.currentTarget.blur()
        } else if (event.key === "Escape") {
          setValue(entry.description)
          event.currentTarget.blur()
        }
      }}
    />
  )
}

/**
 * What sits under a skill's title, in the place a Doc's byline does: when
 * agents use it, whose library it is and who made its version live, then
 * whatever waits on it with the way to decide.
 */
export function SkillHead({
  entry,
  at,
  pending,
  onAct,
}: {
  entry: LibraryEntry
  /** What waits, so a newer change is compared afresh. */
  at: string
  pending: boolean
  onAct: (action: LibraryAction) => void
}) {
  const libraryName = useLibraryName()
  const savedBy = useSavedBy()
  const [comparing, setComparing] = useState(false)
  const saved = entry.live ? savedBy(entry.live) : null
  const name = libraryName(entry)
  const key = libraryKey(entry.library)
  const decides = Boolean(entry.proposal || entry.draft || entry.removed)
  return (
    <div className="worktable-doc-byline" data-doc-byline>
      <WhenToUse entry={entry} />
      <div className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1.5">
        <Link
          to="/library/$"
          params={{ _splat: key }}
          className={DOCUMENT_BYLINE_CHIP}
        >
          <LibraryMark
            library={entry.library}
            name={name}
            className="size-4 text-[9px] [&_svg]:size-3"
          />
          {name}
        </Link>
        {saved && (
          <span title={saved.title}>
            {saved.name} saved {saved.when}
          </span>
        )}
      </div>
      {decides && (
        <ChangeBar
          entry={entry}
          compare={
            entry.removed
              ? undefined
              : {
                  at,
                  open: comparing,
                  onToggle: () => setComparing((open) => !open),
                }
          }
          pending={pending}
          onAct={(action) => {
            setComparing(false)
            onAct(action)
          }}
          className="mt-3"
        />
      )}
    </div>
  )
}

/**
 * A skill as its Doc opens, shown the moment it is chosen: the same title and
 * head in the Doc's own frame, until the Doc's page takes its place.
 */
export function SkillFrame({
  entry,
  children,
}: {
  entry: LibraryEntry
  children?: React.ReactNode
}) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="worktable-document-content">
        <div className="worktable-markdown">
          <h1 className="mt-0!">{skillTitle(entry)}</h1>
        </div>
        {children ?? (
          <SkillHead entry={entry} at="" pending onAct={() => undefined} />
        )}
      </div>
    </div>
  )
}
