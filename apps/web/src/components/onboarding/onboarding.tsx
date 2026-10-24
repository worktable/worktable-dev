import { useEffect, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { Button } from "@worktable/ui/components/button"
import { Callout } from "@worktable/ui/components/callout"
import { Input } from "@worktable/ui/components/input"
import type { WorkspaceInfo } from "@/lib/api"
import { updateWorkspace } from "@/lib/api"
import { getCurrentUser, getUserProfile, updateUserProfile } from "@/lib/profile"
import { queryKeys, useSpaces } from "@/lib/queries"
import {
  gettingStartedSpace,
  noteSetupChanged,
  usePersonalSetup,
} from "@/lib/setup"
import { activateTeams } from "@/lib/team-api"
import { CLOUD_PLANS } from "@worktable/hosted-contract/plans"
import { PlanFullNotice } from "@/components/billing/plan-full-notice"
import { roomFor, useCloudPlan } from "@/lib/cloud-plan"
import { ConnectAgentStep } from "./connect-agent"
import { EmailChips, InviteResult } from "./invite-people"
import {
  EMAIL,
  invitePeople,
  mergeInvited,
  type Invited,
} from "@/lib/invite-people"
import { StepHeading } from "./onboarding-shared"
import { isSetupRecord, type SetupRecord } from "@/lib/onboarding-setups"

type Step = "create" | "connect" | "invite"

interface SetupDraft {
  step: Step
  setups: SetupRecord[]
  invited?: Invited[]
  /** Addresses typed before leaving to pay for a plan, sent on return. */
  pendingEmails?: string[]
}

const STEPS: Step[] = ["create", "connect", "invite"]
const DEFAULT_DRAFT: SetupDraft = { step: "create", setups: [] }

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
    if (!Array.isArray(value.setups) || !value.setups.every(isSetupRecord)) {
      return DEFAULT_DRAFT
    }
    return {
      step: isStep(value.step) ? value.step : "create",
      setups: value.setups,
      ...(Array.isArray(value.invited) ? { invited: value.invited } : {}),
      ...(Array.isArray(value.pendingEmails) &&
      value.pendingEmails.every((item) => typeof item === "string")
        ? { pendingEmails: value.pendingEmails }
        : {}),
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

function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null
  return (
    <Callout variant="danger" className="mt-5">
      {error instanceof Error ? error.message : "Something went wrong. Try again."}
    </Callout>
  )
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

function CreateStep({
  workspace,
  needsEmail,
  onCreated,
}: {
  workspace: WorkspaceInfo
  /** The owner signs in with a password and gets their account here. */
  needsEmail: boolean
  onCreated: (reload: boolean) => void
}) {
  const queryClient = useQueryClient()
  const profile = useQuery({ queryKey: ["profile"], queryFn: getUserProfile })
  const [typedName, setTypedName] = useState<string | null>(null)
  const [email, setEmail] = useState("")
  const [worktableName, setWorktableName] = useState(() =>
    initialWorktableName(workspace)
  )
  const name =
    typedName ?? usefulName(profile.data?.name ?? getCurrentUser().name)

  const save = useMutation({
    mutationFn: async () => {
      const updated = await updateWorkspace({ name: worktableName.trim() })
      queryClient.setQueryData(queryKeys.workspace, updated)
      await updateUserProfile(name.trim())
      // Their account keeps the password they already set.
      if (needsEmail)
        await activateTeams({ name: name.trim(), email: email.trim() })
    },
    onSuccess: () => onCreated(needsEmail),
  })

  const ready =
    name.trim() &&
    worktableName.trim() &&
    (!needsEmail || EMAIL.test(email.trim()))

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (ready) save.mutate()
      }}
    >
      <StepHeading
        title="Create your Worktable"
        description="You can change these in Settings."
      />
      <div className="mt-7 space-y-5">
        <Field id="setup-name" label="Your name">
          <Input
            id="setup-name"
            value={name}
            maxLength={100}
            autoComplete="name"
            autoFocus
            onChange={(event) => setTypedName(event.target.value)}
          />
        </Field>
        {needsEmail ? (
          <Field
            id="setup-email"
            label="Your email"
            hint="You'll sign in with this email and the password you just set."
          >
            <Input
              id="setup-email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
        ) : null}
        <Field id="setup-worktable" label="Worktable name">
          <Input
            id="setup-worktable"
            value={worktableName}
            maxLength={200}
            placeholder="Northwind"
            onChange={(event) => setWorktableName(event.target.value)}
          />
        </Field>
      </div>
      <ErrorNote error={save.error} />
      <div className="mt-8 flex justify-end">
        <Button type="submit" disabled={!ready || save.isPending}>
          {save.isPending ? "Creating…" : "Create Worktable"}
        </Button>
      </div>
    </form>
  )
}

