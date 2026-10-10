import { SourceCodeLink } from "@/components/source-code-link"
import {
  CACHED_SYSTEM_VERSION_QUERY_KEY,
  getCachedSystemVersion,
} from "@/lib/system-api"
import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { Check, Loader2, UserRound } from "lucide-react"
import type { ParticipantRef } from "@worktable/types"
import { Button } from "@worktable/ui/components/button"
import { Callout } from "@worktable/ui/components/callout"
import { Input } from "@worktable/ui/components/input"
import { toast } from "@worktable/ui/components/sonner"
import { cn } from "@worktable/ui/lib/utils"
import type { WorkspaceInfo } from "@/lib/api"
import { updateWorkspace } from "@/lib/api"
import { createClientId } from "@/lib/client-id"
import {
  getCurrentUser,
  getUserProfile,
  updateUserProfile,
} from "@/lib/profile"
import { createThread, listThreadParticipants } from "@/lib/threads-api"
import { ConnectStep } from "./connect-step"
import { CopyValue, SetupList, StepHeading } from "./onboarding-shared"
import {
  ensureStarterThreadKey,
  isSetupRecord,
  type SetupRecord,
} from "@/lib/onboarding-setups"

type OnboardingStep = "identity" | "connect" | "ready"

interface OnboardingDraft {
  step: OnboardingStep
  setups: SetupRecord[]
  threads?: Array<{ setupId: string; id: string; participantName: string }>
}

const DEFAULT_DRAFT: OnboardingDraft = { step: "identity", setups: [] }
const STARTER_PROMPTS = [
  {
    label: "Plan a project",
    value:
      "Help me plan [project]. Find related work in Worktable, then save a short brief with the outcome, constraints, and open questions. Show me the result so we can revise it.",
  },
  {
    label: "Create a Space",
    value:
      "Find or create a Space for [what I’m working on]. Save [notes or source material] as a document, preserving decisions and open questions.",
  },
] as const
const ALWAYS_ON_FIRST_MESSAGE =
  "Help me choose a first task in Worktable. Ask what I want to accomplish, find any related work, and help me create or revise one useful result."

function draftKey(workspaceId: string): string {
  return `worktable-onboarding:${workspaceId}`
}

function readDraft(workspaceId: string): OnboardingDraft {
  try {
    const raw = localStorage.getItem(draftKey(workspaceId))
    if (!raw) return DEFAULT_DRAFT
    const value = JSON.parse(raw) as Partial<OnboardingDraft>
    if (!isOnboardingStep(value.step) || !isSetupList(value.setups)) {
      return DEFAULT_DRAFT
    }
    const setups = value.setups.map(ensureStarterThreadKey)
    return {
      step: value.step,
      setups,
      ...(isStarterThreadList(value.threads) ? { threads: value.threads } : {}),
    }
  } catch {
    return DEFAULT_DRAFT
  }
}

function isOnboardingStep(value: unknown): value is OnboardingStep {
  return value === "identity" || value === "connect" || value === "ready"
}

function isSetupList(value: unknown): value is SetupRecord[] {
  return Array.isArray(value) && value.every(isSetupRecord)
}

function isStarterThreadList(
  value: unknown
): value is NonNullable<OnboardingDraft["threads"]> {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        typeof (item as Record<string, unknown>)["setupId"] === "string" &&
        typeof (item as Record<string, unknown>)["id"] === "string" &&
        typeof (item as Record<string, unknown>)["participantName"] === "string"
    )
  )
}

function usefulName(value: string): string {
  const name = value.trim()
  return ["User", "Owner", "Worktable user"].includes(name) ? "" : name
}

function initialWorktableName(workspace: WorkspaceInfo): string {
  return ["Local Workspace", "My Workspace"].includes(workspace.name)
    ? ""
    : workspace.name
}

function StepProgress({ step }: { step: OnboardingStep }) {
  const steps: Array<{ id: OnboardingStep; label: string }> = [
    { id: "identity", label: "Set up" },
    { id: "connect", label: "Connect" },
    { id: "ready", label: "Ready" },
  ]
  const active = steps.findIndex((item) => item.id === step)
  return (
    <ol
      aria-label="Onboarding progress"
      className="mx-auto grid w-full max-w-sm grid-cols-3 gap-2"
    >
      {steps.map((item, index) => (
        <li
          key={item.id}
          aria-current={index === active ? "step" : undefined}
          className="flex flex-col items-center gap-1.5 text-center"
        >
          <span
            className={cn(
              "grid size-7 place-items-center rounded-full border text-xs font-medium",
              index < active &&
                "border-primary bg-primary text-primary-foreground",
              index === active &&
                "border-primary bg-background text-primary shadow-sm",
              index > active && "border-border text-muted-foreground"
            )}
          >
            {index < active ? <Check className="size-3.5" /> : index + 1}
          </span>
          <span
            className={cn(
              "text-xs",
              index === active
                ? "font-medium text-foreground"
                : "text-muted-foreground"
            )}
          >
            {item.label}
          </span>
        </li>
      ))}
    </ol>
  )
}

