import { useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import { Archive, Clock3, Pin, PinOff, Infinity as InfinityIcon } from "lucide-react"
import { START_HERE_LIMIT } from "@worktable/types"
import { Button } from "@worktable/ui/components/button"
import { Input } from "@worktable/ui/components/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
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
    } catch (error) {
      console.error(failure, error)
      toast.error(failure)
    }
  }
  return {
    keep: () =>
      run(() => setDocumentLifetime(spaceId, path, "durable"), "Couldn’t keep this document."),
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

/** The local calendar day of an instant, as a date input value. */
function toDateInput(iso: string): string {
  const date = new Date(iso)
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 10)
}

/** A date input value as the start of that day where the person is. */
function fromDateInput(value: string): string {
  return new Date(`${value}T00:00:00`).toISOString()
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
  const [date, setDate] = useState("")
  if (summary?.lifetime !== "temporary" || !summary.archiveOn) return null
  const label = `Archives ${formatArchiveDate(summary.archiveOn)}`
  const today = toDateInput(new Date().toISOString())

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setDate(toDateInput(summary.archiveOn!))
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
      <PopoverContent align="end" className="w-72 gap-3 p-3">
        <div>
          <p className="text-sm font-medium text-popover-foreground">Temporary</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {label}. Edits, moves, and comments keep it longer.
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => {
            setOpen(false)
            void actions.keep()
          }}
        >
          Keep
        </Button>
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (!date || date < today) return
            setOpen(false)
            void actions.makeTemporary(fromDateInput(date))
          }}
        >
          <Input
            type="date"
            aria-label="Archive date"
            value={date}
            min={today}
            onChange={(event) => setDate(event.target.value)}
            className="h-9 flex-1"
          />
          <Button type="submit" size="sm" variant="outline" disabled={!date || date < today}>
            Change date
          </Button>
        </form>
        <Button
          size="sm"
          variant="ghost"
          className="justify-start text-muted-foreground"
          onClick={() => {
            setOpen(false)
            void actions.archiveNow()
          }}
        >
          <Archive className="size-3.5" />
          Archive now
        </Button>
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
      await queryClient.invalidateQueries({ queryKey: spaceQueryOptions(spaceId).queryKey })
      toast.success(pinned ? "Unpinned from Start here" : "Pinned to Start here")
    } catch (error) {
      console.error("Failed to update Start here:", error)
      toast.error("Couldn’t update Start here.")
    }
  }
  const currentPins = pins.map((pin) => ({ path: pin.path, ...(pin.note ? { note: pin.note } : {}) }))

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
          onClick={() => void updatePins(currentPins.filter((pin) => pin.path !== path))}
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
