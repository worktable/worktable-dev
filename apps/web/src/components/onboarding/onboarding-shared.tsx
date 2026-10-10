import { Check, Copy, Loader2 } from "lucide-react"
import { Button } from "@worktable/ui/components/button"
import { Callout } from "@worktable/ui/components/callout"
import { useCopy } from "@worktable/ui/hooks/use-copy"
import { cn } from "@worktable/ui/lib/utils"

import { AgentAvatar } from "@/components/agents/agent-avatar"
import { latestPairingFailure, type PairingSession } from "@/lib/pairing-api"
import type { SetupRecord } from "@/lib/onboarding-setups"

export function StepHeading({
  icon,
  media,
  title,
  description,
}: {
  /** A glyph shown in the tinted well. */
  icon?: React.ReactNode
  /** Something that carries its own shape, such as an agent's logo. */
  media?: React.ReactNode
  title: string
  description: string
}) {
  return (
    <div>
      {media ? (
        <div className="mb-5">{media}</div>
      ) : (
        <div className="mb-5 grid size-11 place-items-center rounded-xl bg-surface-tint text-primary">
          {icon}
        </div>
      )}
      <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground">
        {title}
      </h1>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
        {description}
      </p>
    </div>
  )
}

export function CopyValue({
  value,
  label,
  wrap = false,
}: {
  value: string
  label: string
  wrap?: boolean
}) {
  const copy = useCopy()
  return (
    <div className="rounded-xl border border-border bg-background p-3.5">
      <div className="flex items-start gap-3">
        <code
          className={cn(
            "min-w-0 flex-1 font-mono text-xs leading-5 text-foreground",
            wrap ? "whitespace-pre-wrap" : "break-all"
          )}
        >
          {value}
        </code>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={copy.copied ? "Copied" : label}
          title={copy.copied ? "Copied" : label}
          onClick={() => void copy.copy(value)}
        >
          {copy.copied ? <Check /> : <Copy />}
        </Button>
      </div>
    </div>
  )
}

export function Waiting({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" /> {children}
    </p>
  )
}

export function PairingProgress({ session }: { session?: PairingSession }) {
  if (!session || session.status === "pending") {
    return <Waiting>Waiting for the command…</Waiting>
  }
  if (session.status === "expired") {
    return (
      <Callout variant="warning">
        This command expired. Create a new one.
      </Callout>
    )
  }
  const failed = latestPairingFailure(session)
  const completed = new Set(session.events.map((event) => event.event))
  const steps = [
    ["redeemed", "Command accepted"],
    ["config_written", "Worktable added"],
    ["verified", "Connection verified"],
  ] as const
  return (
    <div className="space-y-3" role="status">
      <ul className="space-y-1.5">
        {steps.map(([event, label]) => (
          <li
            key={event}
            className={cn(
              "flex items-center gap-2 text-sm",
              completed.has(event) ? "text-foreground" : "text-muted-foreground"
            )}
          >
            {completed.has(event) ? (
              <Check className="size-4 text-success" />
            ) : (
              <span className="mx-1 size-2 rounded-full bg-border" />
            )}
            {event === "redeemed" && session.redeemedBy?.hostname
              ? `Command ran on ${session.redeemedBy.hostname}`
              : label}
          </li>
        ))}
      </ul>
      {session.status === "verified" ? (
        <Callout variant="success">Connected.</Callout>
      ) : null}
      {failed ? (
        <Callout variant="danger">
          Connection failed{failed.detail ? `: ${failed.detail}` : "."}
        </Callout>
      ) : null}
    </div>
  )
}

export function SetupList({ setups }: { setups: SetupRecord[] }) {
  if (setups.length === 0) return null
  return (
    <section aria-labelledby="onboarding-added-agents" className="space-y-2">
      <h2
        id="onboarding-added-agents"
        className="text-sm font-medium text-foreground"
      >
        Connected
      </h2>
      <ul className="divide-y divide-border/70 rounded-xl border border-border/70 bg-background">
        {setups.map((setup) => (
          <li key={setup.id} className="flex items-center gap-3 px-3 py-2.5">
            <AgentAvatar
              name={setup.name}
              platform={setup.platform}
              className="size-8"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">
                {setup.name}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {setup.mode === "always-on"
                  ? `${setup.harness} · Always on`
                  : setup.harness}
              </span>
            </span>
            <Check className="size-4 shrink-0 text-success" aria-hidden />
          </li>
        ))}
      </ul>
    </section>
  )
}
