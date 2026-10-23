import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { GrokBotEmailAddress } from "@worktable/hosted-contract"
import { Check, ChevronRight } from "lucide-react"
import {
  GROK_BOT_SHORTCUT_MESSAGE,
  grokBotRoutineInstructions,
  isGrokBotShortcut,
  type GrokBotCandidate,
  type GrokBotConnection,
} from "@worktable/types"
import { Button, buttonVariants } from "@worktable/ui/components/button"
import { Badge } from "@worktable/ui/components/badge"
import { Callout } from "@worktable/ui/components/callout"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@worktable/ui/components/collapsible"
import { CopyField } from "@worktable/ui/components/copy-field"
import { ConfirmDialog } from "@worktable/ui/components/confirm-dialog"
import { ResponsiveDialogClose } from "@worktable/ui/components/responsive-dialog"
import { Input } from "@worktable/ui/components/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@worktable/ui/components/select"
import { toast } from "@worktable/ui/components/sonner"
import { useCopy } from "@worktable/ui/hooks/use-copy"
import { cn } from "@worktable/ui/lib/utils"
import { listAgentConnections } from "@/lib/agent-connections-api"
import { fetchJSON } from "@/lib/http"
import type { ConnectionInfo } from "@/lib/system-api"
import { useIsMobile } from "@/hooks/use-mobile"

const WorktableLinkSetup = lazy(() =>
  import("../settings/sections/cloud").then((module) => ({
    default: module.CloudSection,
  }))
)
const STATUS: Record<GrokBotConnection["status"], string> = {
  configured: "Needs a connection check",
  checking: "Checking…",
  ready: "Connected",
  working: "Working",
  paused: "Paused",
  "needs-attention": "Needs attention",
}

