import { useEffect, useRef, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import {
  Archive,
  ArrowLeft,
  CalendarDays,
  ChevronRight,
  Clock3,
  Pin,
  PinOff,
  Infinity as InfinityIcon,
} from "lucide-react"
import { START_HERE_LIMIT } from "@worktable/types"
import { Button } from "@worktable/ui/components/button"
import { Calendar } from "@worktable/ui/components/calendar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  PopoverTitle,
  PopoverDescription,
} from "@worktable/ui/components/popover"
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@worktable/ui/components/dropdown-menu"
import { toast } from "@worktable/ui/components/sonner"
import { mutateDocument } from "@/lib/documents-api"
import {
  formatArchiveDate,
  setDocumentLifetime,
  setStartHere,
  useDocumentSummary,
  useRefreshDocumentLists,
} from "@/lib/lifetime"
import { spaceQueryOptions, useSpace } from "@/lib/queries"

function useLifetimeActions(spaceId: string, path: string) {
  const refresh = useRefreshDocumentLists(spaceId)
  const navigate = useNavigate()
  const run = async (action: () => Promise<unknown>, failure: string) => {
    try {
      await action()
      await refresh()
      return true
    } catch (error) {
      console.error(failure, error)
      toast.error(failure)
      return false
    }
  }
  return {
    keep: () =>
      run(
        () => setDocumentLifetime(spaceId, path, "durable"),
        "Couldn’t keep this document."
      ),
    makeTemporary: (archiveOn?: string) =>
      run(
        () => setDocumentLifetime(spaceId, path, "temporary", archiveOn),
        "Couldn’t change when this document archives."
      ),
    archiveNow: () =>
      run(async () => {
        await mutateDocument(spaceId, "archive", path)
        toast.success("Archived")
        await navigate({ to: "/spaces/$spaceId", params: { spaceId } })
      }, "Couldn’t archive this document."),
  }
}

/** Compare calendar days in the person's local timezone. */
function localDay(iso: string): Date {
  const date = new Date(iso)
  date.setHours(0, 0, 0, 0)
  return date
}

