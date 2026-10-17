import { SourceCodeLink } from "@/components/source-code-link"
import {
  CACHED_SYSTEM_VERSION_QUERY_KEY,
  getCachedSystemVersion,
} from "@/lib/system-api"
import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { Check, Loader2 } from "lucide-react"
import type { ParticipantRef } from "@worktable/types"
import { Button } from "@worktable/ui/components/button"
import { Callout } from "@worktable/ui/components/callout"
import { Input } from "@worktable/ui/components/input"
import { Textarea } from "@worktable/ui/components/textarea"
import { useCopy } from "@worktable/ui/hooks/use-copy"
import { cn } from "@worktable/ui/lib/utils"
import { AgentAvatar } from "@/components/agents/agent-avatar"
import { SpaceIcon } from "@/components/spaces/space-icon"
import type { SpaceView, WorkspaceInfo } from "@/lib/api"
import { createSpace, updateWorkspace } from "@/lib/api"
import { createClientId } from "@/lib/client-id"
import { createDoc } from "@/lib/docs-api"
import { setPins } from "@/lib/lifetime"
import { getCurrentUser, getUserProfile, updateUserProfile } from "@/lib/profile"
import { queryKeys, useSpaces } from "@/lib/queries"
import {
  GETTING_STARTED_SPACE_ID,
  gettingStartedSpace,
  saveSetup,
  usePersonalSetup,
} from "@/lib/setup"
import {
  activateTeams,
  inviteTeamMember,
  type InvitationEmailStatus,
} from "@/lib/team-api"
import { createThread, listThreadParticipants } from "@/lib/threads-api"
import { useSpaceEvents } from "@/hooks/use-space-events"
import { ConnectStep } from "./connect-step"
import { StepHeading, Waiting } from "./onboarding-shared"
import {
  ensureStarterThreadKey,
  isSetupRecord,
  type SetupRecord,
} from "@/lib/onboarding-setups"

type Step = "welcome" | "connect" | "task" | "handoff" | "invite" | "done"
type Audience = "solo" | "team"

interface Invited {
  email: string
  url?: string
  status?: InvitationEmailStatus | null
  error?: string
}

interface SetupDraft {
  step: Step
  setups: SetupRecord[]
  task?: string
  /** The Space setup made itself, when no agent was connected. */
  spaceId?: string
  /** The always-on agent's first Thread. */
  threadId?: string
  invited?: Invited[]
}

const STEPS: Step[] = ["welcome", "connect", "task", "handoff", "invite", "done"]
const DEFAULT_DRAFT: SetupDraft = { step: "welcome", setups: [] }

const STARTERS = [
  {
    label: "Plan a launch",
    value: "Planning our launch: goals, timeline, and what's still undecided",
  },
  {
    label: "Research a market",
    value:
      "Researching [market]: who's in it, what they pay for, and where we fit",
  },
  {
    label: "Write a spec",
    value: "Writing a spec for [feature]: the problem, the approach, and open questions",
  },
  {
    label: "Organize notes",
    value: "Organizing our notes from [project] into decisions and next steps",
  },
] as const

function draftKey(workspaceId: string): string {
  return `worktable-onboarding:${workspaceId}`
}

function isStep(value: unknown): value is Step {
  return STEPS.includes(value as Step)
}

function readDraft(workspaceId: string): SetupDraft {
  try {
    const raw = localStorage.getItem(draftKey(workspaceId))
    if (!raw) return DEFAULT_DRAFT
    const value = JSON.parse(raw) as Partial<SetupDraft>
    if (
      !isStep(value.step) ||
      !Array.isArray(value.setups) ||
      !value.setups.every(isSetupRecord)
    ) {
      return DEFAULT_DRAFT
    }
    return {
      step: value.step,
      setups: value.setups.map(ensureStarterThreadKey),
      ...(typeof value.task === "string" ? { task: value.task } : {}),
      ...(typeof value.spaceId === "string" ? { spaceId: value.spaceId } : {}),
      ...(typeof value.threadId === "string" ? { threadId: value.threadId } : {}),
      ...(Array.isArray(value.invited) ? { invited: value.invited } : {}),
    }
  } catch {
    return DEFAULT_DRAFT
  }
}

function writeDraft(workspaceId: string, draft: SetupDraft): void {
  try {
    localStorage.setItem(draftKey(workspaceId), JSON.stringify(draft))
  } catch {
    // Reload recovery is best-effort; the server keeps what matters.
  }
}