function SetupStep({
  number,
  title,
  complete,
  open,
  disabled,
  onOpenChange,
  children,
}: {
  number: number
  title: string
  complete?: boolean
  open: boolean
  disabled?: boolean
  onOpenChange: (open: boolean) => void
  children?: ReactNode
}) {
  return (
    <li>
      <Collapsible open={open && !disabled} onOpenChange={onOpenChange}>
        <CollapsibleTrigger
          disabled={disabled}
          className="flex min-h-11 w-full items-center gap-3 text-left text-sm font-medium disabled:cursor-default disabled:text-muted-foreground"
        >
          <span
            className={cn(
              "grid size-6 shrink-0 place-items-center rounded-full bg-surface-tint text-xs",
              complete && "bg-success/10 text-success"
            )}
          >
            {complete ? <Check className="size-3.5" aria-hidden /> : number}
          </span>
          <span className="flex-1">{title}</span>
          <ChevronRight
            aria-hidden
            className={cn(
              "size-4 text-muted-foreground transition-transform motion-reduce:transition-none",
              open && !disabled && "rotate-90"
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent keepMounted>
          <div className="flex min-w-0 flex-col gap-3 pt-2 pb-4 pl-9">
            {children}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}

export function GrokBotSetupPanel({
  connection,
  open,
  onConnected,
}: {
  connection: ConnectionInfo
  open: boolean
  onConnected?: (candidate: GrokBotCandidate, saved: GrokBotConnection) => void
}) {
  const client = useQueryClient()
  const cloud = connection.mcpAuthMode === "oauth"
  const queryKey = ["agent-connections", cloud] as const
  const inventory = useQuery({
    queryKey,
    queryFn: () => listAgentConnections({ workspaceAgentsOnCloud: cloud }),
    enabled: open,
  })
  const [selected, setSelected] = useState("")
  const [step, setStep] = useState<number | null>(null)
  const [linkSetup, setLinkSetup] = useState(false)
  const candidates = inventory.data?.grokBotCandidates ?? []
  const candidate =
    candidates.find((item) => item.id === selected) ?? candidates[0]
  const saved = inventory.data?.grokBots?.find(
    (item) => item.connectionId === candidate?.id
  )
  const mcpUrl = cloud ? connection.remoteMcpUrl : inventory.data?.grokBotMcpUrl
  const current = step ?? (!mcpUrl ? 1 : candidate ? (saved ? 4 : 3) : 1)
  const changed = async () => {
    await client.invalidateQueries({ queryKey, exact: true })
    setStep(null)
  }
  const reported = useRef<string | null>(null)
  useEffect(() => {
    if (
      !candidate ||
      !saved?.verifiedAt ||
      !["ready", "working"].includes(saved.status)
    )
      return
    const key = `${candidate.id}:${saved.verifiedAt}`
    if (reported.current === key) return
    reported.current = key
    onConnected?.(candidate, saved)
  }, [candidate, saved, onConnected])
  const refresh = async () => {
    const result = await inventory.refetch()
    if (result.data?.grokBotCandidates?.length) setStep(null)
  }
  if (inventory.isPending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Checking connections…
      </p>
    )
  if (inventory.isError)
    return (
      <Callout variant="danger">
        Could not load connections.{" "}
        <Button variant="link" onClick={() => void refresh()}>
          Try again
        </Button>
      </Callout>
    )
  const signIn =
    candidates.length > 1 ? (
      <Select
        value={candidate?.id ?? ""}
        onValueChange={(value) => {
          setSelected(value ?? "")
          setStep(null)
        }}
      >
        <SelectTrigger aria-label="Grok Bot sign-in">
          <SelectValue>{candidate?.displayName}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {candidates.map((item) => (
            <SelectItem key={item.id} value={item.id}>
              {item.displayName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ) : null
  const routine =
    candidate && (mcpUrl || saved?.verifiedAt) ? (
      <GrokBotRoutine
        key={candidate.id}
        candidate={candidate}
        saved={saved}
        mcpUrl={mcpUrl ?? ""}
        current={current}
        onStep={setStep}
        onChanged={changed}
        onboarding={Boolean(onConnected)}
      />
    ) : null
  return (
    <div className="flex flex-col gap-4">
      {signIn}
      {saved?.verifiedAt ? (
        routine
      ) : (
        <ol className="space-y-1">
          <SetupStep
            number={1}
            title="Connect Worktable"
            complete={Boolean(candidate) || current > 1}
            open={current === 1}
            onOpenChange={() => setStep(current === 1 ? 0 : 1)}
          >
            {mcpUrl ? (
              <>
                <p className="text-sm text-muted-foreground">
                  Send this in Grok Bot, then authorize Worktable.
                </p>
                <CopyField
                  label="Message to Grok Bot"
                  value={`Add this MCP server: ${mcpUrl}`}
                />
                <div>
                  <Button onClick={() => setStep(2)}>Continue</Button>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  Connect Worktable Link so Grok Bot can reach this Worktable.
                </p>
                {linkSetup ? (
                  <>
                    <Suspense
                      fallback={
                        <p
                          role="status"
                          className="text-sm text-muted-foreground"
                        >
                          Loading Worktable Link…
                        </p>
                      }
                    >
                      <WorktableLinkSetup active={open} />
                    </Suspense>
                    <div>
                      <Button
                        onClick={async () => {
                          const result = await inventory.refetch()
                          if (result.data?.grokBotMcpUrl) setLinkSetup(false)
                          else
                            toast.error(
                              "Finish connecting Worktable Link first."
                            )
                        }}
                      >
                        Continue setup
                      </Button>
                    </div>
                  </>
                ) : (
                  <div>
                    <Button onClick={() => setLinkSetup(true)}>
                      Set up Worktable Link
                    </Button>
                  </div>
                )}
              </>
            )}
          </SetupStep>
          <SetupStep
            number={2}
            title="Check your inbox"
            complete={Boolean(candidate)}
            open={current === 2}
            disabled={!mcpUrl}
            onOpenChange={() => setStep(current === 2 ? 0 : 2)}
          >
            <p className="text-sm text-muted-foreground">
              Send this to Grok Bot, then refresh here.
            </p>
            <CopyField
              label="Message to Grok Bot"
              value="Check your Worktable inbox once. If there is no assignment, stop."
            />
            <div>
              <Button
                variant="outline"
                disabled={inventory.isFetching}
                onClick={() => void refresh()}
              >
                {inventory.isFetching ? "Refreshing…" : "Refresh connections"}
              </Button>
            </div>
          </SetupStep>
          {routine ?? (
            <>
              <SetupStep
                number={3}
                title="Create a routine"
                open={false}
                disabled
                onOpenChange={() => {}}
              />
              <SetupStep
                number={4}
                title="Check the connection"
                open={false}
                disabled
                onOpenChange={() => {}}
              />
            </>
          )}
        </ol>
      )}
    </div>
  )
}

function GrokBotRoutine({
  candidate,
  saved,
  mcpUrl,
  current,
  onStep,
  onChanged,
  onboarding,
}: {
  candidate: GrokBotCandidate
  saved?: GrokBotConnection
  mcpUrl: string
  current: number
  onStep: (step: number | null) => void
  onChanged: () => Promise<void>
  onboarding: boolean
}) {
  const id = useId()
  const navigate = useNavigate()
  const mobile = useIsMobile()
  const [method, setMethod] = useState<"webhook" | "email">(
    () => saved?.wakeMethod ?? (mobile ? "email" : "webhook")
  )
  const [email, setEmail] = useState(saved?.emailAddress ?? "")
  const [url, setUrl] = useState("")
  const [key, setKey] = useState("")
  const urlIsShortcut = isGrokBotShortcut(url)
  const keyIsShortcut = isGrokBotShortcut(key)
  const hasShortcut = method === "webhook" && (urlIsShortcut || keyIsShortcut)
  const [minutes, setMinutes] = useState(String(saved?.executionMinutes ?? 30))
  const [confirmRetry, setConfirmRetry] = useState(false)
  const copy = useCopy(() => toast.success("Copied"))
  const base = `/api/grok-bot/${encodeURIComponent(candidate.id)}`
  const needsCheck =
    !saved ||
    method !== (saved.wakeMethod ?? "webhook") ||
    (method === "email"
      ? email.trim().toLowerCase() !== saved.emailAddress
      : Boolean(url || key))
  const save = async (
    enabled = saved?.enabled ?? true,
    includeDraft = true
  ) => {
    if (includeDraft && hasShortcut) throw new Error(GROK_BOT_SHORTCUT_MESSAGE)
    await fetchJSON(`${base}/configuration?scope=workspace`, {
      method: "PUT",
      body: JSON.stringify({
        ...(includeDraft ? { wakeMethod: method } : {}),
        ...(includeDraft && method === "email"
          ? { emailAddress: email.trim() }
          : {}),
        ...(includeDraft && method === "webhook" && url.trim()
          ? { webhookUrl: url.trim() }
          : {}),
        ...(includeDraft && method === "webhook" && key.trim()
          ? { webhookKey: key.trim() }
          : {}),
        enabled,
        executionMinutes: includeDraft
          ? Number(minutes)
          : saved?.executionMinutes,
      }),
    })
    if (includeDraft) {
      setUrl("")
      setKey("")
    }
  }
  const action = useMutation({
    mutationFn: async (
      kind: "save" | "check" | "retry" | "remove" | "pause"
    ) => {
      try {
        if (kind === "save") await save()
        else if (kind === "pause") await save(!saved?.enabled, false)
        else if (kind === "check") {
          // Saving may succeed even when the check fails; always reload durable state.
          if (
            !saved ||
            needsCheck ||
            Number(minutes) !== saved.executionMinutes ||
            !saved.enabled
          )
            await save(true)
          await fetchJSON(`${base}/check?scope=workspace`, { method: "POST" })
        } else
          await fetchJSON(
            `${base}/${kind === "remove" ? "configuration" : "retry"}?scope=workspace`,
            { method: kind === "remove" ? "DELETE" : "POST" }
          )
        if (kind === "remove") {
          setUrl("")
          setKey("")
          setEmail("")
        }
        setConfirmRetry(false)
      } finally {
        await onChanged()
      }
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : "Could not update Grok Bot"
      ),
  })
  const methodSelector = (
    <div className="space-y-2">
      <label id={`${id}-method-label`} className="text-sm font-medium">
        Notify Grok using
      </label>
      <Select
        value={method}
        onValueChange={(value) => {
          if (value === "email" || value === "webhook") setMethod(value)
        }}
        disabled={action.isPending}
      >
        <SelectTrigger aria-labelledby={`${id}-method-label`}>
          <SelectValue>{method === "email" ? "Email" : "Webhook"}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="email">
            Email{mobile ? " · Recommended" : ""}
          </SelectItem>
          <SelectItem value="webhook">
            Webhook{!mobile ? " · Recommended" : ""}
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
  const instructions = (
    <>
      <p className="text-sm text-muted-foreground">
        {!mcpUrl ? "Worktable Link must be online to copy routine instructions." : method === "email"
          ? "Send these instructions to Grok, then paste its Bot email address below."
          : "Send these instructions to Grok, then copy the POST URL and key from its desktop app."}
      </p>
      <div>
        <Button
          variant="outline"
          disabled={!mcpUrl || (method === "email" && !candidate.emailSender)}
          onClick={() =>
            void copy.copy(
              grokBotRoutineInstructions(
                mcpUrl,
                method === "email" ? candidate.emailSender : undefined
              )
            )
          }
        >
          {copy.copied ? "Copied" : "Copy instructions"}
        </Button>
      </div>
    </>
  )
  const fields =
    method === "email" ? (
      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor={`${id}-email`}>
          Bot email address
        </label>
        <Input
          id={`${id}-email`}
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@mail.grokbot.com"
          autoComplete="off"
          required
          disabled={action.isPending}
        />
      </div>
    ) : (
      <>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor={`${id}-url`}>
            Webhook URL
          </label>
          <Input
            id={`${id}-url`}
            type="url"
            value={url}
            aria-invalid={urlIsShortcut || undefined}
            aria-describedby={
              urlIsShortcut ? `${id}-shortcut-error` : undefined
            }
            onChange={(event) => setUrl(event.target.value)}
            autoComplete="off"
            placeholder={
              saved?.wakeMethod !== "email" && saved
                ? "Saved · paste a URL to replace"
                : "https://…"
            }
            required={!saved || saved.wakeMethod === "email"}
            disabled={action.isPending}
          />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor={`${id}-key`}>
            Webhook key
          </label>
          <Input
            id={`${id}-key`}
            type="password"
            value={key}
            aria-invalid={keyIsShortcut || undefined}
            aria-describedby={
              keyIsShortcut ? `${id}-shortcut-error` : undefined
            }
            onChange={(event) => setKey(event.target.value)}
            autoComplete="new-password"
            placeholder={
              saved?.wakeMethod !== "email" && saved
                ? "Saved · paste a key to replace"
                : "Paste the key"
            }
            required={!saved || saved.wakeMethod === "email"}
            disabled={action.isPending}
          />
        </div>
      </>
    )
  const shortcutError = hasShortcut ? (
    <p
      id={`${id}-shortcut-error`}
      role="alert"
      className="text-sm text-destructive"
    >
      {GROK_BOT_SHORTCUT_MESSAGE}
    </p>
  ) : null
  const timeout = (
    <div className="space-y-2">
      <label className="text-sm font-medium" htmlFor={`${id}-timeout`}>
        Run timeout (minutes)
      </label>
      <Input
        id={`${id}-timeout`}
        className="w-28"
        type="number"
        min={1}
        max={120}
        required
        value={minutes}
        onChange={(event) => setMinutes(event.target.value)}
        disabled={action.isPending}
      />
    </div>
  )
  const attention =
    saved?.status === "needs-attention" ? (
      <Callout
        variant="warning"
        title={
          saved.uncertain ? "No reply received" : "Connection needs attention"
        }
      >
        {saved.uncertain
          ? "Check the run in Grok before retrying."
          : (saved.error ??
            "Check the routine and its connection, then retry.")}
      </Callout>
    ) : null
  const retry =
    saved?.status === "needs-attention" ? (
      <Button
        variant="outline"
        disabled={action.isPending}
        onClick={() =>
          saved.uncertain ? setConfirmRetry(true) : action.mutate("retry")
        }
      >
        Retry
      </Button>
    ) : null
  const confirmation = (
    <ConfirmDialog
      open={confirmRetry}
      onOpenChange={setConfirmRetry}
      title="Retry this assignment?"
      description="The previous run may have completed. Retrying could repeat its work."
      confirmLabel="Retry assignment"
      loading={action.isPending}
      onConfirm={() => action.mutateAsync("retry")}
    />
  )
  const valid = Boolean(
    !hasShortcut &&
    (method === "email"
      ? candidate.emailSender && GrokBotEmailAddress.safeParse(email).success
      : (saved && saved.wakeMethod !== "email") ||
        (url.trim() && key.trim())) &&
    Number.isInteger(Number(minutes)) &&
    Number(minutes) >= 1 &&
    Number(minutes) <= 120
  )
  if (saved?.verifiedAt)
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">{candidate.displayName}</span>
          <Badge variant="secondary">{STATUS[saved.status]}</Badge>
        </div>
        {attention}
        {!onboarding && (
          <div className="flex flex-wrap gap-2">
            {retry ?? (
              <ResponsiveDialogClose
                className={buttonVariants()}
                onClick={() =>
                  void navigate({
                    to: "/threads/$",
                    params: { _splat: "" },
                    search: { location: "all" },
                  })
                }
              >
                Open Threads
              </ResponsiveDialogClose>
            )}
            <Button
              variant="outline"
              disabled={action.isPending}
              onClick={() => action.mutate("pause")}
            >
              {saved.enabled ? "Pause" : "Resume"}
            </Button>
          </div>
        )}
        {onboarding && retry}
        <details className="group text-sm">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            Connection settings
          </summary>
          <form
            className="mt-4 flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              action.mutate(needsCheck ? "check" : "save")
            }}
          >
            {methodSelector}
            {needsCheck && instructions}
            {fields}
            {shortcutError}
            {timeout}
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                variant="outline"
                disabled={action.isPending || !valid}
              >
                {needsCheck ? "Save and check" : "Save changes"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={action.isPending}
                onClick={() => action.mutate("remove")}
              >
                Remove routine
              </Button>
            </div>
          </form>
        </details>
        {confirmation}
      </div>
    )
  return (
    <>
      <SetupStep
        number={3}
        title="Create a routine"
        complete={Boolean(saved) || current === 4}
        open={current === 3}
        onOpenChange={() => onStep(current === 3 ? 0 : 3)}
      >
        {methodSelector}
        {instructions}
        {fields}
        {shortcutError}
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            Advanced
          </summary>
          <div className="mt-3">{timeout}</div>
        </details>
        <div>
          <Button
            disabled={!valid || action.isPending}
            onClick={() => onStep(4)}
          >
            Continue
          </Button>
        </div>
      </SetupStep>
      <SetupStep
        number={4}
        title="Check the connection"
        open={current === 4}
        disabled={!valid}
        onOpenChange={() => onStep(current === 4 ? 0 : 4)}
      >
        {attention}
        {saved?.probe ? (
          <>
            {(saved.status === "checking" || saved.status === "working") && (
              <p role="status" className="text-sm text-muted-foreground">
                Waiting for Grok Bot to reply…
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={action.isPending}
                onClick={() => void onChanged()}
              >
                Refresh status
              </Button>
              {retry}
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Send a test message to Grok Bot.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={action.isPending}
                onClick={() => action.mutate("check")}
              >
                {action.isPending
                  ? "Checking…"
                  : saved
                    ? "Check connection"
                    : "Save and check"}
              </Button>
              {retry}
            </div>
          </>
        )}
      </SetupStep>
      {confirmation}
    </>
  )
}
