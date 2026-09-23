import * as React from "react"

import { cn } from "@worktable/ui/lib/utils"

import { FieldLabel, FieldDescription } from "./field"

function SettingRow({
  label,
  labelVariant = "default",
  description,
  htmlFor,
  children,
  className,
}: {
  label: React.ReactNode
  labelVariant?: "default" | "heading"
  description?: React.ReactNode
  htmlFor?: string
  children: React.ReactNode
  className?: string
}) {
  const labelId = React.useId()
  // A bare control in the slot (Switch, Select trigger, …) has no accessible
  // name of its own — point it at the row label. Only a single element child
  // is annotated, and an explicit aria-label/-labelledby on it wins.
  const control =
    React.isValidElement<{ "aria-labelledby"?: string; "aria-label"?: string }>(
      children
    ) &&
    !children.props["aria-labelledby"] &&
    !children.props["aria-label"]
      ? React.cloneElement(children, { "aria-labelledby": labelId })
      : children
  return (
    <div
      data-slot="setting-row"
      className={cn("flex items-center justify-between gap-4 py-1", className)}
    >
      <div className="min-w-0 space-y-0.5">
        <FieldLabel
          id={labelId}
          htmlFor={htmlFor}
          className={
            labelVariant === "heading"
              ? "text-sm tracking-[revert-layer] text-foreground"
              : undefined
          }
        >
          {label}
        </FieldLabel>
        {description ? (
          <FieldDescription>{description}</FieldDescription>
        ) : null}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  )
}

export { SettingRow }