function usefulName(value: string | undefined): string {
  const name = value?.trim() ?? ""
  return ["User", "Owner", "Worktable user"].includes(name) ? "" : name
}

function initialWorktableName(workspace: WorkspaceInfo): string {
  return ["Local Workspace", "My Workspace"].includes(workspace.name)
    ? ""
    : workspace.name
}

/** A short Space name from a sentence about the work. */
export function spaceNameFrom(task: string): string {
  const clause = task.split(/[:.\n,;(]/)[0]?.trim() ?? ""
  const words = clause.split(/\s+/).filter(Boolean)
  let name = ""
  for (const word of words) {
    if ((name + " " + word).trim().length > 40) break
    name = (name + " " + word).trim()
  }
  if (!name) return "First Project"
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/** What the agent is asked to do with the person's answer. */
export function firstTaskPrompt(task: string): string {
  return `In Worktable, make a Space for this and write a first brief in it: ${task.trim()}. Cover the goal, the plan so far, and what's still undecided.`
}

/** The command line for a CLI agent, where one starts with a prompt. */
function promptCommand(setup: SetupRecord | undefined, prompt: string): string {
  const quoted = `"${prompt.replace(/(["\\$`])/g, "\\$1")}"`
  if (setup?.platform === "claude-code") return `claude ${quoted}`
  if (setup?.platform === "codex") return `codex ${quoted}`
  return prompt
}

function Terminal({ value, label }: { value: string; label: string }) {
  const copy = useCopy()
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface-inset">
      <div className="flex items-center justify-between border-b border-border px-3.5 py-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        <button
          type="button"
          className="text-xs font-medium text-primary-text hover:underline"
          onClick={() => void copy.copy(value)}
        >
          {copy.copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="px-3.5 py-3 font-mono text-xs leading-5 whitespace-pre-wrap text-foreground">
        {value}
      </pre>
    </div>
  )
}

function Choice({
  selected,
  title,
  description,
  onSelect,
}: {
  selected: boolean
  title: string
  description: string
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-3 rounded-xl border px-4 py-3.5 text-left transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
        selected
          ? "border-primary bg-surface-tint/50"
          : "border-border hover:border-input-hover"
      )}
    >
      <span
        className={cn(
          "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border",
          selected ? "border-primary" : "border-input"
        )}
      >
        {selected && <span className="size-2 rounded-full bg-primary" />}
      </span>
      <span>
        <span className="block text-sm font-medium text-foreground">{title}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {description}
        </span>
      </span>
    </button>
  )
}

function AudienceChoice({
  value,
  onChange,
}: {
  value: Audience | null
  onChange: (value: Audience) => void
}) {
  return (
    <div role="radiogroup" aria-label="Who it's for" className="space-y-2.5">
      <Choice
        selected={value === "solo"}
        title="Just me"
        description="You and your agents"
        onSelect={() => onChange("solo")}
      />
      <Choice
        selected={value === "team"}
        title="My team"
        description="Everyone signs in as themselves"
        onSelect={() => onChange("team")}
      />
    </div>
  )
}

function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null
  return (
    <Callout variant="danger" className="mt-5">
      {error instanceof Error ? error.message : "Something went wrong. Try again."}
    </Callout>
  )
}

