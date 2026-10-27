import { useRef, useState } from "react"
import type { ParticipantRef } from "@worktable/types"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@worktable/ui/components/select"
import { cn } from "@worktable/ui/lib/utils"
import { ThreadParticipantAvatar } from "@/components/threads/thread-participant-avatar"

/** A person or agent in a list: their picture, name, and why they're there. */
export function ParticipantRow({
  participant,
  name,
  hint,
}: {
  participant?: ParticipantRef
  name: string
  hint?: string
}) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      {/* The name is written beside the picture. */}
      <span className="size-5 shrink-0" aria-hidden="true">
        {participant ? (
          <ThreadParticipantAvatar participant={participant} className="size-5" />
        ) : null}
      </span>
      <span className="min-w-0">
        <span className="block truncate">{name}</span>
        {hint ? (
          <span className="block truncate text-xs text-muted-foreground">
            {hint}
          </span>
        ) : null}
      </span>
    </span>
  )
}

export interface ParticipantChoice {
  id: string
  name: string
  participant?: ParticipantRef
  hint?: string
}

/**
 * Choose one person or agent: a pill with who is chosen, opening a list with
 * their pictures. Inside a drawer or dialog the list opens there too, since
 * a press outside it would count as leaving.
 */
export function ParticipantSelect({
  label,
  prefix,
  placeholder,
  choices,
  value,
  onChange,
  className,
}: {
  /** Names the control for assistive tech. */
  label: string
  /** A word before the choice, such as "To". */
  prefix?: string
  /** Shown when nothing is chosen. */
  placeholder?: string
  choices: ParticipantChoice[]
  value: string
  onChange: (value: string) => void
  className?: string
}) {
  const selected = choices.find((choice) => choice.id === value)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [container, setContainer] = useState<HTMLElement | undefined>()
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next)
      }}
      onOpenChange={(open) => {
        if (!open) return
        setContainer(
          triggerRef.current?.closest<HTMLElement>(
            '[data-vaul-drawer], [role="dialog"][aria-modal="true"]'
          ) ?? undefined
        )
      }}
    >
      <SelectTrigger
        ref={triggerRef}
        aria-label={label}
        className={cn(
          "h-8 w-auto max-w-full shrink-0 rounded-full border-transparent bg-transparent px-2.5 text-xs shadow-none hover:bg-muted max-sm:h-11",
          className
        )}
      >
        {prefix ? (
          <span className="text-muted-foreground">{prefix}</span>
        ) : null}
        {selected?.participant ? (
          <span aria-hidden="true">
            <ThreadParticipantAvatar
              participant={selected.participant}
              className="size-5"
            />
          </span>
        ) : null}
        <SelectValue>{selected?.name ?? placeholder}</SelectValue>
      </SelectTrigger>
      <SelectContent container={container} className="min-w-56">
        {choices.map((choice) => (
          <SelectItem key={choice.id} value={choice.id} label={choice.name}>
            <ParticipantRow
              participant={choice.participant}
              name={choice.name}
              hint={choice.hint}
            />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
