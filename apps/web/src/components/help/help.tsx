import { lazy, Suspense, type ComponentProps, type ReactNode } from "react"
import { useHelpEnabled } from "@/hooks/use-deployment-info"
import { WorktableAppIcon } from "@/components/worktable-app-icon"

/** The Worktable mark in a help band. */
export function HelpMark() {
  return <WorktableAppIcon className="size-4" />
}

/*
 * What screens import to show help. Outside Preview these render nothing (or
 * what the place showed before), and the help itself, with every line of its
 * words, loads only where help is on, so it adds nothing to a page's bundle.
 */
const help = () => import("./help-tip")
const LazyTipCard = lazy(() => help().then((m) => ({ default: m.TipCard })))
const LazyTipHint = lazy(() => help().then((m) => ({ default: m.TipHint })))
const LazyHelpIcon = lazy(() => help().then((m) => ({ default: m.HelpIcon })))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Lazy<T extends (props: any) => ReactNode> = ComponentProps<T>

/** A tip in the page, such as a first meeting. Nothing until it's its turn. */
export function TipCard(props: Lazy<typeof import("./help-tip").TipCard>) {
  if (!useHelpEnabled()) return null
  return (
    <Suspense fallback={null}>
      <LazyTipCard {...props} />
    </Suspense>
  )
}

/** A tip pointing at one control. */
export function TipHint(props: Lazy<typeof import("./help-tip").TipHint>) {
  if (!useHelpEnabled()) return null
  return (
    <Suspense fallback={null}>
      <LazyTipHint {...props} />
    </Suspense>
  )
}

/** A help icon beside a label: the idea behind it, on request. */
export function HelpIcon({
  fallback = null,
  ...props
}: Lazy<typeof import("./help-tip").HelpIcon> & {
  /** What shows while help is off (outside Preview), such as today's InfoTip. */
  fallback?: ReactNode
}) {
  if (!useHelpEnabled()) return <>{fallback}</>
  return (
    <Suspense fallback={fallback}>
      <LazyHelpIcon {...props} />
    </Suspense>
  )
}