function WelcomeStep({
  workspace,
  cloud,
  audience,
  onContinue,
}: {
  workspace: WorkspaceInfo
  cloud: boolean
  audience: Audience | undefined
  onContinue: (audience: Audience, reload: boolean) => void
}) {
  const queryClient = useQueryClient()
  const profile = useQuery({ queryKey: ["profile"], queryFn: getUserProfile })
  const [typedName, setTypedName] = useState<string | null>(null)
  const [worktableName, setWorktableName] = useState(() =>
    initialWorktableName(workspace)
  )
  const [chosen, setChosen] = useState<Audience | null>(audience ?? null)
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const name =
    typedName ?? usefulName(profile.data?.name ?? getCurrentUser().name)
  const teamsOn = Boolean(workspace.teamContext)
  const needsAccount = !cloud && chosen === "team" && !teamsOn

  const save = useMutation({
    mutationFn: async () => {
      if (!chosen) return
      if (!cloud) {
        const updated = await updateWorkspace({ name: worktableName.trim() })
        queryClient.setQueryData(queryKeys.workspace, updated)
        await updateUserProfile(name.trim())
      }
      await saveSetup(queryClient, { audience: chosen })
      if (needsAccount) {
        await activateTeams({ name: name.trim(), email: email.trim(), password })
      }
    },
    onSuccess: () => {
      if (chosen) onContinue(chosen, needsAccount)
    },
  })

  const ready =
    chosen !== null &&
    (cloud || (name.trim() && worktableName.trim())) &&
    (!needsAccount || (email.includes("@") && password.length >= 8))

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (ready) save.mutate()
      }}
    >
      {cloud ? (
        <StepHeading
          title={name ? `Welcome, ${name.split(/\s+/)[0]}` : "Welcome"}
          description={`Who'll be working in ${workspace.name}?`}
        />
      ) : (
        <StepHeading
          title="Set up your Worktable"
          description="Name it, then say who it's for."
        />
      )}
      <div className="mt-7 space-y-5">
        {!cloud && (
          <>
            <div className="space-y-1.5">
              <label htmlFor="setup-name" className="text-sm font-medium">
                Your name
              </label>
              <Input
                id="setup-name"
                value={name}
                maxLength={100}
                autoComplete="name"
                autoFocus
                onChange={(event) => setTypedName(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="setup-worktable" className="text-sm font-medium">
                Worktable
              </label>
              <Input
                id="setup-worktable"
                value={worktableName}
                maxLength={200}
                placeholder="Usually your team or company"
                onChange={(event) => setWorktableName(event.target.value)}
              />
            </div>
          </>
        )}
        <AudienceChoice value={chosen} onChange={setChosen} />
        {needsAccount && (
          <div className="space-y-4 border-t border-border pt-5">
            <div className="space-y-1.5">
              <label htmlFor="setup-email" className="text-sm font-medium">
                Your email
              </label>
              <Input
                id="setup-email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="setup-password" className="text-sm font-medium">
                Password
              </label>
              <Input
                id="setup-password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                placeholder="At least 8 characters"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Teammates sign in with their own accounts, so you need one too.
              </p>
            </div>
          </div>
        )}
      </div>
      <ErrorNote error={save.error} />
      <div className="mt-8 flex justify-end">
        <Button type="submit" disabled={!ready || save.isPending}>
          {save.isPending ? "Saving…" : "Continue"}
        </Button>
      </div>
    </form>
  )
}

function TaskStep({
  agent,
  initialTask,
  team,
  onStart,
  onSkip,
  onBack,
}: {
  agent: SetupRecord | undefined
  initialTask: string
  team: boolean
  onStart: (task: string, spaceId?: string) => void
  onSkip: () => void
  onBack: () => void
}) {
  const queryClient = useQueryClient()
  const [task, setTask] = useState(initialTask)
  const start = useMutation({
    mutationFn: async () => {
      const text = task.trim()
      if (agent) {
        await saveSetup(queryClient, { watch: "start" })
        return undefined
      }
      // Without an agent, Worktable makes the Space and pins a brief to
      // start from.
      const name = spaceNameFrom(text)
      const { spaceId } = await createSpace({ name, description: text })
      const brief = await createDoc(spaceId, `${name} Brief`, [
        {
          type: "paragraph",
          content: [{ type: "text", text, styles: {} }],
        },
      ])
      await setPins(spaceId, [{ path: brief.path }])
      void queryClient.invalidateQueries({ queryKey: queryKeys.spaces })
      return spaceId
    },
    onSuccess: (spaceId) => onStart(task.trim(), spaceId),
  })
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (task.trim()) start.mutate()
      }}
    >
      <StepHeading
        title="What are you working on?"
        description={
          agent
            ? `${agent.name} will make a Space for it and write the first draft.`
            : "Worktable will make a Space for it, with a brief to start from."
        }
      />
      <div className="mt-7">
        <Textarea
          aria-label="What you're working on"
          rows={3}
          autoFocus
          value={task}
          maxLength={400}
          placeholder="Planning our spring release: goals, timeline, and what's still undecided"
          onChange={(event) => setTask(event.target.value)}
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {agent && (
            <span className="mr-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <AgentAvatar
                name={agent.name}
                platform={agent.platform}
                className="size-5"
              />
              {agent.name}
            </span>
          )}
          {STARTERS.map((starter) => (
            <button
              key={starter.label}
              type="button"
              onClick={() => setTask(starter.value)}
              className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-input-hover hover:text-foreground"
            >
              {starter.label}
            </button>
          ))}
        </div>
      </div>
      <ErrorNote error={start.error} />
      <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
        <Button type="button" variant="ghost" onClick={onBack}>
          Back
        </Button>
        <div className="flex items-center gap-2">
          <Button type="button" variant="ghost" onClick={onSkip}>
            {team ? "Skip for now" : "Skip"}
          </Button>
          <Button type="submit" disabled={!task.trim() || start.isPending}>
            {start.isPending ? "Starting…" : "Start"}
          </Button>
        </div>
      </div>
    </form>
  )
}

