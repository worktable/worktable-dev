import { useRef, useState } from "react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@worktable/ui/components/select"
import { ThreadParticipantAvatar } from "@/components/threads/thread-participant-avatar"
import { NO_RECIPIENT, type CommentRecipients } from "@/lib/comment-recipients"

export function CommentRecipientSelect({
  recipients,
  value,
  onChange,
}: {
  recipients: CommentRecipients
  value: string
  onChange: (value: string) => void
}) {
  const selected = recipients.options.find(
    (participant) => participant.id === value
  )
  const triggerRef = useRef<HTMLButtonElement>(null)
  // Inside a drawer or dialog the options open there too: a press on them
  // outside it would count as leaving the comment box.
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
        aria-label="Send to"
        className="h-8 w-auto max-w-full rounded-full border-transparent bg-transparent px-2.5 text-xs shadow-none hover:bg-muted max-sm:h-11"
      >
        <span className="text-muted-foreground">To</span>
        {selected && (
          <ThreadParticipantAvatar participant={selected} className="size-5" />
        )}
        <SelectValue>{selected?.name ?? "No one"}</SelectValue>
      </SelectTrigger>
      <SelectContent container={container}>
        <SelectItem value={NO_RECIPIENT}>No one</SelectItem>
        {recipients.options.map((participant) => (
          <SelectItem key={participant.id} value={participant.id}>
            {participant.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