function IdentityStep({
  workspace,
  onContinue,
}: {
  workspace: WorkspaceInfo
  onContinue: (workspace: WorkspaceInfo) => void
}) {
  const queryClient = useQueryClient()
  const [userName, setUserName] = useState(() =>
    usefulName(getCurrentUser().name)
  )
  const [worktableName, setWorktableName] = useState(() =>
    initialWorktableName(workspace)
  )
  const [profileTouched, setProfileTouched] = useState(false)
  const profile = useQuery({ queryKey: ["profile"], queryFn: getUserProfile })
  const displayedUserName = profileTouched
    ? userName
    : usefulName(profile.data?.name ?? userName)

  const save = useMutation({
    mutationFn: async () => {
      const updated = await updateWorkspace({ name: worktableName.trim() })
      await updateUserProfile(displayedUserName.trim())
      return updated
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(["workspace"], updated)
      onContinue(updated)
    },
  })

  return (
    <>
      <StepHeading
        icon={<UserRound className="size-5" />}
        title="Set up your Worktable"
        description="Choose the names that identify you and this Worktable."
      />
      <div className="mt-7 space-y-5">
        <div className="space-y-1.5">
          <label htmlFor="onboarding-user-name" className="text-sm font-medium">
            Your name
          </label>
          <Input
            id="onboarding-user-name"
            value={displayedUserName}
            maxLength={100}
            autoComplete="name"
            autoFocus
            placeholder="Your name"
            onChange={(event) => {
              setProfileTouched(true)
              setUserName(event.target.value)
            }}
          />
          <p className="text-xs text-muted-foreground">
            Shown on your comments and Threads.
          </p>
        </div>
        <div className="space-y-1.5">
          <label
            htmlFor="onboarding-worktable-name"
            className="text-sm font-medium"
          >
            Worktable name
          </label>
          <Input
            id="onboarding-worktable-name"
            value={worktableName}
            maxLength={200}
            placeholder="Worktable name"
            onChange={(event) => setWorktableName(event.target.value)}
          />
        </div>
        {save.isError ? (
          <Callout variant="danger">
            {save.error instanceof Error
              ? save.error.message
              : "Couldn’t save these names."}
          </Callout>
        ) : null}
      </div>
      <div className="mt-8 flex justify-end">
        <Button
          disabled={
            save.isPending || !displayedUserName.trim() || !worktableName.trim()
          }
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Saving…" : "Continue"}
        </Button>
      </div>
    </>
  )
}

function AlwaysOnStarter({
  setup,
  headingId,
  participants,
  savedThread,
  onThreadStarted,
}: {
  setup: SetupRecord
  headingId: string
  participants: ParticipantRef[]
  savedThread?: NonNullable<OnboardingDraft["threads"]>[number]
  onThreadStarted: (
    thread: NonNullable<OnboardingDraft["threads"]>[number]
  ) => void
}) {
  const [starterThreadKey] = useState(
    () => setup.starterThreadKey ?? createClientId("onboarding-thread")
  )
  const participantMatches = participants.filter(
    (item) => item.name === setup.participantName
  )
  const participant =
    participantMatches.length === 1 ? participantMatches[0] : undefined
  const startThread = useMutation({
    mutationFn: async (target: ParticipantRef) =>
      createThread(
        { kind: "worktable" },
        {
          to: target.id,
          body: ALWAYS_ON_FIRST_MESSAGE,
          idempotencyKey: starterThreadKey,
          waitSeconds: 0,
        }
      ),
    onSuccess: (result) => {
      onThreadStarted({
        setupId: setup.id,
        id: result.threadId,
        participantName: setup.participantName ?? setup.name,
      })
    },
  })

  return (
    <section className="space-y-3" aria-labelledby={headingId}>
      <h2 id={headingId} className="text-sm font-medium">
        Start a Thread with {setup.name}
      </h2>
      <CopyValue
        value={ALWAYS_ON_FIRST_MESSAGE}
        label="Copy starter message"
        wrap
      />
      {savedThread ? (
        <Callout variant="success">
          Thread started. Finish setup now and check Threads whenever you’re
          ready.
        </Callout>
      ) : participant ? (
        <Button
          disabled={startThread.isPending}
          onClick={() => startThread.mutate(participant)}
        >
          {startThread.isPending ? "Starting…" : "Start Thread"}
        </Button>
      ) : participantMatches.length > 1 ? (
        <Callout variant="warning">
          More than one Thread participant matches this agent. Finish setup and
          start the Thread from Threads.
        </Callout>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Waiting for {setup.name}{" "}
          to appear in Threads…
        </p>
      )}
      {startThread.isError ? (
        <Callout variant="danger">
          {startThread.error instanceof Error
            ? startThread.error.message
            : "Couldn’t start the Thread."}
        </Callout>
      ) : null}
    </section>
  )
}