/** One line of the agent's progress, shown only once the write happens. */
function ProgressLine({
  done,
  children,
}: {
  done: boolean
  children: React.ReactNode
}) {
  return (
    <li className="flex items-center gap-2.5 text-sm">
      {done ? (
        <span className="grid size-5 place-items-center rounded-full bg-primary text-primary-foreground">
          <Check className="size-3" strokeWidth={3} />
        </span>
      ) : (
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      )}
      <span className={done ? "text-foreground" : "text-muted-foreground"}>
        {children}
      </span>
    </li>
  )
}

function docTitle(path: string): string {
  const name = (path.split("/").pop() ?? path).replace(/[-_]+/g, " ").trim()
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/** The agent's progress during setup, from what the server saw it make. */
function useAgentProgress(spaces: SpaceView[] | undefined) {
  const { setup } = usePersonalSetup()
  const spaceId = setup.watch?.space?.spaceId ?? setup.watch?.doc?.spaceId
  const space = spaceId ? spaces?.find((entry) => entry.id === spaceId) : undefined
  return {
    spaceId,
    spaceName: space?.name,
    doc: setup.watch?.doc,
    started: Boolean(setup.watch?.space || setup.watch?.doc),
  }
}

function AlwaysOnHandoff({
  agent,
  message,
  savedThreadId,
  onThreadStarted,
}: {
  agent: SetupRecord
  message: string
  savedThreadId?: string
  onThreadStarted: (threadId: string) => void
}) {
  const [key] = useState(
    () => agent.starterThreadKey ?? createClientId("onboarding-thread")
  )
  const participants = useQuery({
    queryKey: ["threads", "participants"],
    queryFn: () => listThreadParticipants(),
    refetchInterval: savedThreadId ? false : 3_000,
  })
  const matches = (participants.data?.participants ?? []).filter(
    (item: ParticipantRef) => item.name === (agent.participantName ?? agent.name)
  )
  const participant = matches.length === 1 ? matches[0] : undefined
  const start = useMutation({
    mutationFn: (target: ParticipantRef) =>
      createThread(
        { kind: "worktable" },
        { to: target.id, body: message, idempotencyKey: key, waitSeconds: 0 }
      ),
    onSuccess: (result) => onThreadStarted(result.threadId),
  })
  useEffect(() => {
    if (!savedThreadId && participant && start.isIdle) start.mutate(participant)
  }, [participant, savedThreadId, start])
  return (
    <>
      <div className="rounded-xl border border-border bg-surface-inset px-4 py-3 text-sm leading-6 text-foreground">
        {message}
      </div>
      {!savedThreadId && (
        <div className="mt-3">
          {start.isError ? (
            <Callout variant="danger">
              Couldn’t start the Thread.{" "}
              <button
                type="button"
                className="font-medium underline underline-offset-2"
                onClick={() => participant && start.mutate(participant)}
              >
                Try again
              </button>
            </Callout>
          ) : (
            <Waiting>Sending it to {agent.name} in a Thread…</Waiting>
          )}
        </div>
      )}
    </>
  )
}

function HandoffStep({
  agent,
  task,
  team,
  threadId,
  onThreadStarted,
  onContinue,
  onBack,
}: {
  agent: SetupRecord
  task: string
  team: boolean
  threadId?: string
  onThreadStarted: (threadId: string) => void
  onContinue: () => void
  onBack: () => void
}) {
  const { data: spaces } = useSpaces()
  const progress = useAgentProgress(spaces)
  const prompt = firstTaskPrompt(task)
  const alwaysOn = agent.mode === "always-on"
  return (
    <>
      <StepHeading
        title={`Over to ${agent.name}`}
        description={
          alwaysOn
            ? `${agent.name} gets this in a Thread. Its work shows up here as it lands.`
            : `Paste this into ${agent.name}. Its work shows up here as it lands.`
        }
      />
      <div className="mt-7">
        {alwaysOn ? (
          <AlwaysOnHandoff
            agent={agent}
            message={prompt}
            savedThreadId={threadId}
            onThreadStarted={onThreadStarted}
          />
        ) : (
          <Terminal
            value={promptCommand(agent, prompt)}
            label={
              agent.platform === "claude-code" || agent.platform === "codex"
                ? "Terminal"
                : agent.name
            }
          />
        )}
      </div>
      <ul className="mt-6 space-y-2.5" aria-live="polite">
        {progress.started ? (
          <>
            {progress.spaceName && (
              <ProgressLine done>Created {progress.spaceName}</ProgressLine>
            )}
            {progress.doc ? (
              <ProgressLine done>
                Wrote {docTitle(progress.doc.path ?? "")}
              </ProgressLine>
            ) : (
              <ProgressLine done={false}>Writing the brief</ProgressLine>
            )}
          </>
        ) : (
          <ProgressLine done={false}>
            Waiting for {agent.name} to start
          </ProgressLine>
        )}
      </ul>
      <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        {progress.started ? (
          <Button onClick={onContinue}>Continue</Button>
        ) : (
          <Button variant="ghost" onClick={onContinue}>
            {team ? "Invite people while it works" : "Continue without waiting"}
          </Button>
        )}
      </div>
    </>
  )
}

function parseEmails(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,;]+/)
        .map((item) => item.trim().toLowerCase())
        .filter((item) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(item))
    ),
  ]
}

