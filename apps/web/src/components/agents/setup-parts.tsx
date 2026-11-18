import { Fragment, type ReactNode } from "react"
import { Check, ExternalLink } from "lucide-react"
import { Button, buttonVariants } from "@worktable/ui/components/button"
import { useCopy } from "@worktable/ui/hooks/use-copy"
import { cn } from "@worktable/ui/lib/utils"

/** Lets a long address wrap after its slashes before it breaks inside a word. */
function breakable(value: string): ReactNode {
  return value.split(/(?<=\/)/).map((part, index) => (
    <Fragment key={index}>
      {index > 0 ? <wbr /> : null}
      {part}
    </Fragment>
  ))
}

/**
 * A command or address to copy. It wraps at spaces and hyphens, and breaks
 * inside a word only when one word is wider than the block.
 */
export function CommandBlock({
  value,
  pending = false,
}: {
  value: string
  /** Shown in its final shape while the real value is on its way. */
  pending?: boolean
}) {
  const copy = useCopy()
  return (
    <div className="relative rounded-xl border border-border bg-surface-inset py-2.5 pr-20 pl-3">
      <code
        className={cn(
          "block font-mono text-xs leading-5 wrap-anywhere whitespace-pre-wrap transition-colors duration-200",
          pending ? "text-muted-foreground" : "text-foreground"
        )}
      >
        {breakable(value)}
      </code>
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        className="absolute top-1.5 right-1.5 h-7 px-2.5 text-xs"
        onClick={() => void copy.copy(value)}
      >
        {copy.copied ? "Copied" : "Copy"}
      </Button>
    </div>
  )
}

/** Opens another site or app in a new tab: every such action looks like this. */
export function ExternalButton({
  href,
  children,
  size = "sm",
  className,
}: {
  href: string
  children: ReactNode
  /** Default beside a dialog's own buttons. */
  size?: "sm" | "default"
  className?: string
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cn(buttonVariants({ variant: "outline", size }), className)}
    >
      {children}
      <ExternalLink
        aria-hidden
        data-icon="inline-end"
        className="size-3.5 text-muted-foreground"
      />
    </a>
  )
}

/** The mark a connected app or step carries. */
export function ConnectedMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded-full bg-success text-background",
        className
      )}
    >
      <Check className="size-2.5" strokeWidth={3} aria-hidden />
    </span>
  )
}

/** Where a setup stands: waiting for the app, or connected. */
export function StatusLine({
  connected,
  waiting,
  className,
  children,
}: {
  connected?: boolean
  waiting?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <p
      role="status"
      className={cn(
        "mt-3 flex min-h-5 items-center gap-2 text-sm",
        connected ? "text-foreground" : "text-muted-foreground",
        className
      )}
    >
      {connected ? (
        <ConnectedMark />
      ) : waiting ? (
        <span
          aria-hidden
          className="size-1.5 shrink-0 animate-pulse rounded-full bg-warning"
        />
      ) : null}
      <span>{children}</span>
    </p>
  )
}
