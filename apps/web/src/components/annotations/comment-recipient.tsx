import { ParticipantSelect } from "@/components/participant-select"
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
  return (
    <ParticipantSelect
      label="Send to"
      prefix="To"
      choices={[
        { id: NO_RECIPIENT, name: "No one" },
        ...recipients.options.map((participant) => ({
          id: participant.id,
          name: participant.name,
          participant,
          hint:
            participant.id === recipients.writer
              ? "Wrote this text"
              : participant.id === recipients.self
                ? "You"
                : undefined,
        })),
      ]}
      value={value}
      onChange={onChange}
    />
  )
}