function InviteResult({ invited, cloud }: { invited: Invited; cloud: boolean }) {
  const copy = useCopy()
  return (
    <li className="flex min-w-0 items-center gap-3 px-4 py-3 text-sm">
      <span className="min-w-0 flex-1 truncate text-foreground">{invited.email}</span>
      {invited.error ? (
        <span className="shrink-0 text-xs text-destructive">{invited.error}</span>
      ) : invited.status === "sent" ? (
        <span className="shrink-0 text-xs text-muted-foreground">Emailed</span>
      ) : invited.url ? (
        <>
          {cloud && (
            <span className="shrink-0 text-xs text-muted-foreground">
              Not emailed
            </span>
          )}
          <button
            type="button"
            className="shrink-0 text-xs font-medium text-primary-text hover:underline"
            onClick={() => void copy.copy(invited.url!)}
          >
            {copy.copied ? "Copied" : "Copy link"}
          </button>
        </>
      ) : null}
    </li>
  )
}

function InviteStep({
  agent,
  cloud,
  spaceId,
  invited,
  onInvited,
  onContinue,
  onBack,
}: {
  agent: SetupRecord | undefined
  cloud: boolean
  spaceId: string | undefined
  invited: Invited[] | undefined
  onInvited: (invited: Invited[]) => void
  onContinue: () => void
  onBack: () => void
}) {
  const { data: spaces } = useSpaces()
  const progress = useAgentProgress(spaces)
  const space = spaceId ? spaces?.find((entry) => entry.id === spaceId) : undefined
  const [text, setText] = useState("")
  const emails = parseEmails(text)
  const send = useMutation({
    mutationFn: async () => {
      const results: Invited[] = []
      for (const email of emails) {
        try {
          const result = await inviteTeamMember(email, space?.id)
          results.push({ email, url: result.url, status: result.email })
        } catch (error) {
          results.push({
            email,
            error: error instanceof Error ? error.message : "Couldn’t invite",
          })
        }
      }
      return results
    },
    onSuccess: (results) => onInvited([...(invited ?? []), ...results]),
  })
  const writing = agent && progress.started && !progress.doc
  const count = emails.length
  return (
    <>
      {writing && (
        <p className="mb-6 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> {agent.name} is writing
        </p>
      )}
      <StepHeading
        title="Invite your team"
        description={
          space
            ? `They'll join you in ${space.name}.`
            : "They'll join you in this Worktable."
        }
      />
      {invited?.length ? (
        <ul className="mt-7 card-surface divide-y divide-border rounded-xl">
          {invited.map((item) => (
            <InviteResult key={item.email} invited={item} cloud={cloud} />
          ))}
        </ul>
      ) : null}
      <form
        className="mt-7"
        onSubmit={(event) => {
          event.preventDefault()
          if (count) send.mutate(undefined, { onSuccess: () => setText("") })
        }}
      >
        <label htmlFor="invite-emails" className="text-sm font-medium">
          Emails
        </label>
        <Textarea
          id="invite-emails"
          rows={2}
          className="mt-1.5"
          value={text}
          placeholder="maya@example.com, jon@example.com"
          onChange={(event) => setText(event.target.value)}
        />
        {space && (
          <div className="mt-3 flex items-center gap-2.5 text-sm">
            <SpaceIcon space={space} size="sm" />
            <span className="min-w-0 flex-1 truncate text-foreground">
              {space.name}
            </span>
            <span className="text-xs text-muted-foreground">Can edit</span>
          </div>
        )}
        {!cloud && (
          <p className="mt-3 text-xs text-muted-foreground">
            Send each person their link. Anyone with the link can join until it
            expires in 48 hours.
          </p>
        )}
        <ErrorNote error={send.error} />
        <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
          <Button type="button" variant="ghost" onClick={onBack}>
            Back
          </Button>
          <div className="flex items-center gap-2">
            {invited?.length ? (
              <>
                {count > 0 && (
                  <Button type="submit" variant="outline" disabled={send.isPending}>
                    {cloud
                      ? `Send ${count === 1 ? "invitation" : `${count} invitations`}`
                      : `Create ${count === 1 ? "link" : `${count} links`}`}
                  </Button>
                )}
                <Button type="button" onClick={onContinue}>
                  Continue
                </Button>
              </>
            ) : (
              <>
                <Button type="button" variant="ghost" onClick={onContinue}>
                  I’ll do this later
                </Button>
                <Button type="submit" disabled={!count || send.isPending}>
                  {send.isPending
                    ? "Inviting…"
                    : cloud
                      ? count > 1
                        ? `Send ${count} invitations`
                        : "Send invitation"
                      : count > 1
                        ? `Create ${count} invite links`
                        : "Create invite link"}
                </Button>
              </>
            )}
          </div>
        </div>
      </form>
    </>
  )
}

