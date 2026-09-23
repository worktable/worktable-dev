import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown, Loader2 } from "lucide-react"
import { Badge } from "@worktable/ui/components/badge"
import { Button } from "@worktable/ui/components/button"
import { Callout } from "@worktable/ui/components/callout"
import { Card, CardContent } from "@worktable/ui/components/card"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@worktable/ui/components/collapsible"
import { ConfirmDialog } from "@worktable/ui/components/confirm-dialog"
import { toast } from "@worktable/ui/components/sonner"
import { cn } from "@worktable/ui/lib/utils"
import {
  applyDesktopAgentSkillOperation,
  getDesktopAgentSkillStatuses,
  previewDesktopAgentSkillOperation,
  type DesktopAgentSkillOperation,
  type DesktopAgentSkillPreview,
  type DesktopAgentSkillState,
  type DesktopAgentSkillStatus,
} from "@/lib/desktop-agent-skills"

const STATE_LABELS: Record<DesktopAgentSkillState, string> = {
  "not-installed": "Not installed",
  current: "Installed",
  outdated: "Update available",
  missing: "Files missing",
  "locally-modified": "Changed locally",
  conflict: "Can’t install",
  incomplete: "Needs repair",
}

const OPERATION_LABELS: Record<DesktopAgentSkillOperation, string> = {
  install: "Install",
  update: "Update",
  repair: "Repair",
  remove: "Remove",
}

const OPERATION_PAST_TENSE: Record<DesktopAgentSkillOperation, string> = {
  install: "installed",
  update: "updated",
  repair: "repaired",
  remove: "removed",
}

function stateClass(state: DesktopAgentSkillState): string {
  if (state === "current") return "bg-success/10 text-success"
  if (state === "outdated" || state === "missing" || state === "incomplete") {
    return "bg-warning/10 text-warning"
  }
  if (state === "locally-modified" || state === "conflict") {
    return "bg-destructive/10 text-destructive"
  }
  return "bg-muted text-muted-foreground"
}

function statusSummary(statuses: DesktopAgentSkillStatus[]): string {
  const updates = statuses.filter((status) => status.state === "outdated")
  const needsAttention = statuses.filter((status) =>
    ["missing", "locally-modified", "conflict", "incomplete"].includes(
      status.state
    )
  )
  if (needsAttention.length > 0) {
    return `${needsAttention.length} ${needsAttention.length === 1 ? "needs" : "need"} attention`
  }
  if (updates.length > 0) {
    return `${updates.length} ${updates.length === 1 ? "update" : "updates"} available`
  }
  const installed = statuses.filter((status) => status.state === "current")
  if (installed.length === statuses.length) return "Up to date"
  if (installed.length === 0) return "Not installed"
  return `${installed.length} of ${statuses.length} installed`
}

interface PendingPlan {
  status: DesktopAgentSkillStatus
  operation: DesktopAgentSkillOperation
  preview: DesktopAgentSkillPreview
}