function InviteStep({
  cloud,
  worktableName,
  invited,
  pendingEmails,
  onInvited,
  onKeepEmails,
  onFinish,
  finishing,
  onBack,
}: {
  cloud: boolean
  worktableName: string
  invited: Invited[] | undefined
  pendingEmails: string[] | undefined
  onInvited: (invited: Invited[]) => void
  onKeepEmails: (emails: string[] | undefined) => void
  onFinish: () => void
  finishing: boolean
  onBack: () => void
}) {
  const queryClient = useQueryClient()
  const { plan } = useCloudPlan()
  const [emails, setEmails] = useState<string[]>(pendingEmails ?? [])
  const [paidJustNow, setPaidJustNow] = useState<number | null>(null)
  const send = useMutation({
    mutationFn: (addresses: string[]) => invitePeople(addresses),
    onSuccess: (results) => {
      // What couldn't be invited stays typed, to try again.
      setEmails(results.flatMap((result) => (result.error ? [result.email] : [])))
      onKeepEmails(undefined)
      onInvited(mergeInvited(invited, results))
      // The people count moved; the plan's room is read again.
      noteSetupChanged(queryClient)
    },
  })
  const fits = roomFor(plan, emails.length)
  // Back from paying for a plan: send what was typed before leaving.
  const resumed = useRef(false)
  useEffect(() => {
    if (resumed.current || !pendingEmails?.length || !plan) return
    if (plan.plan === "solo" || !roomFor(plan, pendingEmails.length)) return
    resumed.current = true
    send.mutate(pendingEmails, {
      onSuccess: (results) =>
        setPaidJustNow(results.filter((result) => !result.error).length),
    })
  }, [pendingEmails, plan, send])
  const action = cloud ? "Send invites" : "Create links"
  // Enter and the button both send, once at a time.
  const submit = () => {
    if (emails.length && fits && !send.isPending) send.mutate(emails)
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <StepHeading
        title="Invite your team"
        description={
          cloud
            ? `Each person gets an email with a link to join ${worktableName}.`
            : "You'll get a link for each person to send them."
        }
      />
      {paidJustNow !== null && plan && !send.isPending ? (
        <p className="mt-6 text-sm text-foreground" role="status">
          {CLOUD_PLANS[plan.plan].name} plan active.
          {paidJustNow === 0
            ? null
            : paidJustNow === 1
              ? " 1 invitation sent."
              : ` ${paidJustNow} invitations sent.`}
        </p>
      ) : null}
      {invited?.length ? (
        <ul className="mt-7 card-surface divide-y divide-border rounded-xl">
          {invited.map((item) => (
            <InviteResult
              key={item.email}
              invited={item}
              onChange={(next) => onInvited(mergeInvited(invited, [next]))}
            />
          ))}
        </ul>
      ) : null}
      <div className="mt-7">
        <Field
          id="invite-emails"
          label="Email addresses"
          hint="Separate addresses with a comma or press Enter."
        >
          <EmailChips
            emails={emails}
            onChange={setEmails}
            onSubmit={submit}
            autoFocus
          />
        </Field>
        {plan && !fits ? (
          <div className="mt-3">
            <PlanFullNotice
              plan={plan}
              worktableName={worktableName}
              adding={emails.length}
              onBeforeCheckout={() => onKeepEmails(emails)}
            />
          </div>
        ) : null}
      </div>
      <ErrorNote error={send.error} />
      <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
        <Button type="button" variant="ghost" onClick={onBack}>
          Back
        </Button>
        <div className="flex items-center gap-2">
          {invited?.length ? (
            <>
              {emails.length ? (
                <Button
                  type="submit"
                  variant="outline"
                  disabled={send.isPending || !fits}
                >
                  {action}
                </Button>
              ) : null}
              <Button type="button" disabled={finishing} onClick={onFinish}>
                {finishing ? "Opening…" : "Done"}
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="ghost"
                disabled={finishing}
                onClick={onFinish}
              >
                It's just me for now
              </Button>
              <Button
                type="submit"
                disabled={!emails.length || !fits || send.isPending}
              >
                {send.isPending ? "Inviting…" : action}
              </Button>
            </>
          )}
        </div>
      </div>
    </form>
  )
}