/** Quiet header chip for temporary documents; durable documents show nothing. */
export function DocumentLifetimeChip({
  spaceId,
  path,
}: {
  spaceId: string
  path: string
}) {
  const summary = useDocumentSummary(spaceId, path)
  const actions = useLifetimeActions(spaceId, path)
  const [open, setOpen] = useState(false)
  const [date, setDate] = useState<Date>()
  const [editingDate, setEditingDate] = useState(false)
  const [pending, setPending] = useState<"keep" | "date" | "archive" | null>(
    null
  )
  const changeDateRef = useRef<HTMLButtonElement>(null)
  const restoreDateFocus = useRef(false)
  useEffect(() => {
    if (!editingDate && restoreDateFocus.current) {
      changeDateRef.current?.focus()
      restoreDateFocus.current = false
    }
  }, [editingDate])
  if (summary?.lifetime !== "temporary" || !summary.archiveOn) return null
  const label = `Archives ${formatArchiveDate(summary.archiveOn)}`
  const currentDate = localDay(summary.archiveOn)
  // Today's midnight has already passed. Immediate archiving has its own action.
  const tomorrow = localDay(new Date().toISOString())
  tomorrow.setDate(tomorrow.getDate() + 1)
  const canSave =
    date && date >= tomorrow && date.getTime() !== currentDate.getTime()
  const run = async (
    kind: NonNullable<typeof pending>,
    action: () => Promise<boolean>
  ) => {
    if (pending) return
    setPending(kind)
    const saved = await action()
    setPending(null)
    if (saved) setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (pending) return
        setOpen(next)
        if (next) {
          setDate(currentDate)
          setEditingDate(false)
        }
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label={`Temporary. ${label}`}
          />
        }
      >
        <Clock3 className="size-3.5" />
        <span className="hidden sm:inline">{label}</span>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-84 max-w-[calc(100vw-1rem)] gap-3 p-3"
        aria-busy={pending !== null}
      >
        {editingDate ? (
          <>
            <div className="px-1 pt-1">
              <PopoverTitle>Change archive date</PopoverTitle>
              <PopoverDescription className="mt-1 text-xs">
                Edits, moves, and comments can extend this date.
              </PopoverDescription>
            </div>
            <Calendar
              mode="single"
              required
              autoFocus
              selected={date}
              defaultMonth={date}
              onSelect={setDate}
              disabled={pending !== null ? true : { before: tomorrow }}
              startMonth={tomorrow}
            />
            <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
              <Button
                variant="ghost"
                disabled={pending !== null}
                onClick={() => {
                  restoreDateFocus.current = true
                  setEditingDate(false)
                  setDate(currentDate)
                }}
              >
                <ArrowLeft />
                Back
              </Button>
              <Button
                disabled={!canSave || pending !== null}
                onClick={() => {
                  if (canSave)
                    void run("date", () =>
                      actions.makeTemporary(date.toISOString())
                    )
                }}
              >
                {pending === "date" ? "Saving…" : "Save date"}
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="px-1 pt-1">
              <PopoverTitle>{label}</PopoverTitle>
              <PopoverDescription className="mt-1 text-xs">
                Edits, moves, and comments keep it longer.
              </PopoverDescription>
            </div>
            <Button
              disabled={pending !== null}
              onClick={() => void run("keep", actions.keep)}
            >
              <InfinityIcon />
              {pending === "keep" ? "Keeping…" : "Keep"}
            </Button>
            <Button
              ref={changeDateRef}
              variant="outline"
              className="justify-start"
              disabled={pending !== null}
              onClick={() => setEditingDate(true)}
            >
              <CalendarDays />
              Change date
              <ChevronRight className="ml-auto" />
            </Button>
            <div className="border-t border-border pt-2">
              <Button
                variant="ghost"
                className="w-full justify-start text-muted-foreground"
                disabled={pending !== null}
                onClick={() => void run("archive", actions.archiveNow)}
              >
                <Archive />
                {pending === "archive" ? "Archiving…" : "Archive now"}
              </Button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

/** Lifetime and Start here items appended to a document's More menu. */
export function DocumentOrganizeMenuItems({
  spaceId,
  path,
  separatorBefore,
}: {
  spaceId: string
  path: string
  separatorBefore: boolean
}) {
  const summary = useDocumentSummary(spaceId, path)
  const actions = useLifetimeActions(spaceId, path)
  const { data: space } = useSpace(spaceId)
  const queryClient = useQueryClient()
  const pins = space?.startHere ?? []
  const pinned = pins.some((pin) => pin.path === path)
  if (!summary || summary.archived || !summary.lifetime) return null

  const updatePins = async (next: Array<{ path: string; note?: string }>) => {
    try {
      await setStartHere(spaceId, next)
      await queryClient.invalidateQueries({
        queryKey: spaceQueryOptions(spaceId).queryKey,
      })
      toast.success(
        pinned ? "Unpinned from Start here" : "Pinned to Start here"
      )
    } catch (error) {
      console.error("Failed to update Start here:", error)
      toast.error("Couldn’t update Start here.")
    }
  }
  const currentPins = pins.map((pin) => ({
    path: pin.path,
    ...(pin.note ? { note: pin.note } : {}),
  }))

  return (
    <>
      {separatorBefore && <DropdownMenuSeparator />}
      {summary.lifetime === "temporary" ? (
        <DropdownMenuItem onClick={() => void actions.keep()}>
          <InfinityIcon className="mr-2 size-4" />
          Keep
        </DropdownMenuItem>
      ) : (
        <DropdownMenuItem onClick={() => void actions.makeTemporary()}>
          <Clock3 className="mr-2 size-4" />
          Make temporary
        </DropdownMenuItem>
      )}
      {pinned ? (
        <DropdownMenuItem
          onClick={() =>
            void updatePins(currentPins.filter((pin) => pin.path !== path))
          }
        >
          <PinOff className="mr-2 size-4" />
          Unpin from Start here
        </DropdownMenuItem>
      ) : (
        <DropdownMenuItem
          disabled={pins.length >= START_HERE_LIMIT}
          onClick={() => void updatePins([...currentPins, { path }])}
        >
          <Pin className="mr-2 size-4" />
          Pin to Start here
        </DropdownMenuItem>
      )}
    </>
  )
}
