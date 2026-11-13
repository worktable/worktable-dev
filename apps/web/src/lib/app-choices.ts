import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { AgentConnection } from "@worktable/types"
import { toast } from "@worktable/ui/components/sonner"
import { fetchJSON, HttpError } from "./http"

/** An app at Cloud's shared address, from the family Cloud recognizes. */
export type AppFamily = "chatgpt" | "claude" | "grok"

/** Where one app the person connected through Cloud works. */
export interface AppChoice {
  clientId: string
  name: string
  family: AppFamily | null
  /** Cloud's page that changes where this app works. */
  changeUrl: string
  /** Null until the person has a Worktable it can work in. */
  worktable: {
    id: string
    name: string
    /** The device a linked Worktable is on. */
    device?: string
    /** Whether it is the Worktable open here. */
    here: boolean
  } | null
}

export interface AppChoices {
  apps: AppChoice[]
  /** Cloud's Apps page, which lists every app and moves one anywhere. */
  appsUrl: string
}

/**
 * Where the person's Cloud apps work, from Cloud. Null when this Worktable
 * isn't reached through Cloud, or Cloud can't say: the setup steps then read
 * as they did before Cloud told us.
 */
export function useAppChoices(active = true) {
  return useQuery({
    queryKey: ["app-choices"],
    queryFn: async (): Promise<AppChoices | null> => {
      try {
        return await fetchJSON<AppChoices>("/api/app-choices")
      } catch (error) {
        if (error instanceof HttpError && [400, 404, 503].includes(error.status))
          return null
        throw error
      }
    },
    enabled: active,
    retry: false,
    staleTime: 15_000,
  })
}

/** The app of this family that works through Cloud, if the person has one. */
export function appOfFamily(
  choices: AppChoices | null | undefined,
  family: AppFamily
): AppChoice | undefined {
  return choices?.apps.find((app) => app.family === family)
}

/** The app behind a connection, matched by its signed client id. */
export function appForClient(
  choices: AppChoices | null | undefined,
  clientId: string | null | undefined
): AppChoice | undefined {
  if (!clientId) return undefined
  return choices?.apps.find((app) => app.clientId === clientId)
}

/** "Karo's Worktable" or "Control Base on clawd". */
export function worktableLabel(worktable: NonNullable<AppChoice["worktable"]>) {
  return worktable.device
    ? `${worktable.name} on ${worktable.device}`
    : worktable.name
}

/**
 * Use here: the app works in this Worktable from its next request. The toast
 * offers Undo, which puts it back where it was.
 */
export function useUseHere() {
  const queryClient = useQueryClient()
  const choose = (clientId: string, worktableId?: string) =>
    fetchJSON<AppChoices>("/api/app-choices", {
      method: "POST",
      body: JSON.stringify({ clientId, ...(worktableId ? { worktableId } : {}) }),
    })
  const settle = (choices: AppChoices) => {
    queryClient.setQueryData(["app-choices"], choices)
    void queryClient.invalidateQueries({ queryKey: ["agent-connections"] })
  }
  return useMutation({
    mutationFn: (app: AppChoice) => choose(app.clientId),
    onSuccess: (choices, app) => {
      settle(choices)
      const before = app.worktable
      toast.success(
        `${app.name} now works here.`,
        before && !before.here
          ? {
              action: {
                label: "Undo",
                onClick: () =>
                  void choose(app.clientId, before.id)
                    .then((restored) => {
                      settle(restored)
                      toast.success(
                        `${app.name} works in ${worktableLabel(before)} again.`
                      )
                    })
                    .catch(() => toast.error(`Couldn’t move ${app.name} back.`)),
              },
            }
          : undefined
      )
    },
    onError: (_error, app) => toast.error(`Couldn’t move ${app.name} here.`),
  })
}

/** The Cloud app behind a connection, when Cloud says where it works. */
export function useConnectionApp(
  connection: AgentConnection | null | undefined,
  active = true
): AppChoice | undefined {
  const choices = useAppChoices(active && connection?.authKind === "oauth")
  return connection?.target.kind === "mcp-client"
    ? appForClient(choices.data, connection.target.clientId)
    : undefined
}

/** Whether an app works in a Worktable other than this one. */
export function worksElsewhere(app: AppChoice | undefined): boolean {
  return Boolean(app?.worktable && !app.worktable.here)
}
