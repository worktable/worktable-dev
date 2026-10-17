import { useQuery, type QueryClient } from "@tanstack/react-query"
import type {
  PersonalSetup,
  SetupAudience,
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

export type SetupAction =
  | { kind: "settings"; section: "agents" | "team"; label: string }
  | { kind: "doc"; path: string; label: string }
  | { kind: "threads"; label: string }

export interface ChecklistItem {
  id: SetupItemId
  title: string
  description: string
  action?: SetupAction
}

export interface ChecklistSection {
  title: string
  items: ChecklistItem[]
}

const CONNECT: ChecklistItem = {
  id: "connect-agent",
  title: "Connect an agent",
  description:
    "Bring Claude Code, Codex, or another agent so it can work in your Spaces.",
  action: { kind: "settings", section: "agents", label: "Connect" },
}

const FIRST_TASK: ChecklistItem = {
  id: "first-task",
  title: "Give an agent its first task",
  description:
    "Ask it to make a Space for something you're working on and write the first draft.",
  action: { kind: "doc", path: "prompts-to-try", label: "Prompts to try" },
}

const ASK_REVIEW: ChecklistItem = {
  id: "ask-review",
  title: "Ask for a review",
  description:
    "Ask your agent to review a doc. Its comments appear beside the text, and you can reply or ask for changes.",
  action: { kind: "doc", path: "prompts-to-try", label: "Copy a prompt" },
}

/** Each person's own list, in the order it is worth doing. */
export function checklistFor(
  role: "owner" | "member",
  audience: SetupAudience | undefined,
  joinedSpaceName?: string
): ChecklistSection[] {
  if (role === "member") {
    return [
      {
        title: "Set up",
        items: [
          {
            id: "join-space",
            title: joinedSpaceName ? `Join ${joinedSpaceName}` : "Join the team",
            description: "You're in.",
          },
          {
            ...CONNECT,
            title: "Connect your agent",
            description:
              "Bring Claude Code, Codex, or another agent so it can work here too.",
          },
          { ...FIRST_TASK, title: "Give your agent a first task" },
        ],
      },
      {
        title: "Work with your agents",
        items: [
          ASK_REVIEW,
          {
            id: "answer-thread",
            title: "Answer an agent in a Thread",
            description:
              "When an agent needs something from you, it asks in Threads. Reply there.",
            action: { kind: "threads", label: "Open Threads" },
          },
        ],
      },
    ]
  }
  const team = audience !== "solo"
  return [
    {
      title: "Set up",
      items: [
        CONNECT,
        FIRST_TASK,
        ...(team
          ? [
              {
                id: "invite-team",
                title: "Invite your team",
                description:
                  "Invite people into a Space with work already in it. This completes when someone joins.",
                action: { kind: "settings", section: "team", label: "Invite" },
              } satisfies ChecklistItem,
            ]
          : []),
      ],
    },
    {
      title: "Work with your agents",
      items: [
        ASK_REVIEW,
        {
          id: "agent-on-call",
          title: "Keep an agent on call",
          description:
            "Connect OpenClaw or Hermes to answer you in Threads while you're away.",
          action: { kind: "settings", section: "agents", label: "Connect" },
        },
        {
          id: "track-records",
          title: "Track work as Records",
          description:
            "Ask an agent to turn a checklist into Records with a board, like the Launch Plan example.",
          action: { kind: "doc", path: "launch-board", label: "See the example" },
        },
      ],
    },
    {
      title: "Make it yours",
      items: [
        team
          ? {
              id: "pin-start",
              title: "Write your team's welcome",
              description:
                "Have an agent draft a Start Here doc from your Spaces, then pin it.",
              action: { kind: "doc", path: "prompts-to-try", label: "Copy the prompt" },
            }
          : {
              id: "pin-start",
              title: "Pin your starting point",
              description:
                "Pin the doc you come back to most, so it leads its Space.",
            },
      ],
    },
  ]
}

export interface ChecklistProgress {
  done: number
  total: number
  next: ChecklistItem | null
}

export function checklistProgress(
  sections: ChecklistSection[],
  items: PersonalSetup["items"]
): ChecklistProgress {
  const all = sections.flatMap((section) => section.items)
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
  audience?: SetupAudience
  hidden?: boolean
  welcomed?: boolean
  watch?: "start" | "stop"
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