function DoneStep({
  agent,
  spaceId,
  onFinish,
  finishing,
  error,
}: {
  agent: SetupRecord | undefined
  spaceId: string | undefined
  onFinish: (spaceId: string | undefined) => void
  finishing: boolean
  error: unknown
}) {
  const { data: spaces } = useSpaces()
  const progress = useAgentProgress(spaces)
  const space = spaceId ? spaces?.find((entry) => entry.id === spaceId) : undefined
  const stillWriting = agent && progress.started && !progress.doc
  const description = space
    ? stillWriting
      ? `${agent.name} is still writing. You'll find it in ${space.name}, and the rest of your first steps are in Getting Started.`
      : `Your work is in ${space.name}, and the rest of your first steps are in Getting Started.`
    : "Your first steps are waiting in Getting Started."
  return (
    <>
      <StepHeading title="You're set up" description={description} />
      <ErrorNote error={error} />
      <div className="mt-8 flex justify-end">
        <Button disabled={finishing} onClick={() => onFinish(space?.id)}>
          {finishing
            ? "Opening…"
            : space
              ? `Open ${space.name}`
              : "Open Getting Started"}
        </Button>
      </div>
    </>
  )
}

/** Steps this person will see, for the bar at the top. */
function visibleSteps(team: boolean, agent: boolean): Step[] {
  return STEPS.filter(
    (step) =>
      (step !== "invite" || team) && (step !== "handoff" || agent)
  )
}

