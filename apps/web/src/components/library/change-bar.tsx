import { PenLine, Trash2 } from "lucide-react"
import { useMemo } from "react"
import { Button } from "@worktable/ui/components/button"
import { cn } from "@worktable/ui/lib/utils"
import { ThreadParticipantAvatar } from "@/components/identity-icons"
import { SkillText } from "@/components/library/skill-text"
import { useScrollFade } from "@/hooks/use-scroll-fade"
import { type LibraryEntry } from "@/lib/library"
import {
  proposalText,
  useSkillChange,
  type LibraryAction,
} from "@/lib/library-actions"
import { changeOf } from "@/lib/library-view"

/** Whose change waits: the agent that proposed it, or a person's draft. */
function WaitingFace({ entry }: { entry: LibraryEntry }) {
  const proposal = entry.proposal
  const Icon = entry.removed ? Trash2 : PenLine
  return proposal ? (
    <ThreadParticipantAvatar
      participant={{
        kind: "agent",
        id: proposal.by.participantId,
        name: proposal.by.displayName,
      }}
      className="size-5 text-[9px]"
    />
  ) : (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-tint text-muted-foreground">
      <Icon className="size-3" />
    </span>
  )
}

/** The lines a waiting change adds and drops, read when Compare is pressed. */
function Comparison({ entry, at }: { entry: LibraryEntry; at: string }) {
  const change = useSkillChange(entry.id, at, true)
  const scrollRef = useScrollFade<HTMLDivElement>()
  const parts = useMemo(() => {
    if (!change.data) return undefined
    const { live, next, nextDescription } = change.data
    const removing = entry.proposal?.kind === "remove"
    return changeOf(entry, {
      live,
      ...(removing ? {} : { next }),
      nextDescription,
    })
  }, [change.data, entry])
  const same = parts?.every(
    (part) =>
      part.kind === "fold" || part.lines.every((line) => line.kind === "same")
  )
  return (
    <div
      ref={scrollRef}
      className="scroll-fade max-h-[40dvh] overflow-y-auto border-t border-border/60 px-3 py-2"
    >
      {change.data?.nextDescription && (
        <p className="mb-2 text-sm">
          <span className="text-muted-foreground line-through decoration-destructive/40">
            {entry.description}
          </span>{" "}
          <span className="text-foreground">{change.data.nextDescription}</span>
        </p>
      )}
      {parts === undefined ? (
        change.isError ? (
          <p className="text-sm text-muted-foreground">Unavailable</p>
        ) : (
          <div className="h-16" />
        )
      ) : parts === null ? (
        <p className="text-sm text-muted-foreground">Unavailable</p>
      ) : same && !change.data?.nextDescription ? (
        <p className="text-sm text-muted-foreground">No Changes</p>
      ) : same ? null : (
        <SkillText parts={parts} />
      )}
    </div>
  )
}

/**
 * What waits on a skill, with the way to decide it: Save for a person's
 * draft, Approve or Discard for an agent's proposal, Restore for a skill
 * removed. It sits under the skill's title.
 */
export function ChangeBar({
  entry,
  compare,
  pending,
  onAct,
  className,
}: {
  entry: LibraryEntry
  /**
   * Where the text beside the bar doesn't mark the change itself: what
   * waits, so a newer change is compared afresh, and whether it shows.
   */
  compare?: { at: string; open: boolean; onToggle: () => void }
  pending: boolean
  onAct: (action: LibraryAction) => void
  className?: string
}) {
  const proposal = entry.proposal
  return (
    <div className={cn("rounded-xl card-surface text-foreground", className)}>
      <div className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 py-1.5 pr-1.5 pl-3 font-sans text-sm leading-5 tracking-normal">
        <WaitingFace entry={entry} />
        <span className="min-w-0 flex-1 truncate">
          {entry.removed
            ? "Removed"
            : proposal
              ? proposalText(proposal)
              : "Draft Changes"}
        </span>
        {compare && (
          <Button
            size="xs"
            variant="ghost"
            aria-pressed={compare.open}
            className={cn(compare.open && "bg-surface-selected")}
            onClick={compare.onToggle}
          >
            Compare
          </Button>
        )}
        {!entry.mayChange ? null : entry.removed ? (
          <Button
            size="xs"
            disabled={pending}
            onClick={() => onAct({ kind: "restore", entry })}
          >
            Restore
          </Button>
        ) : proposal ? (
          <>
            <Button
              size="xs"
              variant="ghost"
              disabled={pending}
              onClick={() => onAct({ kind: "discard", entry })}
            >
              Discard
            </Button>
            <Button
              size="xs"
              disabled={pending}
              onClick={() => onAct({ kind: "approve", entry })}
            >
              Approve
            </Button>
          </>
        ) : (
          <Button
            size="xs"
            disabled={pending}
            onClick={() => onAct({ kind: "save", entry })}
          >
            Save
          </Button>
        )}
      </div>
      {compare?.open && <Comparison entry={entry} at={compare.at} />}
    </div>
  )
}
