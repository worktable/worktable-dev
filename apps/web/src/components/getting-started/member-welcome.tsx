import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Button } from "@worktable/ui/components/button"
import { toast } from "@worktable/ui/components/sonner"
import { Link } from "@tanstack/react-router"
import {
  GETTING_STARTED_SPACE_ID,
  saveSetup,
  usePersonalSetup,
} from "@/lib/setup"

/**
 * A new member's welcome in the Space they were invited to, shown once.
 * Their own first steps live in Getting Started.
 */
export function MemberWelcome({ spaceId }: { spaceId: string }) {
  const queryClient = useQueryClient()
  const { workspace, person, setup } = usePersonalSetup()
  const dismiss = useMutation({
    mutationFn: () => saveSetup(queryClient, { welcomed: true }),
    onError: () => toast.error("Couldn’t save. Try again."),
  })
  const joined = setup.items["join-space"]
  if (
    person?.role !== "member" ||
    setup.welcomed ||
    !joined ||
    joined.spaceId !== spaceId
  ) {
    return null
  }
  const name = person.name.trim().split(/\s+/)[0]
  const connected = Boolean(setup.items["connect-agent"])
  return (
    <section
      aria-labelledby="member-welcome-heading"
      className="card-surface rounded-xl px-5 py-4"
    >
      <h2
        id="member-welcome-heading"
        className="text-[0.95rem] font-semibold text-foreground"
      >
        Welcome{name ? `, ${name}` : ""}
      </h2>
      <p className="mt-1 text-sm leading-6 text-muted-foreground">
        {connected
          ? `This is where the team is working in ${workspace?.name ?? "this Worktable"}. Your first steps are in Getting Started.`
          : `This is where the team is working in ${workspace?.name ?? "this Worktable"}. Connect your own agent to work alongside them.`}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!connected && (
          <Button
            size="sm"
            nativeButton={false}
            render={
              <Link
                to="/spaces/$spaceId"
                params={{ spaceId: GETTING_STARTED_SPACE_ID }}
              />
            }
          >
            Connect your agent
          </Button>
        )}
        <Button
          size="sm"
          variant={connected ? "outline" : "ghost"}
          disabled={dismiss.isPending}
          onClick={() => dismiss.mutate()}
        >
          Got it
        </Button>
      </div>
    </section>
  )
}
