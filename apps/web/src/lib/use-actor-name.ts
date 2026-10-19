import type { ActivityActor } from "@worktable/types"
import { actorName } from "./activity-format"
import { useWorkspace } from "./queries"
import { useIsSelf } from "./use-is-self"

/** Current identity names from the same directory the avatars use. */
export function useActorName() {
  const { data } = useWorkspace()
  const isSelf = useIsSelf()
  return (actor: Pick<ActivityActor, "kind" | "id" | "name">): string =>
    actorName(
      { ...actor, name: data?.presentations?.[actor.id]?.name ?? actor.name },
      isSelf
    )
}
