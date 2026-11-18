import { useId } from "react"
import type { AgentAccess } from "@worktable/types"
import { Checkbox } from "@worktable/ui/components/checkbox"
import { Button } from "@worktable/ui/components/button"
import { cn } from "@worktable/ui/lib/utils"

const ACCESS_OPTIONS = [
  {
    key: "threads",
    label: "Threads",
    description: "Read and reply in its threads",
  },
  {
    key: "read",
    label: "Read workspace",
    description: "Docs, records, drawings, and search",
  },
  {
    key: "edit",
    label: "Edit workspace",
    description: "Create and change them",
  },
] as const

/**
 * What an agent may do, as three checkboxes. Edit includes Read; an always-on
 * agent keeps Threads, which is how it receives messages.
 */
export function AgentAccessFields({
  value,
  onChange,
  alwaysOn,
  disabled,
}: {
  value: AgentAccess
  onChange: (access: AgentAccess) => void
  alwaysOn?: boolean
  disabled?: boolean
}) {
  const id = useId()
  function set(key: keyof AgentAccess, checked: boolean) {
    const next = { ...value, [key]: checked }
    if (key === "edit" && checked) next.read = true
    if (key === "read" && !checked) next.edit = false
    onChange(next)
  }
  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled}>
      <legend className="mb-1 text-sm font-medium text-foreground">
        Access
      </legend>
      {ACCESS_OPTIONS.map((option) => {
        const locked = option.key === "threads" && alwaysOn
        return (
          <label
            key={option.key}
            htmlFor={`${id}-${option.key}`}
            className={cn(
              "flex items-start gap-2.5",
              locked || disabled ? "cursor-not-allowed" : "cursor-pointer"
            )}
          >
            <Checkbox
              id={`${id}-${option.key}`}
              className="mt-0.5"
              checked={value[option.key]}
              disabled={locked || disabled}
              onCheckedChange={(checked) => set(option.key, checked === true)}
            />
            <span className="flex flex-col">
              <span className="text-sm text-foreground">{option.label}</span>
              <span className="text-xs text-muted-foreground">
                {locked ? "Needed to receive messages" : option.description}
              </span>
            </span>
          </label>
        )
      })}
    </fieldset>
  )
}

const PILLS = [
  { key: "threads", label: "Threads" },
  { key: "read", label: "Read" },
  { key: "edit", label: "Edit" },
] as const

/**
 * The same choice as AgentAccessFields, as a row of pills, for setting an
 * agent's access before its command or token is made.
 */
export function AccessPills({
  value,
  onChange,
  alwaysOn,
  disabled,
}: {
  value: AgentAccess
  onChange: (access: AgentAccess) => void
  alwaysOn?: boolean
  disabled?: boolean
}) {
  function set(key: keyof AgentAccess, pressed: boolean) {
    const next = { ...value, [key]: pressed }
    if (key === "edit" && pressed) next.read = true
    if (key === "read" && !pressed) next.edit = false
    onChange(next)
  }
  return (
    <div role="group" aria-label="Access" className="flex flex-wrap gap-1.5">
      {PILLS.map((pill) => (
        <Button
          key={pill.key}
          type="button"
          variant="outline"
          size="sm"
          className="rounded-full px-3 aria-pressed:border-primary/50 aria-pressed:bg-primary/10 aria-pressed:text-primary-text"
          aria-pressed={value[pill.key]}
          disabled={disabled || (pill.key === "threads" && alwaysOn)}
          onClick={() => set(pill.key, !value[pill.key])}
        >
          {pill.label}
        </Button>
      ))}
    </div>
  )
}
