import { useQuery, type QueryClient } from "@tanstack/react-query"
import type {
  PersonalSetup,
  SetupEvidence,
  SetupItemId,
} from "@worktable/types/setup"
import {
  GETTING_STARTED_SETTING,
  GETTING_STARTED_SPACE_ID,
} from "@worktable/types/setup"
import type { SpaceView, WorkspaceInfo } from "./api"
import { fetchJSON } from "./http.ts"
import { queryKeys, workspaceQueryOptions } from "./queries"
import { getSpaceArchiveInfo } from "./spaces"

export { GETTING_STARTED_SPACE_ID }

export interface ChecklistItem {
  id: SetupItemId
  title: string
  description: string
}

/** Owners can invite once people have accounts to sign in with. */
export function canInvite(
  person: WorkspaceInfo["person"] | undefined
): boolean {
  return person?.role === "owner" && person.signOut !== null
}

/** Without a Space to start from, the first task is setting one up. */
const FIRST_SPACE: ChecklistItem = {
  id: "first-task",
  title: "Set up your first Space",
  description: "Your agent builds it from what it already knows.",
}

const AGENT_INSTRUCTIONS: ChecklistItem = {
  id: "agent-instructions",
  title: "Add Worktable to your agent's global rules",
  description: "So you don't have to say “in Worktable” every time.",
}

/**
 * Each person's own steps, in the order they're worth doing. The
 * instructions come before the first task; once an agent has done one
 * without them, the step isn't added to a list that was further along.
 */
export function checklistFor(
  role: "owner" | "member",
  options: {
    canInvite: boolean
    joinedSpaceName?: string
    items: PersonalSetup["items"]
  }
): ChecklistItem[] {
  const instructions =
    options.items["first-task"] && !options.items["agent-instructions"]
      ? []
      : [AGENT_INSTRUCTIONS]
  if (role === "member") {
    return [
      {
        id: "connect-agent",
        title: "Connect your agent",
        description: "So it can work here too.",
      },
      ...instructions,
      options.joinedSpaceName
        ? {
            id: "first-task",
            title: "Give your agent a task",
            description: `Start with the work already in ${options.joinedSpaceName}.`,
          }
        : FIRST_SPACE,
    ]
  }
  return [
    {
      id: "connect-agent",
      title: "Connect your agent",
      description: "So it can read and write here.",
    },
    ...instructions,
    FIRST_SPACE,
    ...(options.canInvite
      ? [
          {
            id: "invite-team",
            title: "Invite your team",
            description: "They join the Spaces you share with them.",
          } satisfies ChecklistItem,
        ]
      : []),
  ]
}

export interface ChecklistProgress {
  done: number
  total: number
  next: ChecklistItem | null
}

export function checklistProgress(
  all: ChecklistItem[],
  items: PersonalSetup["items"]
): ChecklistProgress {
  const done = all.filter((item) => items[item.id]).length
  return {
    done,
    total: all.length,
    next: all.find((item) => !items[item.id]) ?? null,
  }
}

/** The seeded Getting Started Space, if this person can see it. */
export function gettingStartedSpace(
  spaces: SpaceView[] | undefined
): SpaceView | null {
  return (
    spaces?.find(
      (space) =>
        space.id === GETTING_STARTED_SPACE_ID &&
        space.settings?.[GETTING_STARTED_SETTING] === true &&
        !getSpaceArchiveInfo(space)
    ) ?? null
  )
}

export const EMPTY_SETUP: PersonalSetup = { items: {} }

/** The person's setup and their own list, from the workspace summary. */
export function usePersonalSetup() {
  const workspace = useQuery(workspaceQueryOptions())
  const person = workspace.data?.person ?? null
  const setup = workspace.data?.setup ?? EMPTY_SETUP
  return { workspace: workspace.data, person, setup }
}

export interface SetupChoices {
  hidden?: boolean
  welcomed?: boolean
  /** Pass over a step that needs someone else, such as inviting. */
  skip?: "invite-team"
  /** A step only the browser sees happen, such as copying the instructions. */
  done?: "agent-instructions"
}

/** Save the person's own choices; the summary carries the result. */
export async function saveSetup(
  queryClient: QueryClient,
  choices: SetupChoices
): Promise<PersonalSetup> {
  const { setup } = await fetchJSON<{ setup: PersonalSetup }>(
    "/api/profile/setup",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(choices),
    }
  )
  queryClient.setQueryData<WorkspaceInfo>(queryKeys.workspace, (current) =>
    current ? { ...current, setup } : current
  )
  return setup
}

/** The server recorded progress; read the summary again. */
export function noteSetupChanged(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({
    queryKey: queryKeys.workspace,
    exact: true,
  })
}

export type { PersonalSetup, SetupEvidence, SetupItemId }

/**
 * Getting Started, with the person's progress, while they keep it pinned.
 * Null when there is no Getting Started Space or they unpinned it.
 */
export function useGettingStartedShortcut(
  spaces: SpaceView[] | undefined
): {
  space: SpaceView
  progress: ChecklistProgress
} | null {
  const { person, setup } = usePersonalSetup()
  const space = gettingStartedSpace(spaces)
  if (!space || !person || setup.hidden) return null
  const items = checklistFor(person.role, {
    canInvite: canInvite(person),
    items: setup.items,
  })
  return { space, progress: checklistProgress(items, setup.items) }
}

