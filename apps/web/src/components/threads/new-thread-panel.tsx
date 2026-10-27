import type { ReactNode, Ref } from "react"
import { ArrowLeftIcon, BotIcon, CircleAlertIcon } from "lucide-react"
import type { ParticipantRef } from "@worktable/types"
import { Button } from "@worktable/ui/components/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@worktable/ui/components/empty"
import { Spinner } from "@worktable/ui/components/spinner"

import { useScrollFade } from "@/hooks/use-scroll-fade"
import { openSettings } from "@/lib/settings-open"
import { Composer, ComposerSeparator } from "@/components/composer"
import { ParticipantSelect } from "@/components/participant-select"

interface NewThreadPanelProps {
  participants: ParticipantRef[]
  participantsLoading: boolean
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
  participantsLoading,
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
        {participantsLoading ? (
          <Empty className="min-h-full">
            <EmptyHeader>
              <EmptyMedia>
                <Spinner />
              </EmptyMedia>
              <EmptyTitle>Finding connected participants</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : participantsError ? (
          <Empty className="min-h-full">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <CircleAlertIcon />
              </EmptyMedia>
              <EmptyTitle>Could not load participants</EmptyTitle>
              <EmptyDescription>
                Check the connection and try again.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" size="sm" onClick={onRetryParticipants}>
                Retry
              </Button>
            </EmptyContent>
          </Empty>
        ) : participants.length === 0 ? (
          <Empty className="min-h-full">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BotIcon />
              </EmptyMedia>
              <EmptyTitle>No connected participants</EmptyTitle>
              <EmptyDescription>
                Connect an agent before starting a conversation.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button size="sm" onClick={() => openSettings("agents")}>
                Open Agent settings
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
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
                  disabled={!recipient}
                  placeholder={`Message ${selectedParticipant?.name ?? "a participant"}…`}
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
                        label="Thread participant"
                        placeholder="Choose a participant"
                        choices={participants.map((participant) => ({
                          id: participant.id,
                          name: participant.name,
                          participant,
                        }))}
                        value={recipient}
                        onChange={onRecipientChange}
                        className="max-w-36"
                      />
                    </>
                  }
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
