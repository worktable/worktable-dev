import { useEffect, useRef, useState } from "react"
import type { ReactNode } from "react"
import {
  Archive,
  ArrowLeft,
  CalendarDays,
  ChevronRight,
  Clock3,
  Infinity as InfinityIcon,
} from "lucide-react"
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
import {
  useDocumentOrganizeActions,
  useLifetimeActions,
  useTemporaryArchiveLabel,
} from "@/hooks/use-document-organize"
import { useDocumentSummary } from "@/lib/lifetime"

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
  const label = useTemporaryArchiveLabel(spaceId, path)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  if (!label) return null

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (pending) return
        setOpen(next)
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
        aria-busy={pending}
      >
        <DocumentLifetimeControls
          spaceId={spaceId}
          path={path}
          onDone={() => setOpen(false)}
          onPendingChange={setPending}
          heading={(step) => (
            <div className="px-1 pt-1">
              <PopoverTitle>
                {step === "date" ? "Change archive date" : label}
              </PopoverTitle>
              <PopoverDescription className="mt-1 text-xs">
                {step === "date"
                  ? "Edits, moves, and comments can extend this date."
                  : "Edits, moves, and comments keep it longer."}
              </PopoverDescription>
            </div>
          )}
        />
      </PopoverContent>
    </Popover>
  )
}

/**
 * Keep, reschedule, or archive a temporary document. Changing the date steps
 * into a calendar with explicit Back and Save date actions.
 */
export function DocumentLifetimeControls({
  spaceId,
  path,
  onDone,
  onPendingChange,
  heading,
}: {
  spaceId: string
  path: string
  /** Called after an action succeeds. */
  onDone: () => void
  onPendingChange?: (pending: boolean) => void
  heading?: (step: "overview" | "date") => ReactNode
}) {
  const summary = useDocumentSummary(spaceId, path)
  const actions = useLifetimeActions(spaceId, path)
  const archiveOn = summary?.archiveOn
  const [date, setDate] = useState<Date | undefined>(() =>
    archiveOn ? localDay(archiveOn) : undefined
  )
  const [editingDate, setEditingDate] = useState(false)
  const [pending, setPending] = useState<"keep" | "date" | "archive" | null>(
    null
  )
  const changeDateRef = useRef<HTMLButtonElement>(null)
  const restoreDateFocus = useRef(false)
  // A save can outlive these controls (the page changed); its completion
  // must not close whatever surface is open by then.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (!editingDate && restoreDateFocus.current) {
      changeDateRef.current?.focus()
      restoreDateFocus.current = false
    }
  }, [editingDate])
  if (!archiveOn) return null
  const currentDate = localDay(archiveOn)
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
    onPendingChange?.(true)
    const saved = await action()
    setPending(null)
    onPendingChange?.(false)
    if (saved && mounted.current) onDone()
  }

  if (editingDate) {
    return (
      <>
        {heading?.("date")}
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
    )
  }

  return (
    <>
      {heading?.("overview")}
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
        onClick={() => {
          // Start from the date as it is now; activity may have moved it.
          setDate(currentDate)
          setEditingDate(true)
        }}
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
  const actions = useDocumentOrganizeActions(spaceId, path)
  if (actions.length === 0) return null
  return (
    <>
      {separatorBefore && <DropdownMenuSeparator />}
      {actions.map((action) => (
        <DropdownMenuItem
          key={action.id}
          disabled={action.disabled}
          onClick={action.onSelect}
        >
          <action.icon className="mr-2 size-4" />
          {action.label}
        </DropdownMenuItem>
      ))}
    </>
  )
}