export function Onboarding({ workspace }: { workspace: WorkspaceInfo }) {
  const versionQuery = useQuery({
    queryKey: CACHED_SYSTEM_VERSION_QUERY_KEY,
    queryFn: getCachedSystemVersion,
    staleTime: Infinity,
  })
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { person, setup } = usePersonalSetup()
  const [draft, setDraft] = useState(() => readDraft(workspace.id))
  const { data: spaces } = useSpaces()
  // Setup has no sidebar; keep a socket open so the agent's progress, which
  // the server sends to this person, arrives while it waits.
  useSpaceEvents(gettingStartedSpace(spaces)?.id ?? spaces?.[0]?.id)

  useEffect(() => writeDraft(workspace.id, draft), [draft, workspace.id])

  const cloud = person?.signOut === "cloud"
  const team = setup.audience !== "solo"
  // The agent to hand the first task to: the first one connected here.
  const agent = draft.setups[0]
  const agentProgress = useAgentProgress(spaces)
  const workSpaceId = agentProgress.spaceId ?? draft.spaceId

  const finish = useMutation({
    mutationFn: async (spaceId: string | undefined) => {
      // The agent's brief leads its Space, as the team's starting point.
      const doc = setup.watch?.doc
      if (spaceId && doc?.path && doc.spaceId === spaceId) {
        await setPins(spaceId, [{ path: doc.path }]).catch(() => undefined)
      }
      if (setup.watch) await saveSetup(queryClient, { watch: "stop" })
      const updated = await updateWorkspace({ onboarding: { status: "complete" } })
      return { updated, spaceId }
    },
    onSuccess: ({ updated, spaceId }) => {
      try {
        localStorage.removeItem(draftKey(workspace.id))
      } catch {
        // The server state is already complete.
      }
      queryClient.setQueryData(queryKeys.workspace, {
        ...updated,
        setup: queryClient.getQueryData<WorkspaceInfo>(queryKeys.workspace)?.setup,
      })
      void navigate({
        to: "/spaces/$spaceId",
        params: { spaceId: spaceId ?? GETTING_STARTED_SPACE_ID },
      })
    },
  })

  function go(step: Step) {
    setDraft((current) => ({ ...current, step }))
  }

  const steps = visibleSteps(team, Boolean(agent))
  const position = Math.max(0, steps.indexOf(draft.step))
  const share = (position + 1) / steps.length

  return (
    <div className="min-h-dvh overflow-y-auto bg-background text-foreground">
      <div
        className="fixed inset-x-0 top-0 z-10 h-0.5 bg-border"
        role="progressbar"
        aria-label="Setup progress"
        aria-valuemin={0}
        aria-valuemax={steps.length}
        aria-valuenow={position + 1}
      >
        <div
          className="h-full bg-primary transition-[width] duration-500 motion-reduce:transition-none"
          style={{ width: `${share * 100}%` }}
        />
      </div>
      <main
        className={cn(
          "mx-auto w-full px-5 pt-[12vh] pb-16",
          draft.step === "connect" ? "max-w-xl" : "max-w-md"
        )}
      >
        {draft.step === "welcome" ? (
          <WelcomeStep
            workspace={workspace}
            cloud={cloud}
            audience={setup.audience}
            onContinue={(_audience, reload) => {
              const next = { ...draft, step: "connect" as const }
              if (reload) {
                // Turning on Teams changed who is signed in.
                writeDraft(workspace.id, next)
                window.location.reload()
                return
              }
              setDraft(next)
            }}
          />
        ) : draft.step === "connect" ? (
          <ConnectStep
            setups={draft.setups}
            onSetupsChange={(setups) =>
              setDraft((current) => ({ ...current, setups }))
            }
            onContinue={() => go("task")}
            onBack={() => go("welcome")}
          />
        ) : draft.step === "task" ? (
          <TaskStep
            agent={agent}
            initialTask={draft.task ?? ""}
            team={team}
            onStart={(task, spaceId) =>
              setDraft((current) => ({
                ...current,
                task,
                ...(spaceId ? { spaceId } : {}),
                step: agent ? "handoff" : team ? "invite" : "done",
              }))
            }
            onSkip={() => go(team ? "invite" : "done")}
            onBack={() => go("connect")}
          />
        ) : draft.step === "handoff" && agent ? (
          <HandoffStep
            agent={agent}
            task={draft.task ?? ""}
            team={team}
            threadId={draft.threadId}
            onThreadStarted={(threadId) =>
              setDraft((current) => ({ ...current, threadId }))
            }
            onContinue={() => go(team ? "invite" : "done")}
            onBack={() => go("task")}
          />
        ) : draft.step === "invite" ? (
          <InviteStep
            agent={agent}
            cloud={cloud}
            spaceId={workSpaceId}
            invited={draft.invited}
            onInvited={(invited) =>
              setDraft((current) => ({ ...current, invited }))
            }
            onContinue={() => go("done")}
            onBack={() => go(agent && draft.task ? "handoff" : "task")}
          />
        ) : (
          <DoneStep
            agent={agent}
            spaceId={workSpaceId}
            onFinish={(spaceId) => finish.mutate(spaceId)}
            finishing={finish.isPending}
            error={finish.error}
          />
        )}
        {versionQuery.data?.sourceUrl ? (
          <div className="mt-16 text-center">
            <SourceCodeLink sourceUrl={versionQuery.data.sourceUrl} />
          </div>
        ) : null}
      </main>
    </div>
  )
}
