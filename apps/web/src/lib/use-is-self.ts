import type { ActivityActor } from "@worktable/types"
import { useWorkspace } from "./queries"

/**
 * Whether an activity actor is the reader. Without Teams there is one
 * person, so every person is the reader.
 */
export function useIsSelf(): (actor: Pick<ActivityActor, "id">) => boolean {
  const { data } = useWorkspace()
  const me = data?.person?.activityId
  const team = Boolean(data?.teamContext)
  return (actor) => !team || !me || actor.id === me
}
