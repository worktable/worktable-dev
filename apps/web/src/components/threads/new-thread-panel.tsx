import type { ComponentProps, ReactNode, Ref } from "react"
import { ArrowLeftIcon } from "lucide-react"
import type { ParticipantRef } from "@worktable/types"
import { Button } from "@worktable/ui/components/button"
import { useScrollFade } from "@/hooks/use-scroll-fade"
import { Composer, ComposerSeparator } from "@/components/composer"
import { ParticipantSelect } from "@/components/participant-select"

interface NewThreadPanelProps extends Pick<ComponentProps<typeof Composer>, "mentionTargets" | "mentionIdentityIds" | "onMentionIdentityIdsChange"> {
  participants: ParticipantRef[]
  participantsError: boolean
  recipient: string
  onRecipientChange: (value: string) => void
  draft: string
  onDraftChange: (value: string) => void
  onSubmit: () => void
  pending: boolean
  error?: string
  composerRef: Ref<HTMLTextAreaElement>
  locationControl?: ReactNode
  locationLabel: string
  onRetryParticipants: () => void
  onBack: () => void
}

export function NewThreadPanel({
  participants,
  participantsError,
  recipient,
  onRecipientChange,
  draft,
  onDraftChange,
  onSubmit,
  pending,
  error,
  composerRef,
  locationControl,
  locationLabel,
  onRetryParticipants,
  onBack,
  mentionTargets,
  mentionIdentityIds,
  onMentionIdentityIdsChange,
}: NewThreadPanelProps) {
  const scrollRef = useScrollFade<HTMLDivElement>()
  const selectedParticipant = participants.find(
    (participant) => participant.id === recipient
  )

  return (
    <>
      <header className="flex shrink-0 items-center gap-3 px-4 pt-5 pb-4 md:hidden">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Back to threads"
          onClick={onBack}
        >
          <ArrowLeftIcon />
        </Button>
        <div>
          <p className="text-xs text-muted-foreground">Threads</p>
          <h2 className="font-display text-lg font-semibold">New thread</h2>
        </div>
      </header>

      <div
        ref={scrollRef}
        className="scroll-fade min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 sm:py-8"
      >
        <div className="mx-auto flex min-h-full w-full max-w-2xl items-center py-6 pb-[10vh]">
          <div className="w-full">
            <h2 className="text-center text-2xl font-medium tracking-tight text-foreground sm:text-3xl">
              What should we work on?
            </h2>

            <div className="mt-7">
              <Composer
                ref={composerRef}
                value={draft}
                onChange={onDraftChange}
                onSubmit={onSubmit}
                pending={pending}
                error={error}
                placeholder={
                  selectedParticipant
                    ? `Message ${selectedParticipant.name}…`
                    : "Start a thread…"
                }
                mentionTargets={mentionTargets}
                mentionIdentityIds={mentionIdentityIds}
                onMentionIdentityIdsChange={onMentionIdentityIdsChange}
                placement="inline"
                toolbarActions={
                  <>
                    {locationControl ?? (
                      <span className="flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium text-muted-foreground max-sm:h-11">
                        <span className="max-w-32 truncate">
                          {locationLabel}
                        </span>
                      </span>
                    )}
                    <ComposerSeparator />
                    <ParticipantSelect
                      label="Reply from"
                      prefix="Reply from"
                      choices={[
                        { id: "unaddressed", name: "No one" },
                        ...(recipient && !selectedParticipant
                          ? [{ id: recipient, name: "Unavailable participant" }]
                          : []),
                        ...participants.map((participant) => ({
                          id: participant.id,
                          name: participant.name,
                          participant,
                        })),
                      ]}
                      value={recipient || "unaddressed"}
                      onChange={(value) =>
                        onRecipientChange(value === "unaddressed" ? "" : value)
                      }
                      className="max-w-44 gap-1 px-2 whitespace-nowrap"
                    />
                  </>
                }
              />
              {participantsError ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  Could not load participants.{" "}
                  <button
                    type="button"
                    onClick={onRetryParticipants}
                    className="text-primary-text hover:underline"
                  >
                    Retry
                  </button>
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
