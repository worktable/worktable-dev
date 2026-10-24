import { lazy, Suspense, useState, type ReactNode } from "react"
import { CLOUD_PLANS } from "@worktable/hosted-contract/plans"
import { Button } from "@worktable/ui/components/button"

const APPS = {
  chatgpt: "Add the Worktable app in ChatGPT",
  claude: "Add the Worktable connector in Claude",
} as const

// Loaded when asked for, as Grok Bot's setup does.
const WorktableLinkSetup = lazy(() =>
  import("@/components/settings/sections/cloud").then((module) => ({
    default: module.CloudSection,
  }))
)

const { solo } = CLOUD_PLANS
const FREE_ON_SOLO =
  solo.amount === 0 && solo.peopleLimit === 1
    ? ` Free for one person on ${solo.name}.`
    : ""

/**
 * The two ways to use a chat app with this Worktable: anywhere through its
 * official Worktable app and Worktable Link, or on this computer with the
 * local address. `local` holds the steps for this computer.
 */
export function ChatAppWays({
  app,
  active = true,
  local,
}: {
  app: keyof typeof APPS
  /** Whether the surface is showing, so Worktable Link checks its status. */
  active?: boolean
  local: ReactNode
}) {
  const [linkSetup, setLinkSetup] = useState(false)
  return (
    <div className="flex flex-col gap-5">
      <section
        aria-labelledby={`chat-anywhere-${app}`}
        className="flex flex-col gap-1 rounded-xl bg-surface-inset px-3.5 py-3"
      >
        <h3
          id={`chat-anywhere-${app}`}
          className="text-sm font-medium text-foreground"
        >
          Anywhere, including your phone
        </h3>
        <p className="text-sm text-muted-foreground">
          {APPS[app]}, then turn on Worktable Link.{FREE_ON_SOLO}
        </p>
        {linkSetup ? (
          <div className="pt-3">
            <Suspense
              fallback={
                <p role="status" className="text-sm text-muted-foreground">
                  Loading Worktable Link…
                </p>
              }
            >
              <WorktableLinkSetup active={active} />
            </Suspense>
          </div>
        ) : (
          <div>
            <Button
              variant="link"
              className="h-auto px-0 py-1 text-sm"
              onClick={() => setLinkSetup(true)}
            >
              Set up Worktable Link
            </Button>
          </div>
        )}
      </section>
      <section
        aria-labelledby={`chat-local-${app}`}
        className="flex flex-col gap-3"
      >
        <h3
          id={`chat-local-${app}`}
          className="text-sm font-medium text-foreground"
        >
          On this computer
        </h3>
        {local}
      </section>
    </div>
  )
}
