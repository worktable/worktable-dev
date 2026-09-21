import { useEffect, useMemo, useState } from "react"
import { Plus } from "lucide-react"
import { Button } from "@worktable/ui/components/button"
import { Checkbox } from "@worktable/ui/components/checkbox"
import { Input } from "@worktable/ui/components/input"
import { Textarea } from "@worktable/ui/components/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@worktable/ui/components/select"
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@worktable/ui/components/responsive-dialog"
import type { RecordCollectionSchema, RecordField } from "@worktable/types"
import { normalizeRecordFieldType } from "@worktable/types"
import { coerceFieldInput, columnLabel } from "@/lib/records"
import { DocumentPicker } from "./field-editor"
import { FieldValue } from "./field-value"

interface FieldEntry {
  key: string
  type: string
  required: boolean
  field: RecordField
  values?: string[]
  references?: string
  many?: boolean
  unit?: string
}

/**
 * Schema-driven record creation. Renders a typed input per schema field;
 * schemaless collections get a hint to add fields via an agent (the schema
 * editor lands in M4). Relation fields accept record ids in M1; the picker
 * arrives with M2 editing.
 */
export function NewRecordDialog({
  open,
  spaceId,
  schema,
  onClose,
  onCreate,
}: {
  open: boolean
  spaceId: string
  schema: RecordCollectionSchema | undefined
  onClose: () => void
  /** Must reject on failure so the dialog stays open with the entered values. */
  onCreate: (data: Record<string, unknown>) => Promise<unknown>
}) {
  const fields = useMemo<FieldEntry[]>(
    () =>
      Object.entries(schema?.fields ?? {}).map(([key, field]) => ({
        key,
        type: normalizeRecordFieldType(field.type),
        required: field.required ?? false,
        field,
        ...(field.values ? { values: field.values } : {}),
        ...(field.references ? { references: field.references } : {}),
        ...(field.many !== undefined ? { many: field.many } : {}),
        ...(field.unit ? { unit: field.unit } : {}),
      })),
    [schema]
  )

  const [values, setValues] = useState<Record<string, unknown>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (open) {
      // An unchecked REQUIRED boolean is a valid false, not a missing value,
      // so seed it. Optional booleans stay unset: an untouched checkbox must
      // not persist a false the user never expressed.
      setValues(
        Object.fromEntries(
          fields
            .filter((field) => field.type === "boolean" && field.required)
            .map((field) => [field.key, false])
        )
      )
      setErrors({})
      setPending(false)
    }
  }, [open, fields])

  const setValue = (key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }))
    setErrors((prev) => {
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  // Booleans are seeded (required) or intentionally unset (optional); false
  // is a present value, so the generic empty check works for them too.
  const missingRequired = fields.some(
    (field) =>
      field.required &&
      field.type !== "boolean" &&
      isEmptyValue(values[field.key])
  )
  const canCreate =
    !pending && !missingRequired && Object.keys(errors).length === 0

  const handleCreate = async () => {
    // Local pending guard: the parent's mutation state flips a render late,
    // so a double Enter/click could otherwise submit twice.
    if (pending) return
    const data: Record<string, unknown> = {}
    const nextErrors: Record<string, string> = {}
    for (const field of fields) {
      const raw = values[field.key]
      // undefined skips (untouched optional boolean stays absent); false passes
      // through since isEmptyValue only treats null/undefined/""/[] as empty.
      if (isEmptyValue(raw)) continue
      const { value, error } = coerceFieldInput(
        { type: field.type, field: field.field },
        raw
      )
      if (error) {
        nextErrors[field.key] = error
        continue
      }
      // Creation never needs an explicit null: absent and cleared are the same.
      if (value === null) continue
      data[field.key] = value
    }
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors)
      return
    }
    setPending(true)
    try {
      await onCreate(data)
      onClose()
    } catch {
      // Server rejection was toasted by the caller; keep the dialog open so
      // the entered values survive.
    } finally {
      setPending(false)
    }
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-lg bg-surface-tint">
            <Plus className="h-5 w-5 text-primary" />
          </div>
          <ResponsiveDialogTitle>New record</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {fields.length > 0
              ? `Add a record to ${schema?.name ?? "this collection"}.`
              : "This collection has no schema fields yet, so this record will be created empty. Add fields in Schema when the current workflow needs them."}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody className="space-y-4">
          {fields.map((field) => (
            <RecordFieldInput
              key={field.key}
              field={field}
              value={values[field.key]}
              error={errors[field.key]}
              onChange={(value) => setValue(field.key, value)}
              spaceId={spaceId}
            />
          ))}
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void handleCreate()} disabled={!canCreate}>
            {pending ? "Creating…" : "Create record"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

function RecordFieldInput({
  field,
  value,
  error,
  onChange,
  spaceId,
}: {
  field: FieldEntry
  value: unknown
  error?: string
  onChange: (value: unknown) => void
  spaceId: string
}) {
  const id = `record-field-${field.key}`
  const label = (
    <label htmlFor={id} className="text-sm font-medium">
      {columnLabel(field)}
      {field.required ? (
        <span className="ml-1 text-destructive">*</span>
      ) : (
        <span className="ml-1.5 font-normal text-muted-foreground">
          optional
        </span>
      )}
    </label>
  )

  const body = (() => {
    switch (field.type) {
      case "boolean":
        return (
          <div className="flex items-center gap-2 pt-1">
            <Checkbox
              id={id}
              checked={value === true}
              onCheckedChange={(checked) => onChange(checked === true)}
            />
            <label htmlFor={id} className="text-sm text-muted-foreground">
              Yes
            </label>
          </div>
        )
      case "number":
        return (
          <div className="flex items-center gap-2">
            <Input
              id={id}
              type="number"
              inputMode="decimal"
              value={typeof value === "string" ? value : ""}
              onChange={(e) => onChange(e.target.value)}
            />
            {field.unit && (
              <span className="shrink-0 text-sm text-muted-foreground">
                {field.unit}
              </span>
            )}
          </div>
        )
      case "date":
        return (
          <Input
            id={id}
            type="date"
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value)}
          />
        )
      case "datetime":
        return (
          <Input
            id={id}
            type="datetime-local"
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value)}
          />
        )
      case "text":
        return (
          <Textarea
            id={id}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value)}
            className="min-h-20"
          />
        )
      case "json":
        return (
          <Textarea
            id={id}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value)}
            placeholder='{"key": "value"}'
            className="min-h-20 font-mono text-xs"
          />
        )
      case "select": {
        // A select without declared options accepts any string server-side;
        // an empty picker would make a required field impossible to submit.
        if (!field.values?.length) {
          return (
            <Input
              id={id}
              value={typeof value === "string" ? value : ""}
              onChange={(e) => onChange(e.target.value)}
            />
          )
        }
        return (
          <Select
            value={typeof value === "string" ? value : ""}
            onValueChange={onChange}
          >
            <SelectTrigger id={id}>
              <SelectValue>
                {typeof value === "string" && value ? value : "Select…"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {field.values.map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )
      }
      case "multi_select": {
        // Same optionless fallback: free entry, comma-separated.
        if (!field.values?.length) {
          return (
            <div className="space-y-1">
              <Input
                id={id}
                value={typeof value === "string" ? value : ""}
                onChange={(e) => onChange(e.target.value)}
                placeholder="value, another value"
              />
              <p className="text-xs text-muted-foreground">
                Comma-separated values.
              </p>
            </div>
          )
        }
        const selected = Array.isArray(value) ? (value as string[]) : []
        return (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {field.values.map((option) => {
              const active = selected.includes(option)
              return (
                <button
                  key={option}
                  type="button"
                  onClick={() =>
                    onChange(
                      active
                        ? selected.filter((entry) => entry !== option)
                        : [...selected, option]
                    )
                  }
                  aria-pressed={active}
                  className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                    active
                      ? "border-primary/50 bg-surface-tint text-foreground"
                      : "border-border text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                  }`}
                >
                  {option}
                </button>
              )
            })}
          </div>
        )
      }
      case "relation":
        return (
          <div className="space-y-1">
            <Input
              id={id}
              value={typeof value === "string" ? value : ""}
              onChange={(e) => onChange(e.target.value)}
              placeholder={field.many ? "record-id, another-id" : "record-id"}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              {field.many ? "Record ids" : "Record id"} in{" "}
              <span className="font-mono">{field.references ?? "?"}</span>
            </p>
          </div>
        )
      case "document":
        return <NewRecordDocumentInput spaceId={spaceId} field={field} value={value} onChange={onChange} />
      default:
        // string, url, email, person
        return (
          <Input
            id={id}
            type={
              field.type === "email"
                ? "email"
                : field.type === "url"
                  ? "url"
                  : "text"
            }
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value)}
          />
        )
    }
  })()

  return (
    <div className="space-y-2">
      {field.type === "boolean" ? (
        <span className="text-sm font-medium">{columnLabel(field)}</span>
      ) : (
        label
      )}
      {body}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

function NewRecordDocumentInput({ spaceId, field, value, onChange }: { spaceId: string; field: FieldEntry; value: unknown; onChange: (value: unknown) => void }) {
  const [open, setOpen] = useState(false)
  const column = { key: field.key, field: field.field, type: field.type }
  return (
    <DocumentPicker spaceId={spaceId} column={column} value={value} open={open} onOpenChange={setOpen} onCommit={onChange}>
      <button type="button" className="flex min-h-9 w-full items-center rounded-md border border-input bg-background px-3 text-left text-sm">
        {isEmptyValue(value) ? <span className="text-muted-foreground">Choose a document…</span> : <FieldValue column={column} value={value} spaceId={spaceId} linksDisabled />}
      </button>
    </DocumentPicker>
  )
}

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === "string") return value.trim() === ""
  if (Array.isArray(value)) return value.length === 0
  return false
}