export function Onboarding({ workspace }: { workspace: WorkspaceInfo }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { person } = usePersonalSetup()
  const { data: spaces } = useSpaces()
  const [draft, setDraft] = useState(() => readDraft(workspace.id))

  useEffect(() => writeDraft(workspace.id, draft), [draft, workspace.id])

  // Cloud names the Worktable before it opens. Inviting needs accounts:
  // Cloud and Teams have them, and a Worktable behind a password gets them
  // when it is created. One used only on this computer skips inviting.
  const cloud = person?.signOut === "cloud"
  const steps = STEPS.filter(
    (step) =>
      (step !== "create" || !cloud) &&
      (step !== "invite" || person?.signOut != null)
  )
  const step = steps.includes(draft.step) ? draft.step : steps[0]!

  const finish = useMutation({
    mutationFn: () => updateWorkspace({ onboarding: { status: "complete" } }),
    onSuccess: (updated) => {
      try {
        localStorage.removeItem(draftKey(workspace.id))
      } catch {
        // The server state is already complete.
      }
      queryClient.setQueryData(queryKeys.workspace, {
        ...updated,
        person: queryClient.getQueryData<WorkspaceInfo>(queryKeys.workspace)
          ?.person,
        setup: queryClient.getQueryData<WorkspaceInfo>(queryKeys.workspace)
          ?.setup,
      })
      // Setup has no socket; read the progress it made, such as the agent
      // that connected, once.
      noteSetupChanged(queryClient)
      const start = gettingStartedSpace(spaces)
      void (start
        ? navigate({ to: "/spaces/$spaceId", params: { spaceId: start.id } })
        : navigate({ to: "/" }))
    },
  })

  function go(next: Step) {
    setDraft((current) => ({ ...current, step: next }))
  }
  function after(current: Step): Step | null {
    return steps[steps.indexOf(current) + 1] ?? null
  }
  function back(current: Step): (() => void) | undefined {
    const previous = steps[steps.indexOf(current) - 1]
    return previous ? () => go(previous) : undefined
  }

  const position = Math.max(0, steps.indexOf(step))

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
          style={{ width: `${((position + 1) / steps.length) * 100}%` }}
        />
      </div>
      {/* One width for every step, so the column doesn't shift between them. */}
      <main className="mx-auto w-full max-w-xl px-5 pt-[12vh] pb-16">
        {step === "create" ? (
          <CreateStep
            workspace={workspace}
            needsEmail={person?.signOut === "password"}
            onCreated={(reload) => {
              const next = { ...draft, step: after("create") ?? "create" }
              if (reload) {
                // Their new account is who is signed in now.
                writeDraft(workspace.id, next)
                window.location.reload()
                return
              }
              setDraft(next)
            }}
          />
        ) : step === "connect" ? (
          <ConnectAgentStep
            setups={draft.setups}
            onSetupsChange={(setups) =>
              setDraft((current) => ({ ...current, setups }))
            }
            onContinue={() => {
              const next = after("connect")
              if (next) go(next)
              else finish.mutate()
            }}
            onBack={back("connect")}
          />
        ) : (
          <InviteStep
            cloud={cloud}
            worktableName={workspace.name}
            invited={draft.invited}
            pendingEmails={draft.pendingEmails}
            onInvited={(invited) =>
              setDraft((current) => ({ ...current, invited }))
            }
            onKeepEmails={(pendingEmails) => {
              const next = { ...draft, pendingEmails }
              // Written now: paying leaves the page before effects run.
              writeDraft(workspace.id, next)
              setDraft(next)
            }}
            onFinish={() => finish.mutate()}
            finishing={finish.isPending}
            onBack={() => go("connect")}
          />
        )}
        <ErrorNote error={finish.error} />
      </main>
    </div>
  )
}
