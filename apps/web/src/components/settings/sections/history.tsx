import { useState } from "react"
import { Button } from "@worktable/ui/components/button"
import { Callout } from "@worktable/ui/components/callout"
import { ConfirmDialog } from "@worktable/ui/components/confirm-dialog"
import { SettingRow } from "@worktable/ui/components/setting-row"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@worktable/ui/components/select"
import type { RetentionNotice, RetentionPolicy } from "@/lib/system-api"
import { useServerSettings } from "@/hooks/use-server-settings"
import { useSettingsPatch } from "../use-settings-patch"

// The fixed set of policies the picker offers, longest first. History is
// bounded: keeping everything is not offered, and the server rejects more than
// 180 days or 7 per doc. Custom values (a hand-edited settings.json) still
// render a reasonable label but won't match a check mark.
const OPTIONS: { value: string; label: string; policy: RetentionPolicy }[] = [
  {
    value: "age-180",
    label: "Keep 180 days",
    policy: { mode: "age", maxAgeDays: 180 },
  },
  {
    value: "age-90",
    label: "Keep 90 days",
    policy: { mode: "age", maxAgeDays: 90 },
  },
  {
    value: "age-30",
    label: "Keep 30 days",
    policy: { mode: "age", maxAgeDays: 30 },
  },
  {
    value: "count-7",
    label: "Keep last 7 per doc",
    policy: { mode: "count", maxPerDoc: 7 },
  },
]

// What a settings read shows before it loads; the server always reports a
// bounded policy.
const LONGEST: RetentionPolicy = { mode: "age", maxAgeDays: 180 }

function policyToValue(p: RetentionPolicy): string {
  if (p.mode === "all") return "all"
  if (p.mode === "age") return `age-${p.maxAgeDays}`
  return `count-${p.maxPerDoc}`
}

function valueToPolicy(value: string): RetentionPolicy {
  return OPTIONS.find((o) => o.value === value)?.policy ?? LONGEST
}

function policyLabel(p: RetentionPolicy): string {
  const known = OPTIONS.find((o) => o.value === policyToValue(p))
  if (known) return known.label
  if (p.mode === "age") return `Keep ${p.maxAgeDays} days`
  if (p.mode === "count") return `Keep last ${p.maxPerDoc} per doc`
  return "Keep everything"
}

function keptAmount(p: RetentionPolicy): string {
  if (p.mode === "all") return "everything"
  if (p.mode === "age") return `${p.maxAgeDays} days`
  return `the last ${p.maxPerDoc} per doc`
}

/** Why the policy moved: the server retired the previous one. */
function noticeText(notice: RetentionNotice, current: RetentionPolicy): string {
  return `Version history now keeps ${keptAmount(current)}. Keeping ${keptAmount(
    notice.previous
  )} is no longer available.`
}

/**
 * True when moving from `current` to `next` can delete existing versions:
 * tightening the same mode (fewer days / lower count), or switching between
 * age and count (not directly comparable, so treat as potentially
 * destructive). Relaxing never confirms.
 */
function needsConfirm(
  next: RetentionPolicy,
  current: RetentionPolicy
): boolean {
  if (current.mode === "all") return next.mode !== "all"
  if (next.mode !== current.mode) return true
  if (next.mode === "age" && current.mode === "age") {
    return next.maxAgeDays < current.maxAgeDays
  }
  if (next.mode === "count" && current.mode === "count") {
    return next.maxPerDoc < current.maxPerDoc
  }
  return true
}

// The History section: doc version-history retention. Server-backed via
// GET/PUT /api/system/settings (same store as Editor/System). Tightening the
// policy deletes older versions immediately (the server sweeps on the PUT), so
// a destructive change is gated behind a confirm; relaxing applies directly.
export function HistorySection() {
  const settingsQuery = useServerSettings()
  const patch = useSettingsPatch()
  const settings = settingsQuery.data

  const currentPolicy = settings?.history.retention ?? LONGEST
  const notice = settings?.history.retentionNotice ?? null
  const currentValue = policyToValue(currentPolicy)
  // The pending destructive choice awaiting confirmation. Until confirmed the
  // Select stays bound to `currentValue`, so Cancel simply leaves it as-is.
  const [pending, setPending] = useState<RetentionPolicy | null>(null)

  const pending_ = !settings || patch.isPending

  function handleChange(value: string | null) {
    if (value === null || value === currentValue) return
    const nextPolicy = valueToPolicy(value)
    if (needsConfirm(nextPolicy, currentPolicy)) {
      setPending(nextPolicy)
    } else {
      patch.mutate({ history: { retention: nextPolicy } })
    }
  }

  return (
    // The dialog's content header already names the section, and this lone
    // group has no sibling to disambiguate from — no group heading.
    <section className="flex flex-col gap-3">
      {notice && (
        <Callout>
          <span className="flex flex-wrap items-center gap-3">
            <span>{noticeText(notice, currentPolicy)}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={pending_}
              onClick={() =>
                patch.mutate({ history: { retentionNotice: null } })
              }
            >
              Dismiss
            </Button>
          </span>
        </Callout>
      )}
      <div className="flex flex-col gap-1 rounded-xl border border-border bg-card p-4">
        {settingsQuery.isError ? (
          <p className="text-sm text-muted-foreground">
            History settings require owner access.
          </p>
        ) : (
          <SettingRow
            className="flex-col items-start sm:flex-row sm:items-center"
            label="Doc version history"
            description="Lower limits permanently delete older versions."
          >
            <Select value={currentValue} onValueChange={handleChange}>
              <SelectTrigger className="w-52" disabled={pending_}>
                <SelectValue>{policyLabel(currentPolicy)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>
        )}
      </div>

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null)
        }}
        variant="destructive"
        title="Delete older versions?"
        description="Versions outside this limit will be deleted immediately and can’t be recovered."
        confirmLabel="Delete older versions"
        loading={patch.isPending}
        onConfirm={() => {
          if (pending) patch.mutate({ history: { retention: pending } })
          setPending(null)
        }}
      />
    </section>
  )
}
