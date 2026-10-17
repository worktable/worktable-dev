import { useSpace } from "@/lib/queries"
import { Suspense, useEffect, useRef, useState } from "react"
import type { ComponentProps, ReactNode } from "react"
import {
  Archive,
  ArrowLeft,
  CalendarDays,
  ChevronRight,
  Clock3,
  Infinity as InfinityIcon,
} from "lucide-react"
import { Button } from "@worktable/ui/components/button"
import { preloadableComponent } from "@worktable/ui/lib/preloadable-component"
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

// The date picker (react-day-picker and date-fns) loads on demand. It starts
// loading when the lifetime controls open, so it is ready by the time someone
// chooses to change the date.
type CalendarProps = ComponentProps<
  typeof import("@worktable/ui/components/calendar").Calendar
>
const calendar = preloadableComponent<CalendarProps>(() =>
  import("@worktable/ui/components/calendar").then((module) => ({
    default: module.Calendar,
  }))
)
const Calendar = calendar.Component

/** The quiet chips that sit on a Doc's byline, under its title. */
export const DOCUMENT_BYLINE_CHIP =
  "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md bg-surface-tint px-2 text-xs text-muted-foreground transition-colors hover:bg-surface-selected hover:text-foreground aria-expanded:bg-surface-selected aria-expanded:text-foreground disabled:pointer-events-none"

/** Compare calendar days in the person's local timezone. */
function localDay(iso: string): Date {
  const date = new Date(iso)
  date.setHours(0, 0, 0, 0)
  return date
}

/**
 * Quiet chip for temporary documents; durable documents show nothing. The
 * header chip sits with the page actions; Docs show it inline under the title.
 */
export function DocumentLifetimeChip({
  spaceId,
  path,
  inline = false,
  open: controlledOpen,
  onOpenChange,
}: {
  spaceId: string
  path: string
  inline?: boolean
  /** Whether the popover is open, when its owner keeps that state. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const { data: space } = useSpace(spaceId)
  const label = useTemporaryArchiveLabel(spaceId, path)
  const [localOpen, setLocalOpen] = useState(false)
  const open = controlledOpen ?? localOpen
  const setOpen = onOpenChange ?? setLocalOpen
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
            className={
              inline
                ? DOCUMENT_BYLINE_CHIP
                : "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            }
            disabled={space?.space.permissions?.edit === false}
            aria-label={`Temporary. ${label}`}
          />
        }
      >
        <Clock3 className={inline ? "size-3.5 text-warning" : "size-3.5"} />
        <span className={inline ? undefined : "hidden sm:inline"}>{label}</span>
      </PopoverTrigger>
      <PopoverContent
        align={inline ? "start" : "end"}
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
  const { data: space } = useSpace(spaceId)
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
  useEffect(() => {
    // A failed preload is retried when someone chooses Change date.
    calendar.preload().catch(() => {})
  }, [])
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
  if (!archiveOn || space?.space.permissions?.edit === false) return null
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
        <Suspense fallback={null}>
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
        </Suspense>
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
          // Step in once the picker has loaded, so the step never shows
          // without it. If it fails to load, stay here: a failed chunk would
          // otherwise reach the route's error boundary, and the next click
          // loads it again.
          calendar
            .preload()
            .then(() => {
              if (mounted.current) setEditingDate(true)
            })
            .catch(() => {})
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

/** Lifetime and pin items appended to a document's More menu. */
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
