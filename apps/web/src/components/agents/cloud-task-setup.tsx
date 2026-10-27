import { useId, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { AgentConnection } from "@worktable/types"
import { Button } from "@worktable/ui/components/button"
import { Input } from "@worktable/ui/components/input"
import { saveCloudTask, testCloudTask } from "@/lib/agent-connections-api"
import { CopyLine } from "./auto-reply"
import { SetupStep } from "./setup-step"

/** What Claude's scheduled task does each time Worktable fires it. */
export const CLOUD_TASK_PROMPT =
  "Check Worktable for comments and messages sent to you, and reply to each one there."

/** Set up Claude's scheduled task: create it, paste its trigger, test it. */
export function CloudTaskSetup({
  connection,
}: {
  connection: AgentConnection
}) {
  const id = useId()
  const queryClient = useQueryClient()
  const autoReply = connection.autoReply
  // The server keeps a saved URL and token, and never shows them.
  const saved = Boolean(
    autoReply && (autoReply.state !== "off" || autoReply.testing)
  )
  const [url, setUrl] = useState("")
  const [token, setToken] = useState("")
  const test = useMutation({
    mutationFn: () =>
      saved && !url.trim() && !token.trim()
        ? testCloudTask(connection)
        : saveCloudTask(connection, {
            ...(url.trim() ? { url: url.trim() } : {}),
            ...(token.trim() ? { token: token.trim() } : {}),
          }),
    // Stays pending until the list says it is testing, so nothing flickers.
    onSuccess: async () => {
      setUrl("")
      setToken("")
      await queryClient.invalidateQueries({ queryKey: ["agent-connections"] })
    },
  })
  const waiting = test.isPending || Boolean(autoReply?.testing)
  const ready = saved || Boolean(url.trim() && token.trim())
  return (
    <ol className="space-y-1">
      <SetupStep number={1} title="Create a scheduled task in Claude">
        <CopyLine text={CLOUD_TASK_PROMPT} />
        <a
          className="self-start text-sm text-primary-text hover:underline"
          href="https://claude.ai/code/routines"
          target="_blank"
          rel="noreferrer"
        >
          Open Claude ↗
        </a>
      </SetupStep>
      <SetupStep
        number={2}
        title="Add an API trigger and paste what Claude shows"
      >
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor={`${id}-url`}>
            URL
          </label>
          <Input
            id={`${id}-url`}
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            autoComplete="off"
            placeholder={
              saved
                ? "Saved · paste a URL to replace"
                : "https://api.anthropic.com/…"
            }
            disabled={waiting}
          />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor={`${id}-token`}>
            Token
          </label>
          <Input
            id={`${id}-token`}
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="new-password"
            placeholder={
              saved ? "Saved · paste a token to replace" : "sk-ant-…"
            }
            disabled={waiting}
          />
        </div>
      </SetupStep>
      <SetupStep number={3} title="Test it">
        <p className="text-sm text-muted-foreground">
          Claude replies in a test thread.
        </p>
        {test.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {test.error instanceof Error
              ? test.error.message
              : "Couldn’t save the task."}
          </p>
        ) : (
          autoReply?.state === "attention" &&
          autoReply.error && (
            <p className="text-sm text-warning">{autoReply.error}</p>
          )
        )}
        <div className="flex items-center gap-3">
          <Button disabled={!ready || waiting} onClick={() => test.mutate()}>
            Test
          </Button>
          {waiting && (
            <p role="status" className="text-sm text-muted-foreground">
              Waiting for Claude…
            </p>
          )}
        </div>
      </SetupStep>
    </ol>
  )
}
