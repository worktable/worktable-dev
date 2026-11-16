import { useEffect, type ReactNode } from "react"
import { ArrowUpRight, CircleHelp } from "lucide-react"
import {
  HelpCard,
  HelpHint,
  HelpInline,
  HelpLink,
} from "@worktable/ui/components/help-band"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@worktable/ui/components/popover"
import { cn } from "@worktable/ui/lib/utils"
import { HelpMark } from "@/components/help/help-mark"
import {
  HELP_ICONS,
  TIPS,
  concept as conceptById,
  docsUrl,
  type HelpIconKey,
  type Tip,
  type TipKey,
} from "@/lib/help/registry"
import { fillTip } from "@/lib/help/fill"
import { tipMayShow } from "@/lib/help/rules"
import { useHelpContext, useTip } from "@/lib/help/state"

/*
 * The help components themselves. They carry every line of help, so they load
 * only where help is on: import the wrappers in ./help instead.
 */


function LearnMore({ path }: { path: string }) {
  return (
    <HelpLink href={docsUrl(path)}>
      Learn More
      <ArrowUpRight aria-hidden className="size-3.5" />
    </HelpLink>
  )
}

export interface TipProps {
  tip: TipKey
  /** The place's own condition, such as "this Doc is temporary". */
  active?: boolean
  /** Values for the tip's {placeholders}. */
  values?: Record<string, string>
  /** Buttons that do the thing the tip is about; they finish it. */
  actions?: (done: () => void) => ReactNode
  className?: string
}

/** A tip in the page. Renders nothing until it's this screen's turn. */
export function TipCard({
  tip: key,
  active = true,
  values,
  actions,
  className,
}: TipProps) {
  const tip: Tip = TIPS[key]
  const { open, close, done } = useTip(tip, active)
  if (!open) return null
  const Display = tip.display === "inline" ? HelpInline : HelpCard
  return (
    <Display
      label="Tip"
      mark={<HelpMark />}
      title={tip.title}
      onClose={close}
      className={cn(
        "animate-in fade-in-0 slide-in-from-top-1 duration-200 motion-reduce:animate-none",
        className
      )}
      actions={
        actions || tip.learnMore ? (
          <>
            {actions?.(done)}
            {tip.learnMore ? <LearnMore path={tip.learnMore} /> : null}
          </>
        ) : undefined
      }
    >
      <p>{fillTip(tip.text, values)}</p>
    </Display>
  )
}

/** A tip pointing at one control, such as a button. */
export function TipHint({
  tip: key,
  anchor,
  active = true,
  values,
  side,
  align,
  closeWhen = false,
  waitFor,
}: TipProps & {
  anchor: Element | null
  side?: "top" | "bottom" | "left" | "right"
  align?: "start" | "center" | "end"
  /** The person used the control it points at: it closes, as if closed. */
  closeWhen?: boolean
  /** A tip that goes first here: this one waits until that one can't show. */
  waitFor?: TipKey
}) {
  const tip: Tip = TIPS[key]
  const context = useHelpContext()
  const first: Tip | null = waitFor ? TIPS[waitFor] : null
  const waiting =
    first !== null && tipMayShow(first, context.setup.help?.[first.id], context)
  const { open, close } = useTip(tip, active && !waiting && anchor !== null)
  useEffect(() => {
    if (open && closeWhen) close()
  }, [open, closeWhen, close])
  return (
    <HelpHint
      anchor={anchor}
      open={open}
      side={side}
      align={align}
      label="Tip"
      mark={<HelpMark />}
      title={tip.title}
      onClose={close}
      actions={tip.learnMore ? <LearnMore path={tip.learnMore} /> : undefined}
    >
      <p>{fillTip(tip.text, values)}</p>
    </HelpHint>
  )
}

/**
 * A help icon beside a label: the concept behind it, on request, with an
 * optional line about this place first. Replaces the plain info icon.
 */
export function HelpIcon({
  entry,
  label,
  line,
  className,
  side = "bottom",
  align = "start",
}: {
  entry: HelpIconKey
  /** Names the button, e.g. "About Auto-reply". */
  label: string
  /** A line about this exact place, before the concept's own text. */
  line?: ReactNode
  className?: string
  side?: "top" | "bottom" | "left" | "right"
  align?: "start" | "center" | "end"
}) {
  const icon = HELP_ICONS[entry]
  const about = conceptById(icon.concept)
  const placeLine = line ?? ("line" in icon ? icon.line : undefined)
  return (
    <Popover>
      <PopoverTrigger
        aria-label={label}
        className={cn(
          "-m-1.5 inline-grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none data-popup-open:text-primary-text",
          className
        )}
      >
        <CircleHelp aria-hidden className="size-4" />
      </PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        aria-label={about.name}
        className="help-surface w-80 gap-0 overflow-hidden rounded-xl p-0"
      >
        <div className="help-band flex items-center gap-2 py-1.5 pl-3 text-xs font-semibold text-primary-text">
          <HelpMark />
          Tip
        </div>
        <div className="flex flex-col gap-1 px-3 pt-2.5 pb-3 text-sm">
          <p className="font-semibold text-foreground">{about.name}</p>
          <div className="leading-relaxed text-muted-foreground [&_p+p]:mt-1.5">
            {placeLine ? <p>{placeLine}</p> : null}
            <p>{about.full}</p>
          </div>
          <div className="mt-2">
            <LearnMore path={about.docs} />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
