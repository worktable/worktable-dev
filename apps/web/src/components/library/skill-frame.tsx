import { Link } from "@tanstack/react-router"
import { Pencil } from "lucide-react"
import { useState } from "react"
import { Button } from "@worktable/ui/components/button"
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

const WHEN_LABEL = "mb-0.5 block text-xs font-medium text-muted-foreground"
const WHEN_TEXT = "text-[0.9375rem] leading-6 text-foreground"

/**
 * When agents use the skill: a labeled field under the title, as an agent
 * reads it beside the skill's name. Pointing at it shows it can change; a
 * click opens it for typing, Save or Enter keeps it, Cancel or Escape puts
 * back what it said.
 */
function WhenToUse({ entry }: { entry: LibraryEntry }) {
  const { describe } = useLibraryActions()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(entry.description)
  const [saving, setSaving] = useState(false)
  const label = <span className={WHEN_LABEL}>When to use</span>
  if (!entry.mayChange || entry.removed) {
    // Not a paragraph: the Doc's paragraph spacing would move the line below.
    return (
      <div className="pb-3">
        {label}
        <div className={WHEN_TEXT}>{entry.description}</div>
      </div>
    )
  }
  const cancel = () => {
    setValue(entry.description)
    setEditing(false)
  }
  const keep = async () => {
    const next = value.replace(/\s+/g, " ").trim()
    if (!next || next === entry.description) return cancel()
    setSaving(true)
    const refused = await describe(entry.id, { description: next })
    setSaving(false)
    if (refused) return toast.error(refused)
    setEditing(false)
  }
  if (editing) {
    return (
      <div className="pb-3">
        <label htmlFor={`when-${entry.id}`} className={WHEN_LABEL}>
          When to use
        </label>
        <textarea
          id={`when-${entry.id}`}
          rows={1}
          value={value}
          maxLength={280}
          autoFocus
          disabled={saving}
          className={`${WHEN_TEXT} block field-sizing-content w-full resize-none rounded-lg border border-input bg-transparent px-2.5 py-1.5 outline-none focus:border-primary`}
          onFocus={(event) =>
            event.currentTarget.setSelectionRange(value.length, value.length)
          }
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              void keep()
            } else if (event.key === "Escape") {
              event.stopPropagation()
              cancel()
            }
          }}
        />
        <div className="mt-2 flex gap-2">
          <Button size="xs" disabled={saving} onClick={() => void keep()}>
            Save
          </Button>
          <Button size="xs" variant="ghost" disabled={saving} onClick={cancel}>
            Cancel
          </Button>
        </div>
      </div>
    )
  }
  return (
    <div className="pb-3">
      <button
        type="button"
        aria-label={`When to use: ${entry.description}. Edit`}
        className="group/when -mx-2.5 flex w-[calc(100%+1.25rem)] items-start gap-3 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none"
        onClick={() => {
          setValue(entry.description)
          setEditing(true)
        }}
      >
        <span className="min-w-0 flex-1">
          {label}
          <span className={`${WHEN_TEXT} block`}>{entry.description}</span>
        </span>
        <Pencil className="mt-0.5 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/when:opacity-100 group-focus-visible/when:opacity-100 max-md:opacity-100" />
      </button>
    </div>
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
