import {
  useCallback,
  useEffect,
  useId,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import {
  AppWindow,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Link2,
  MessageSquareText,
  Plug,
  ScrollText,
  Users,
  type LucideIcon,
} from "lucide-react"
import { Button } from "@worktable/ui/components/button"
import { Checkbox } from "@worktable/ui/components/checkbox"
import { ConfirmDialog } from "@worktable/ui/components/confirm-dialog"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@worktable/ui/components/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@worktable/ui/components/select"
import { toast } from "@worktable/ui/components/sonner"
import { cn } from "@worktable/ui/lib/utils"
import { HelpMark } from "@/components/help/help"
import { fillTip } from "@/lib/help/fill"
import { copyText } from "@/lib/clipboard"
import {
  AGENT_RULES_LINE,
  NOTE_STARTERS,
  PAGE_KINDS,
  pagePrompt,
  TRY_NEXT_ACTIONS,
  TRY_NEXT_COPY,
  TRY_NEXT_SETUP,
  type NoteStarterId,
  type PageKind,
  type TryNextId,
} from "@/lib/help/registry"
import { saveHelp } from "@/lib/help/state"
import {
  homeTryNext,
  recentOwnWork,
  type HomeTryNextCard,
} from "@/lib/help/try-next"
import type { HomeRun } from "@worktable/types"
import type { SpaceView } from "@/lib/api"
import { openSettings } from "@/lib/settings-open"
import {
  canInvite,
  gettingStartedSpace,
  isGettingStartedSpace,
  saveSetup,
  usePersonalSetup,
} from "@/lib/setup"
import { getSpaceArchiveInfo } from "@/lib/spaces"

const ICONS: Record<TryNextId, LucideIcon> = {
  "another-agent": Plug,
  "interactive-page": AppWindow,
  "share-link": Link2,
  "note-to-agent": MessageSquareText,
  "agent-rules": ScrollText,
  "invite-team": Users,
}

export interface TryNextDoc {
  spaceId: string
  path: string
  title: string
}

/**
 * Next Steps on Home, from the person's setup and recent work: one row of
 * steps in order, so the early ones are in view and later ones scroll in.
 */
export default function TryNext({
  runs,
  spaces,
  links,
}: {
  runs: readonly HomeRun[]
  spaces: readonly SpaceView[]
  links: boolean
}) {
  const { setup, person } = usePersonalSetup()
  const byId = new Map(spaces.map((space) => [space.id, space]))
  const own = recentOwnWork(runs, {
    self: person?.activityId,
    skipSpace: (spaceId) => {
      const space = byId.get(spaceId)
      return (
        !space ||
        isGettingStartedSpace(space) ||
        Boolean(getSpaceArchiveInfo(space))
      )
    },
  })
  const steps = homeTryNext(setup, {
    canInvite: canInvite(person ?? undefined),
    links,
    doc: Boolean(own.doc),
  })
  if (!steps) return null
  return (
    <TryNextPanel
      cards={steps.cards}
      done={steps.done}
      total={steps.total}
      space={own.spaceId ? byId.get(own.spaceId)?.name : undefined}
      doc={own.doc}
      gettingStartedSpaceId={gettingStartedSpace([...spaces])?.id}
    />
  )
}

function TryNextPanel({
  cards,
  done,
  total,
  space,
  doc,
  gettingStartedSpaceId,
}: {
  cards: HomeTryNextCard[]
  done: number
  total: number
  /** The person's most recent Space's name, for the page prompts. */
  space?: string
  doc?: TryNextDoc
  /** Where connecting an agent happens, while Getting Started is there. */
  gettingStartedSpaceId?: string
}) {
  const queryClient = useQueryClient()
  const headingId = useId()
  // A step done here stays in its place, ticked, until the next visit, so
  // finishing one never moves the others. Steps done before this visit
  // leave the row; the progress marks still count them.
  const [order] = useState<string[]>(() => cards.map((card) => card.id))
  const [doneBefore] = useState(
    () => new Set(cards.filter((card) => card.done).map((card) => card.id))
  )
  const place = (id: string) => {
    const index = order.indexOf(id)
    return index === -1 ? order.length : index
  }
  const shown = [...cards]
    .filter((card) => !doneBefore.has(card.id))
    .sort((a, b) => place(a.id) - place(b.id))
  const [confirming, setConfirming] = useState(false)
  const [hiding, setHiding] = useState(false)
  const hide = async () => {
    setHiding(true)
    try {
      await saveHelp(queryClient, { tryNextHidden: true })
      setConfirming(false)
    } catch {
      toast.error("Couldn’t save. Try again.")
    } finally {
      setHiding(false)
    }
  }
  const row = useScrollRow()
  const progress = fillTip(TRY_NEXT_COPY.progress, {
    done: String(done),
    total: String(total),
  })
  return (
    <section
      aria-labelledby={headingId}
      className="order-3 min-w-0 @3xl/page:col-span-2"
    >
      <div className="mb-2.5 flex min-h-8 items-center justify-between gap-3">
        <h2
          id={headingId}
          className="flex min-w-0 items-center gap-2 text-sm font-semibold text-primary-text"
        >
          <HelpMark />
          {TRY_NEXT_COPY.title}
          <span
            role="img"
            aria-label={progress}
            title={progress}
            className="ml-1 flex items-center gap-[3px]"
          >
            {Array.from({ length: total }, (_, index) => (
              <span
                key={index}
                className={cn(
                  "h-1 w-3.5 rounded-full",
                  index < done ? "bg-primary" : "bg-muted-foreground/25"
                )}
              />
            ))}
          </span>
        </h2>
        <div className="flex shrink-0 items-center gap-1">
          {row.overflows ? (
            <div className="hidden items-center @xl/page:flex">
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Earlier Steps"
                disabled={!row.canBack}
                onClick={() => row.page(-1)}
              >
                <ChevronLeft />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Later Steps"
                disabled={!row.canForward}
                onClick={() => row.page(1)}
              >
                <ChevronRight />
              </Button>
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="rounded-md px-1.5 py-1 text-[0.8125rem] text-muted-foreground transition-colors hover:text-foreground"
          >
            {TRY_NEXT_COPY.hide}
          </button>
        </div>
      </div>
      <ul
        ref={row.ref}
        className="scrollbar-none -mx-1 -my-1 flex snap-x snap-mandatory scroll-px-1 gap-3 overflow-x-auto px-1 py-1"
        style={row.fade}
      >
        {shown.map((card) => (
          <li key={card.id} className="flex w-44 shrink-0 snap-start @xl/page:w-52">
            {card.kind === "setup" ? (
              <ConnectTile gettingStartedSpaceId={gettingStartedSpaceId} />
            ) : (
              <StepFor card={card} space={space} doc={doc} />
            )}
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={TRY_NEXT_COPY.hideTitle}
        description={TRY_NEXT_COPY.hideText}
        icon={<HelpMark />}
        confirmLabel={TRY_NEXT_COPY.hideConfirm}
        loading={hiding}
        loadingLabel={TRY_NEXT_COPY.hideConfirm}
        onConfirm={hide}
      />
    </section>
  )
}

/** A row that scrolls sideways a page at a time, and says which ways it can. */
// How the row last measured, so coming back to Home draws its arrows and
// fade with the page instead of a frame later. A remounted row starts
// scrolled to its start.
let lastRow = { overflows: false, canBack: false, canForward: false }

function useScrollRow() {
  const [node, setNode] = useState<HTMLUListElement | null>(null)
  const [state, setState] = useState(() => ({
    ...lastRow,
    canBack: false,
    canForward: lastRow.overflows,
  }))
  const measure = useCallback((el: HTMLUListElement) => {
    const max = el.scrollWidth - el.clientWidth
    const next = {
      overflows: max > 1,
      canBack: el.scrollLeft > 1,
      canForward: el.scrollLeft < max - 1,
    }
    lastRow = next
    setState((prev) =>
      prev.overflows === next.overflows &&
      prev.canBack === next.canBack &&
      prev.canForward === next.canForward
        ? prev
        : next
    )
  }, [])
  useEffect(() => {
    if (!node) return
    // The observer reports once on start, which takes the first measure.
    const onScroll = () => measure(node)
    node.addEventListener("scroll", onScroll, { passive: true })
    const resize = new ResizeObserver(() => measure(node))
    const watch = () => {
      resize.disconnect()
      resize.observe(node)
      // Steps arriving or leaving change what the row holds, not its box.
      for (const child of node.children) resize.observe(child)
    }
    watch()
    const steps = new MutationObserver(() => {
      watch()
      measure(node)
    })
    steps.observe(node, { childList: true })
    return () => {
      node.removeEventListener("scroll", onScroll)
      resize.disconnect()
      steps.disconnect()
    }
  }, [node, measure])
  const page = (direction: 1 | -1) => {
    const el = node
    if (!el) return
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    el.scrollBy({
      left: direction * el.clientWidth * 0.8,
      behavior: reduce ? "auto" : "smooth",
    })
  }
  // A wide fade where more steps wait, a narrow one where the row has
  // scrolled past steps, so the first one in view stays sharp. Inline, as
  // mask utilities would add to every page's stylesheet.
  const fade: CSSProperties | undefined =
    state.canBack || state.canForward
      ? {
          maskImage: `linear-gradient(to right, ${
            state.canBack ? "transparent, black 0.75rem" : "black"
          }, ${state.canForward ? "black calc(100% - 3rem), transparent" : "black"})`,
        }
      : undefined
  return { ref: setNode, page, fade, ...state }
}

const TILE =
  "help-tile flex h-full min-h-28 w-full min-w-0 flex-col gap-2.5 rounded-xl p-3.5 text-left focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"

/** A tile's face: icon, title, and the action it leads to. */
function TileFace({
  icon: Icon,
  title,
  action,
  done = false,
}: {
  icon: LucideIcon
  title: string
  action: string
  done?: boolean
}) {
  return (
    <>
      <span
        aria-hidden
        className="help-icon-tile flex size-7 shrink-0 items-center justify-center rounded-lg"
      >
        {done ? (
          <CircleCheck className="size-4" strokeWidth={2.25} />
        ) : (
          <Icon className="size-4" strokeWidth={2.25} />
        )}
      </span>
      <span
        className={cn(
          "text-[0.8125rem] leading-[1.35] font-medium",
          done ? "text-muted-foreground" : "text-foreground"
        )}
      >
        {title}
      </span>
      <span className="mt-auto flex items-center gap-1 text-[0.8125rem] font-medium text-primary-text">
        {done ? (
          TRY_NEXT_COPY.done
        ) : (
          <>
            {action}
            <ArrowRight aria-hidden className="size-3.5" />
          </>
        )}
      </span>
    </>
  )
}

function ConnectTile({
  gettingStartedSpaceId,
}: {
  gettingStartedSpaceId?: string
}) {
  const step = TRY_NEXT_SETUP["connect-agent"]
  const face = <TileFace icon={Plug} title={step.title} action={step.action} />
  return gettingStartedSpaceId ? (
    <Link
      to="/spaces/$spaceId"
      params={{ spaceId: gettingStartedSpaceId }}
      title={step.line}
      className={TILE}
    >
      {face}
    </Link>
  ) : (
    <button
      type="button"
      title={step.line}
      onClick={() => openSettings("agents")}
      className={TILE}
    >
      {face}
    </button>
  )
}

function StepFor({
  card,
  space,
  doc,
}: {
  card: Extract<HomeTryNextCard, { kind: "card" }>
  space?: string
  doc?: TryNextDoc
}) {
  const navigate = useNavigate()
  const { id, done } = card
  const title = card.card.title
  const line = fillTip(card.card.line, doc ? { doc: doc.title } : {})
  const action = TRY_NEXT_ACTIONS[id]
  const face = <TileFace icon={ICONS[id]} title={title} action={action} done={done} />
  if (done)
    return <div className={cn(TILE, "pointer-events-none")}>{face}</div>
  const go = (run: () => void) => (
    <button
      type="button"
      title={line}
      onClick={run}
      className={TILE}
    >
      {face}
    </button>
  )
  switch (id) {
    case "share-link":
      return go(() => {
        if (!doc) return
        void navigate({
          to: "/spaces/$spaceId/documents/$",
          params: { spaceId: doc.spaceId, _splat: doc.path },
          hash: "share",
        })
      })
    case "another-agent":
    case "invite-team":
      return go(() => openSettings(id === "invite-team" ? "team" : "agents"))
    case "interactive-page":
      return (
        <StepPopover face={face} title={title} line={line}>
          <PagePrompt space={space} doc={doc?.title} />
        </StepPopover>
      )
    case "note-to-agent":
      return doc ? (
        <StepPopover face={face} title={title} line={line}>
          <NoteStarter doc={doc} />
        </StepPopover>
      ) : null
    case "agent-rules":
      return (
        <StepPopover face={face} title={title} line={line}>
          <RulesLine />
        </StepPopover>
      )
  }
}

/** A step that needs a choice first opens it beside its tile. */
function StepPopover({
  face,
  title,
  line,
  children,
}: {
  face: ReactNode
  title: string
  line: string
  children: ReactNode
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={<button type="button" className={TILE} />}
      >
        {face}
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-80 gap-3 p-4">
        <div className="min-w-0">
          <p className="text-sm leading-5 font-semibold text-foreground">
            {title}
          </p>
          <p className="mt-0.5 text-[0.8125rem] leading-5 text-muted-foreground">
            {line}
          </p>
        </div>
        {children}
      </PopoverContent>
    </Popover>
  )
}

/** The text a step hands over, shown before it's copied or sent. */
function Preview({
  clamp = false,
  children,
}: {
  /** A long line shows its start; all of it is copied. */
  clamp?: boolean
  children: ReactNode
}) {
  return (
    <p className="rounded-lg bg-surface-inset px-3 py-2 text-[0.8125rem] leading-5 text-foreground">
      <span className={cn(clamp && "line-clamp-3")}>{children}</span>
    </p>
  )
}

/** A status beside a step's button, such as Copied. */
function Status({ children }: { children: ReactNode }) {
  return (
    <span
      role="status"
      className="min-w-0 text-[0.8125rem] leading-5 text-muted-foreground"
    >
      {children}
    </span>
  )
}

function Actions({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 pt-1">
      {children}
    </div>
  )
}

function PagePrompt({ space, doc }: { space?: string; doc?: string }) {
  const [kind, setKind] = useState<PageKind>("compare")
  const [copied, setCopied] = useState<PageKind | null>(null)
  const prompt = pagePrompt(kind, { space, doc })
  return (
    <>
      <Select
        value={kind}
        onValueChange={(value) => {
          if (value) setKind(value)
        }}
      >
        <SelectTrigger aria-label="Kind of page" className="h-9">
          <SelectValue>
            {PAGE_KINDS.find((item) => item.id === kind)?.label}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {PAGE_KINDS.map((item) => (
            <SelectItem key={item.id} value={item.id}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Preview>{prompt}</Preview>
      <Actions>
        <Button
          size="sm"
          onClick={() =>
            void copyText(prompt).then(
              () => setCopied(kind),
              () => toast.error("Couldn’t copy. Try again.")
            )
          }
        >
          {TRY_NEXT_ACTIONS["interactive-page"]}
        </Button>
        {copied === kind && <Status>{TRY_NEXT_COPY.copied}</Status>}
      </Actions>
    </>
  )
}

function NoteStarter({ doc }: { doc: TryNextDoc }) {
  const navigate = useNavigate()
  const [starter, setStarter] = useState<NoteStarterId>("missing")
  const text = NOTE_STARTERS.find((item) => item.id === starter)?.text ?? ""
  return (
    <>
      <Select
        value={starter}
        onValueChange={(value) => {
          if (value) setStarter(value)
        }}
      >
        <SelectTrigger aria-label="Note" className="h-9">
          <SelectValue>
            {NOTE_STARTERS.find((item) => item.id === starter)?.label}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {NOTE_STARTERS.map((item) => (
            <SelectItem key={item.id} value={item.id}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Actions>
        <Button
          size="sm"
          onClick={() => {
            toast(TRY_NEXT_COPY.noteNext)
            // Shared with the comment box, which Home doesn't load.
            void import("@/lib/help/note-draft").then(({ startNote }) => {
              startNote(doc.spaceId, doc.path, text)
              return navigate({
                to: "/spaces/$spaceId/documents/$",
                params: { spaceId: doc.spaceId, _splat: doc.path },
                hash: "comments",
              })
            })
          }}
        >
          {TRY_NEXT_ACTIONS["note-to-agent"]}
        </Button>
      </Actions>
    </>
  )
}

function RulesLine() {
  const queryClient = useQueryClient()
  const { setup } = usePersonalSetup()
  const [copied, setCopied] = useState(false)
  const [saving, setSaving] = useState(false)
  const added = async () => {
    setSaving(true)
    try {
      // Getting Started's rules step is the same one. It saves first, so a
      // failure leaves this step's tick to try again.
      if (!setup.items["agent-instructions"])
        await saveSetup(queryClient, { done: "agent-instructions" })
      await saveHelp(queryClient, { evidence: "rules-added" })
    } catch {
      toast.error("Couldn’t save. Try again.")
    } finally {
      setSaving(false)
    }
  }
  return (
    <>
      <Preview>{AGENT_RULES_LINE}</Preview>
      <Actions>
        <Button
          size="sm"
          onClick={() =>
            void copyText(AGENT_RULES_LINE).then(
              () => setCopied(true),
              () => toast.error("Couldn’t copy. Try again.")
            )
          }
        >
          {TRY_NEXT_ACTIONS["agent-rules"]}
        </Button>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
          <Checkbox
            checked={saving}
            disabled={saving}
            onCheckedChange={(checked) => {
              if (checked) void added()
            }}
          />
          {TRY_NEXT_COPY.rulesAdded}
        </label>
        {copied && <Status>{TRY_NEXT_COPY.copied}</Status>}
      </Actions>
    </>
  )
}