function ReadyStep({
  setups,
  savedThreads,
  onThreadStarted,
  onBack,
  onFinish,
  finishing,
}: {
  setups: SetupRecord[]
  savedThreads?: OnboardingDraft["threads"]
  onThreadStarted: (
    thread: NonNullable<OnboardingDraft["threads"]>[number]
  ) => void
  onBack: () => void
  onFinish: () => void
  finishing: boolean
}) {
  const participants = useQuery({
    queryKey: ["threads", "participants"],
    queryFn: () => listThreadParticipants(),
    refetchInterval: setups.some((item) => item.mode === "always-on")
      ? 3_000
      : false,
  })
  const alwaysOn = setups.filter((item) => item.mode === "always-on")
  const onDemand = setups.some((item) => item.mode === "on-demand")

  return (
    <>
      <StepHeading
        icon={<Check className="size-5" />}
        title="Your Worktable is ready"
        description={
          setups.length
            ? "Try one useful first step with an agent."
            : "Open Worktable now. You can connect agents from Settings later."
        }
      />
      <div className="mt-7 space-y-6">
        {alwaysOn.map((setup, index) => (
          <AlwaysOnStarter
            key={setup.id}
            setup={setup}
            headingId={`always-on-first-thread-${index}`}
            participants={participants.data?.participants ?? []}
            savedThread={savedThreads?.find(
              (thread) => thread.setupId === setup.id
            )}
            onThreadStarted={onThreadStarted}
          />
        ))}

        {onDemand ? (
          <section className="space-y-3" aria-labelledby="starter-prompts">
            <h2 id="starter-prompts" className="text-sm font-medium">
              Starter prompts
            </h2>
            <div className="space-y-3">
              {STARTER_PROMPTS.map((prompt) => (
                <div key={prompt.label}>
                  <p className="mb-1.5 text-xs font-medium text-foreground/70">
                    {prompt.label}
                  </p>
                  <CopyValue
                    value={prompt.value}
                    label={`Copy ${prompt.label}`}
                    wrap
                  />
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {setups.length ? <SetupList setups={setups} /> : null}
      </div>
      <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button disabled={finishing} onClick={onFinish}>
          {finishing ? "Finishing…" : "Finish setup"}
        </Button>
      </div>
    </>
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
  const [draft, setDraft] = useState(() => readDraft(workspace.id))

  useEffect(() => {
    try {
      localStorage.setItem(draftKey(workspace.id), JSON.stringify(draft))
    } catch {
      // Reload recovery is best-effort; server completion remains authoritative.
    }
  }, [draft, workspace.id])

  const finish = useMutation({
    mutationFn: () => updateWorkspace({ onboarding: { status: "complete" } }),
    onSuccess: (updated) => {
      try {
        localStorage.removeItem(draftKey(workspace.id))
      } catch {
        // The server state is already complete.
      }
      queryClient.setQueryData(["workspace"], updated)
      toast.success("Setup complete")
      void navigate({ to: "/" })
    },
  })

  function setStep(step: OnboardingStep) {
    setDraft((current) => ({ ...current, step }))
  }

  return (
    <div className="min-h-dvh overflow-y-auto bg-background px-4 py-6 text-foreground sm:px-6 sm:py-10">
      <div className="mx-auto w-full max-w-2xl">
        <StepProgress step={draft.step} />
        <main className="mt-8 rounded-2xl border border-border/70 bg-card p-5 shadow-sm sm:mt-10 sm:p-8">
          {draft.step === "identity" ? (
            <IdentityStep
              workspace={workspace}
              onContinue={() => setStep("connect")}
            />
          ) : draft.step === "connect" ? (
            <ConnectStep
              setups={draft.setups}
              onSetupsChange={(setups) =>
                setDraft((current) => ({ ...current, setups }))
              }
              onContinue={() => setStep("ready")}
              onBack={() => setStep("identity")}
            />
          ) : (
            <ReadyStep
              setups={draft.setups}
              savedThreads={draft.threads}
              onThreadStarted={(thread) =>
                setDraft((current) => ({
                  ...current,
                  threads: [
                    ...(current.threads ?? []).filter(
                      (item) => item.setupId !== thread.setupId
                    ),
                    thread,
                  ],
                }))
              }
              onBack={() => setStep("connect")}
              onFinish={() => finish.mutate()}
              finishing={finish.isPending}
            />
          )}
          {finish.isError ? (
            <div className="mt-5">
              <Callout variant="danger">
                {finish.error instanceof Error
                  ? finish.error.message
                  : "Couldn’t finish setup."}
              </Callout>
            </div>
          ) : null}
        </main>
        {versionQuery.data?.sourceUrl ? (
          <div className="mt-4 text-center">
            <SourceCodeLink sourceUrl={versionQuery.data.sourceUrl} />
          </div>
        ) : null}
      </div>
    </div>
  )
}
