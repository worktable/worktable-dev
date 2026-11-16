import { useState, type ReactNode } from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import {
  AppWindow,
  CircleCheck,
  EyeOff,
  Link2,
  MessageSquareText,
  MoreVertical,
  Plug,
  ScrollText,
  Users,
  type LucideIcon,
} from "lucide-react"
import { Button } from "@worktable/ui/components/button"
import { Checkbox } from "@worktable/ui/components/checkbox"
import { ConfirmDialog } from "@worktable/ui/components/confirm-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@worktable/ui/components/dropdown-menu"
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
 * Things to do next on Home, each a benefit the person sees happen. A card
 * is done when Worktable sees it happen; done cards stay ticked until all are.
 */
/** Next Steps on Home, from the person's setup and recent work. */
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
  // A card done here stays where it was until the next visit, so finishing
  // one never moves the others.
  const [order] = useState<string[]>(() => cards.map((card) => card.id))
  const place = (id: string) => {
    const index = order.indexOf(id)
    return index === -1 ? order.length : index
  }
  const shown = [...cards].sort((a, b) => place(a.id) - place(b.id))
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
  return (
    <section
      aria-labelledby="try-next-heading"
      className="help-surface order-3 min-w-0 overflow-hidden rounded-2xl bg-popover @3xl/page:col-span-2"
    >
      <div className="help-band flex items-center justify-between gap-3 py-2 pr-2 pl-4">
        <h2
          id="try-next-heading"
          className="flex min-w-0 items-center gap-2 text-sm font-semibold text-primary-text"
        >
          <HelpMark />
          {TRY_NEXT_COPY.title}
          <span className="font-normal text-muted-foreground tabular-nums">
            {fillTip(TRY_NEXT_COPY.progress, {
              done: String(done),
              total: String(total),
            })}
          </span>
        </h2>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="More"
            className="flex size-8 shrink-0 items-center justify-center rounded-md text-primary-text transition-colors hover:bg-surface-hover"
            render={<button type="button" />}
          >
            <MoreVertical className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={4} className="min-w-40">
            <DropdownMenuItem onClick={() => setConfirming(true)}>
              <EyeOff className="size-4" />
              {TRY_NEXT_COPY.hide}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <ul className="grid grid-cols-1 gap-3 p-3 @xl/page:grid-cols-2 @3xl/page:grid-cols-3">
        {shown.map((card) => (
          <li key={card.id} className="flex min-w-0">
            {card.kind === "setup" ? (
              <TryCard
                icon={Plug}
                title={TRY_NEXT_SETUP["connect-agent"].title}
                line={TRY_NEXT_SETUP["connect-agent"].line}
              >
                {gettingStartedSpaceId ? (
                  <Button
                    size="sm"
                    variant="outline"
                    nativeButton={false}
                    render={
                      <Link
                        to="/spaces/$spaceId"
                        params={{ spaceId: gettingStartedSpaceId }}
                      />
                    }
                  >
                    {TRY_NEXT_SETUP["connect-agent"].action}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openSettings("agents")}
                  >
                    {TRY_NEXT_SETUP["connect-agent"].action}
                  </Button>
                )}
              </TryCard>
            ) : (
              <CardFor card={card} space={space} doc={doc} />
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

function CardFor({
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
  const props: CardText = {
    icon: ICONS[id],
    title: card.card.title,
    line: fillTip(card.card.line, doc ? { doc: doc.title } : {}),
    done,
  }
  const action = TRY_NEXT_ACTIONS[id]
  switch (id) {
    case "interactive-page":
      return <PagePrompt card={props} space={space} doc={doc?.title} />
    case "share-link":
      return (
        <TryCard {...props}>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (!doc) return
              void navigate({
                to: "/spaces/$spaceId/documents/$",
                params: { spaceId: doc.spaceId, _splat: doc.path },
                hash: "share",
              })
            }}
          >
            {action}
          </Button>
        </TryCard>
      )
    case "note-to-agent":
      return doc ? <NoteStarter card={props} doc={doc} /> : null
    case "agent-rules":
      return <RulesLine card={props} />
    case "another-agent":
    case "invite-team":
      return (
        <TryCard {...props}>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              openSettings(id === "invite-team" ? "team" : "agents")
            }
          >
            {action}
          </Button>
        </TryCard>
      )
  }
}

interface CardText {
  icon: LucideIcon
  title: string
  line: string
  done: boolean
}

/** One card: what it gives, then how to do it, or Done once it happened. */
function TryCard({
  icon: Icon,
  title,
  line,
  done = false,
  body,
  children,
}: {
  icon: LucideIcon
  title: string
  line: string
  done?: boolean
  /** What to pick and see before acting, such as a prompt. */
  body?: ReactNode
  /** The card's buttons, at its foot. */
  children?: ReactNode
}) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-3 rounded-xl card-surface p-4">
      <span
        aria-hidden
        className="help-icon-tile flex size-8 shrink-0 items-center justify-center rounded-lg"
      >
        {done ? (
          <CircleCheck className="size-4" strokeWidth={2.25} />
        ) : (
          <Icon className="size-4" strokeWidth={2.25} />
        )}
      </span>
      <div className="min-w-0">
        <h3 className="text-sm leading-5 font-semibold text-foreground">
          {title}
        </h3>
        <p className="mt-0.5 text-[0.8125rem] leading-5 text-muted-foreground">
          {line}
        </p>
      </div>
      {!done && body ? (
        <div className="flex min-w-0 flex-col gap-2.5">{body}</div>
      ) : null}
      {done ? (
        <p className="mt-auto text-[0.8125rem] leading-8 font-medium text-primary-text">
          {TRY_NEXT_COPY.done}
        </p>
      ) : children ? (
        <div className="mt-auto flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 pt-1">
          {children}
        </div>
      ) : null}
    </div>
  )
}

/** The text a card hands over, shown before it's copied or sent. */
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

/** A status beside a card's button, such as Copied. */
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

function PagePrompt({
  card,
  space,
  doc,
}: {
  card: CardText
  space?: string
  doc?: string
}) {
  const [kind, setKind] = useState<PageKind>("compare")
  const [copied, setCopied] = useState<PageKind | null>(null)
  const prompt = pagePrompt(kind, { space, doc })
  return (
    <TryCard
      {...card}
      body={
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
        </>
      }
    >
      <Button
        size="sm"
        variant="outline"
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
    </TryCard>
  )
}

function NoteStarter({ card, doc }: { card: CardText; doc: TryNextDoc }) {
  const navigate = useNavigate()
  const [starter, setStarter] = useState<NoteStarterId>("missing")
  const text = NOTE_STARTERS.find((item) => item.id === starter)?.text ?? ""
  return (
    <TryCard
      {...card}
      body={
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
        </>
      }
    >
      <Button
        size="sm"
        variant="outline"
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
    </TryCard>
  )
}

function RulesLine({ card }: { card: CardText }) {
  const queryClient = useQueryClient()
  const { setup } = usePersonalSetup()
  const [copied, setCopied] = useState(false)
  const [saving, setSaving] = useState(false)
  const added = async () => {
    setSaving(true)
    try {
      // Getting Started's rules step is the same one. It saves first, so a
      // failure leaves this card's tick to try again.
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
    <TryCard {...card} body={<Preview clamp>{AGENT_RULES_LINE}</Preview>}>
      <Button
        size="sm"
        variant="outline"
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
    </TryCard>
  )
}