export function DesktopAgentSkillsGroup({ enabled }: { enabled: boolean }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [pendingPlan, setPendingPlan] = useState<PendingPlan | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const statusQuery = useQuery({
    queryKey: ["desktop", "agent-skills"],
    queryFn: getDesktopAgentSkillStatuses,
    enabled,
    retry: false,
    staleTime: 10_000,
  })
  const preview = useMutation({
    mutationFn: async ({
      status,
      operation,
    }: {
      status: DesktopAgentSkillStatus
      operation: DesktopAgentSkillOperation
    }) => ({
      status,
      operation,
      preview: await previewDesktopAgentSkillOperation(
        status.targetId,
        operation
      ),
    }),
    onMutate: () => setActionError(null),
    onSuccess: (plan) => {
      if (!plan.preview.allowed) {
        setActionError(plan.preview.status.detail)
        return
      }
      setPendingPlan(plan)
    },
    onError: (error) => setActionError(error.message),
  })
  const apply = useMutation({
    mutationFn: async (plan: PendingPlan) =>
      applyDesktopAgentSkillOperation(
        plan.status.targetId,
        plan.operation,
        plan.preview.planId
      ),
    onSuccess: async (result, plan) => {
      const label = plan.status.label
      setPendingPlan(null)
      setActionError(null)
      toast.success(
        result.applied
          ? `Worktable skills for ${label} ${OPERATION_PAST_TENSE[plan.operation]}.`
          : `No changes were needed for ${label}.`
      )
      await queryClient.invalidateQueries({
        queryKey: ["desktop", "agent-skills"],
      })
    },
    onError: (error) => {
      setPendingPlan(null)
      setActionError(error.message)
    },
  })

  if (statusQuery.isPending || statusQuery.data === null) return null

  if (statusQuery.isError) {
    return (
      <section
        className="flex flex-col gap-3"
        aria-labelledby="desktop-agent-skills-heading"
      >
        <h3
          id="desktop-agent-skills-heading"
          className="text-sm font-medium text-foreground"
        >
          Local agent skills
        </h3>
        <Callout variant="warning">
          <span className="flex flex-wrap items-center gap-3">
            <span>Couldn&rsquo;t read Desktop agent skill status.</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void statusQuery.refetch()}
            >
              Try again
            </Button>
          </span>
        </Callout>
      </section>
    )
  }

  const statuses = statusQuery.data
  if (!statuses || statuses.length === 0) return null

  const previewingTarget = preview.variables?.status.targetId
  return (
    <section aria-label="Local agent skills">
      <Collapsible open={open} onOpenChange={setOpen}>
        <Card className="gap-0 py-0">
          <CollapsibleTrigger className="flex min-h-14 w-full items-center gap-3 rounded-xl px-4 py-3 text-left transition-colors outline-none hover:bg-muted/30 focus-visible:ring-3 focus-visible:ring-ring/50">
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-foreground">
                Local agent skills
              </span>
              <span className="block text-sm text-muted-foreground">
                {statusSummary(statuses)}
              </span>
            </span>
            <ChevronDown
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform",
                open && "rotate-180"
              )}
              aria-hidden
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="border-t border-border/60 p-0">
              {statuses.map((status, index) => {
                const actions = status.allowedOperations
                const showDetail = ![
                  "not-installed",
                  "current",
                  "outdated",
                ].includes(status.state)
                return (
                  <div
                    key={status.targetId}
                    role="group"
                    aria-label={status.label}
                    className={cn(
                      "flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between",
                      index > 0 && "border-t border-border/60"
                    )}
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-foreground">
                          {status.label}
                        </span>
                        <Badge
                          variant="secondary"
                          className={stateClass(status.state)}
                        >
                          {STATE_LABELS[status.state]}
                        </Badge>
                      </div>
                      {showDetail ? (
                        <p className="mt-1 text-sm text-muted-foreground">
                          {status.detail}
                        </p>
                      ) : null}
                    </div>
                    {actions.length > 0 ? (
                      <div className="flex shrink-0 flex-wrap gap-2">
                        {actions.map((operation) => (
                          <Button
                            key={operation}
                            variant={
                              operation === "remove" ? "outline" : "default"
                            }
                            size="sm"
                            disabled={preview.isPending || apply.isPending}
                            aria-label={`${OPERATION_LABELS[operation]} Worktable skills for ${status.label}`}
                            onClick={() =>
                              preview.mutate({ status, operation })
                            }
                          >
                            {preview.isPending &&
                            previewingTarget === status.targetId ? (
                              <Loader2 className="size-4 animate-spin" />
                            ) : null}
                            {OPERATION_LABELS[operation]}
                          </Button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>
      {actionError ? (
        <Callout variant="warning" className="mt-3">
          {actionError}
        </Callout>
      ) : null}
      <ConfirmDialog
        open={pendingPlan !== null}
        onOpenChange={(open) => {
          if (!open && !apply.isPending) setPendingPlan(null)
        }}
        variant={
          pendingPlan?.operation === "remove" ? "destructive" : "default"
        }
        title={
          pendingPlan
            ? `${OPERATION_LABELS[pendingPlan.operation]} Worktable skills for ${pendingPlan.status.label}?`
            : "Review agent skill change"
        }
        description="Review the files Worktable will change. Your agent connections won’t be affected."
        confirmLabel={
          pendingPlan
            ? `${OPERATION_LABELS[pendingPlan.operation]} skills`
            : "Apply"
        }
        loading={apply.isPending}
        loadingLabel="Applying…"
        onConfirm={() => {
          if (pendingPlan) apply.mutate(pendingPlan)
        }}
      >
        {pendingPlan ? (
          <div className="flex flex-col gap-3 text-sm">
            {pendingPlan.preview.status.targetRoot ? (
              <p className="font-mono text-xs break-all text-muted-foreground">
                {pendingPlan.preview.status.targetRoot}
              </p>
            ) : null}
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              {pendingPlan.preview.changes.map((change) => (
                <li key={change}>{change}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </ConfirmDialog>
    </section>
  )
}
