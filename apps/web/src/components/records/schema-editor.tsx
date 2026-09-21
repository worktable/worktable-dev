import { useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Plus,
  Settings2,
  Trash,
  X,
} from "lucide-react"
import { toast } from "@worktable/ui/components/sonner"
import { Button } from "@worktable/ui/components/button"
import { Checkbox } from "@worktable/ui/components/checkbox"
import { Input } from "@worktable/ui/components/input"
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@worktable/ui/components/responsive-dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@worktable/ui/components/select"
import { useQueryClient } from "@tanstack/react-query"
import type {
  RecordCollectionSchema,
  RecordCollectionSummary,
  RecordField,
} from "@worktable/types"
import { normalizeRecordFieldType } from "@worktable/types"
import { queryKeys } from "@/lib/queries"
import { updateRecordCollection } from "@/lib/records-api"
import { columnLabel, fieldLabel } from "@/lib/records"

/** Types the editor can assign. v1 spellings (enum/reference) are readable
 *  but never WRITTEN by this editor: untouched fields pass through
 *  byte-identical, and a type change writes the v2 spelling. */
const EDITABLE_TYPES = [
  "string",
  "text",
  "number",
  "boolean",
  "date",
  "datetime",
  "url",
  "email",
  "person",
  "select",
  "multi_select",
  "relation",
  "document",
  "json",
] as const

const TYPE_LABELS: Record<string, string> = {
  string: "Text (short)",
  text: "Text (long)",
  number: "Number",
  boolean: "Checkbox",
  date: "Date",
  datetime: "Date & time",
  url: "URL",
  email: "Email",
  person: "Person",
  select: "Select",
  multi_select: "Multi-select",
  relation: "Relation",
  document: "Document",
  json: "JSON",
}

const ON_DELETE_LABELS: Record<string, string> = {
  restrict: "Block deleting referenced records",
  setNull: "Clear this field when the target is deleted",
  none: "Leave a dangling reference (integrity warning)",
}

interface DraftField {
  key: string
  spec: RecordField
  /** Original spec for dirty checks; undefined for newly added fields. */
  original?: RecordField
}

function slugifyFieldKey(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

/** Metadata keys only make sense for specific types; a retype clears the
 *  rest (undefined keys drop from the JSON payload). */
function clearInapplicableMetadata(spec: RecordField): RecordField {
  const type = normalizeRecordFieldType(spec.type)
  return {
    ...spec,
    values:
      type === "select" || type === "multi_select" ? spec.values : undefined,
    references: type === "relation" ? spec.references : undefined,
    many: type === "relation" || type === "document" ? spec.many : undefined,
    inverse: type === "relation" ? spec.inverse : undefined,
    onDelete: type === "relation" ? spec.onDelete : undefined,
    unit: type === "number" ? spec.unit : undefined,
  }
}

/** Unique key with numeric suffix; the add-row preview and addField share
 *  this so the preview always shows the key that will actually be created. */
function dedupeFieldKey(base: string, existing: string[]): string {
  let key = base
  let n = 2
  while (existing.includes(key)) key = `${base}-${n++}`
  return key
}

/**
 * Schema editor: collection name/description plus field CRUD. Saving applies
 * the whole draft in ONE upsert so the server's conforming-row gate runs
 * once; a rejected change (records that would break) surfaces inline with
 * the per-record diagnostics and the dialog stays open.
 *
 * Field KEYS are identity and cannot be renamed here (that is the journaled
 * rewrite operation from the storage decision, deliberately not built yet);
 * display names are free to change. Deleting a field only removes it from
 * the schema — values already in record files stay on disk and render as
 * unschema'd columns.
 */
export function SchemaEditorDialog({
  open,
  onClose,
  spaceId,
  collectionId,
  schema,
  ready,
  schemaError,
  collections,
}: {
  open: boolean
  onClose: () => void
  spaceId: string
  collectionId: string
  schema: RecordCollectionSchema | undefined
  /** False while the schema is still loading: an undefined `schema` then
   *  means "unknown", not "schemaless", and seeding an empty draft from it
   *  would let a save WIPE the real fields. */
  ready: boolean
  /** The schema.yaml parse error when the file EXISTS but is unreadable.
   *  That is not "schemaless": seeding an empty draft would let a save
   *  destroy the damaged schema's contents instead of surfacing the error. */
  schemaError?: string | null
  collections: RecordCollectionSummary[]
}) {
  const queryClient = useQueryClient()
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [fields, setFields] = useState<DraftField[]>([])
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  // Seed ONCE per open PER COLLECTION, and only when the schema has actually
  // resolved: seeding from a still-loading undefined schema would present an
  // empty draft whose save wipes the real fields, and reseeding on background
  // refetches (websocket invalidations) would discard unsaved edits. The ref
  // holds WHICH collection was seeded, not a boolean: if the route changes
  // collections while the dialog is open (browser Back/Forward), the stale
  // draft must not survive to be saved over the newly viewed collection.
  const seededForRef = useRef<string | null>(null)
  useEffect(() => {
    if (!open) {
      seededForRef.current = null
      return
    }
    if (seededForRef.current === collectionId || !ready || schemaError) return
    seededForRef.current = collectionId
    setName(schema?.name ?? collectionId)
    setDescription(schema?.description ?? "")
    setFields(
      Object.entries(schema?.fields ?? {}).map(([key, spec]) => ({
        key,
        spec,
        original: spec,
      }))
    )
    setExpandedKey(null)
    setSaveError(null)
    setPending(false)
  }, [open, ready, schema, collectionId, schemaError])
  const seeded = open && seededForRef.current === collectionId

  const dirty = useMemo(() => {
    if (name !== (schema?.name ?? collectionId)) return true
    if (description !== (schema?.description ?? "")) return true
    const originalKeys = Object.keys(schema?.fields ?? {})
    if (fields.length !== originalKeys.length) return true
    return fields.some(
      (field, index) =>
        field.key !== originalKeys[index] ||
        field.original === undefined ||
        JSON.stringify(field.spec) !== JSON.stringify(field.original)
    )
  }, [name, description, fields, schema, collectionId])

  // Relations the user added or edited must name a target before saving —
  // a target-less relation can't link, expand, or be integrity-checked.
  // Untouched pre-existing fields are exempt: they round-trip byte-identical
  // and blocking on inherited damage would strand unrelated edits.
  const missingTargets = useMemo(
    () =>
      fields
        .filter(
          (field) =>
            normalizeRecordFieldType(field.spec.type) === "relation" &&
            !field.spec.references &&
            JSON.stringify(field.spec) !== JSON.stringify(field.original)
        )
        .map((field) => field.key),
    [fields]
  )

  const updateField = (key: string, patch: Partial<RecordField>) => {
    setSaveError(null)
    setFields((prev) =>
      prev.map((field) => {
        if (field.key !== key) return field
        let next: RecordField = { ...field.spec, ...patch }
        if (patch.type !== undefined && patch.type !== field.spec.type) {
          // A retype drops metadata the new type has no use for — stale
          // `many`/`unit`/`values` would keep forcing a v2 stamp (or worse,
          // mislead validation) on a field that no longer needs it.
          next = clearInapplicableMetadata(next)
        } else if (
          field.spec.type === "reference" &&
          ("many" in patch ||
            "onDelete" in patch ||
            "references" in patch ||
            "inverse" in patch)
        ) {
          // v1 `reference` fields validate with v1 rules (no arrays, no
          // policies); touching relation metadata canonicalizes the type so
          // the saved schema and the write validation agree.
          next = { ...next, type: "relation" }
        }
        return { ...field, spec: next }
      })
    )
  }

  const removeField = (key: string) => {
    setSaveError(null)
    setFields((prev) => prev.filter((field) => field.key !== key))
    if (expandedKey === key) setExpandedKey(null)
  }

  const moveField = (key: string, delta: -1 | 1) => {
    setSaveError(null)
    setFields((prev) => {
      const index = prev.findIndex((field) => field.key === key)
      const nextIndex = index + delta
      if (index < 0 || nextIndex < 0 || nextIndex >= prev.length) return prev
      const next = [...prev]
      ;[next[index], next[nextIndex]] = [next[nextIndex], next[index]]
      return next
    })
  }

  const addField = (fieldName: string, type: string) => {
    const base = slugifyFieldKey(fieldName)
    if (!base) return
    const key = dedupeFieldKey(
      base,
      fields.map((field) => field.key)
    )
    const spec: RecordField = {
      type,
      ...(fieldLabel(key) !== fieldName.trim()
        ? { name: fieldName.trim() }
        : {}),
    }
    setSaveError(null)
    setFields((prev) => [...prev, { key, spec }])
    setExpandedKey(key)
  }

  const handleSave = async () => {
    if (pending || !dirty) return
    setPending(true)
    setSaveError(null)
    try {
      const trimmedDescription = description.trim()
      await updateRecordCollection(spaceId, {
        id: collectionId,
        name: name.trim() || collectionId,
        // "" only when clearing an existing description (empty string
        // overrides in the merge; undefined keeps) — never write "" noise
        // into a schema that had no description.
        ...(trimmedDescription
          ? { description: trimmedDescription }
          : schema?.description
            ? { description: "" }
            : {}),
        fields: Object.fromEntries(
          fields.map((field) => [field.key, field.spec])
        ),
      })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.recordCollections(spaceId),
      })
      toast.success("Schema saved")
      onClose()
    } catch (err) {
      // The conforming-row gate's message names the records that would break.
      setSaveError(err instanceof Error ? err.message : "Failed to save schema")
    } finally {
      setPending(false)
    }
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <ResponsiveDialogContent className="sm:max-w-xl">
        <ResponsiveDialogHeader>
          <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-lg bg-surface-tint">
            <Settings2 className="h-5 w-5 text-primary" />
          </div>
          <ResponsiveDialogTitle>Edit schema</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Keep only fields with a current editing, query, validation, or
            automation use. Field keys are permanent; display names are not.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        {schemaError ? (
          <ResponsiveDialogBody>
            <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              This collection's schema.yaml exists but can't be read, so it
              can't be edited here (saving would overwrite it). Fix the file on
              disk first. {schemaError}
            </p>
          </ResponsiveDialogBody>
        ) : (
          <ResponsiveDialogBody className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="schema-name" className="text-sm font-medium">
                  Collection name
                </label>
                <Input
                  id="schema-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="h-9"
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <label
                  htmlFor="schema-description"
                  className="text-sm font-medium"
                >
                  Description{" "}
                  <span className="font-normal text-muted-foreground">
                    keep it very concise
                  </span>
                </label>
                <Input
                  id="schema-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="What belongs in this collection?"
                  className="h-9"
                />
              </div>
            </div>

            <div className="space-y-1">
              <p className="text-sm font-medium">Fields</p>
              {fields.length === 0 && (
                <p className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                  No fields yet. Records accept any data; add fields to validate
                  writes and document meaning.
                </p>
              )}
              <div className="divide-y divide-border/60 rounded-lg border border-border/70">
                {fields.map((field, index) => (
                  <FieldRow
                    key={field.key}
                    field={field}
                    collections={collections}
                    currentCollectionId={collectionId}
                    expanded={expandedKey === field.key}
                    onToggle={() =>
                      setExpandedKey(
                        expandedKey === field.key ? null : field.key
                      )
                    }
                    onChange={(patch) => updateField(field.key, patch)}
                    onRemove={() => removeField(field.key)}
                    onMoveUp={() => moveField(field.key, -1)}
                    onMoveDown={() => moveField(field.key, 1)}
                    first={index === 0}
                    last={index === fields.length - 1}
                  />
                ))}
              </div>
            </div>

            <AddFieldRow
              existingKeys={fields.map((field) => field.key)}
              onAdd={addField}
            />

            {missingTargets.length > 0 && (
              <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                Pick a target collection for:{" "}
                <span className="font-mono">{missingTargets.join(", ")}</span>
              </p>
            )}
            {saveError && (
              <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {saveError}
              </p>
            )}
          </ResponsiveDialogBody>
        )}
        <ResponsiveDialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleSave()}
            disabled={!seeded || !dirty || pending || missingTargets.length > 0}
          >
            {pending ? "Saving…" : "Save schema"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

function FieldRow({
  field,
  collections,
  currentCollectionId,
  expanded,
  onToggle,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
  first,
  last,
}: {
  field: DraftField
  collections: RecordCollectionSummary[]
  currentCollectionId: string
  expanded: boolean
  onToggle: () => void
  onChange: (patch: Partial<RecordField>) => void
  onRemove: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  first: boolean
  last: boolean
}) {
  const normalized = normalizeRecordFieldType(field.spec.type)
  const knownType = (EDITABLE_TYPES as readonly string[]).includes(normalized)
  const [confirmDelete, setConfirmDelete] = useState(false)

  return (
    <div className="px-3 py-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={onToggle}
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground/60" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" />
          )}
          <span className="min-w-0 truncate text-sm">
            {columnLabel({ key: field.key, field: field.spec })}
          </span>
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground/60">
            {field.key}
          </span>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {TYPE_LABELS[normalized] ?? field.spec.type}
            {field.spec.required ? " · required" : ""}
          </span>
        </button>
        <span className="flex shrink-0">
          <button
            type="button"
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground/50 hover:bg-muted/50 hover:text-foreground disabled:opacity-20"
            onClick={onMoveUp}
            disabled={first}
            aria-label={`Move ${columnLabel({ key: field.key, field: field.spec })} up`}
          >
            <ArrowUp className="size-3.5" />
          </button>
          <button
            type="button"
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground/50 hover:bg-muted/50 hover:text-foreground disabled:opacity-20"
            onClick={onMoveDown}
            disabled={last}
            aria-label={`Move ${columnLabel({ key: field.key, field: field.spec })} down`}
          >
            <ArrowDown className="size-3.5" />
          </button>
        </span>
        {confirmDelete ? (
          <span className="flex shrink-0 items-center gap-1 text-xs">
            <span className="text-muted-foreground">Remove field?</span>
            <Button
              size="sm"
              variant="destructive"
              className="h-6 px-2 text-xs"
              onClick={onRemove}
            >
              Remove
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={() => setConfirmDelete(false)}
            >
              Keep
            </Button>
          </span>
        ) : (
          <button
            type="button"
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-muted/50 hover:text-destructive"
            onClick={() => setConfirmDelete(true)}
            aria-label={`Remove ${columnLabel({ key: field.key, field: field.spec })}`}
            title="Remove from schema (values already in record files stay on disk)"
          >
            <Trash className="size-3.5" />
          </button>
        )}
      </div>

      {expanded && (
        <div className="mt-3 space-y-3 pl-5">
          {!knownType && (
            <p className="text-xs text-muted-foreground">
              Type <span className="font-mono">{field.spec.type}</span> comes
              from a newer Worktable; this editor leaves it untouched.
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs font-medium text-muted-foreground">
              Display name
              <Input
                value={field.spec.name ?? ""}
                onChange={(e) =>
                  onChange({ name: e.target.value || undefined })
                }
                placeholder={fieldLabel(field.key)}
                className="h-8 text-sm"
              />
            </label>
            {knownType && (
              <label className="space-y-1 text-xs font-medium text-muted-foreground">
                Type
                <Select
                  value={normalized}
                  onValueChange={(next) =>
                    next !== null && onChange({ type: next })
                  }
                >
                  <SelectTrigger
                    className="h-8 text-sm"
                    aria-label={`Type of ${field.key}`}
                  >
                    <SelectValue>
                      {TYPE_LABELS[normalized] ?? normalized}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {EDITABLE_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {TYPE_LABELS[type]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            )}
          </div>
          <label className="block space-y-1 text-xs font-medium text-muted-foreground">
            Description{" "}
            <span className="font-normal">optional when unclear</span>
            <Input
              value={field.spec.description ?? ""}
              onChange={(e) =>
                onChange({ description: e.target.value || undefined })
              }
              placeholder="Clarify only what the name and type do not"
              className="h-8 text-sm"
            />
          </label>
          {knownType && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={field.spec.required ?? false}
                onCheckedChange={(checked) =>
                  onChange({ required: checked === true ? true : undefined })
                }
              />
              Required
            </label>
          )}

          {(normalized === "select" || normalized === "multi_select") && (
            <ValuesEditor
              values={field.spec.values ?? []}
              onChange={(values) =>
                onChange({ values: values.length > 0 ? values : undefined })
              }
            />
          )}

          {normalized === "number" && (
            <label className="block space-y-1 text-xs font-medium text-muted-foreground">
              Unit <span className="font-normal">display only</span>
              <Input
                value={field.spec.unit ?? ""}
                onChange={(e) =>
                  onChange({ unit: e.target.value || undefined })
                }
                placeholder="h, kg, $…"
                className="h-8 w-32 text-sm"
              />
            </label>
          )}

          {(normalized === "relation" || normalized === "document") && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={field.spec.many ?? false}
                onCheckedChange={(checked) =>
                  onChange({ many: checked === true ? true : undefined })
                }
              />
              Allow multiple{" "}
              {normalized === "relation" ? "records" : "documents"}
            </label>
          )}
          {normalized === "relation" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-xs font-medium text-muted-foreground">
                Target collection
                <Select
                  value={field.spec.references ?? ""}
                  onValueChange={(next) =>
                    next !== null && onChange({ references: next })
                  }
                >
                  <SelectTrigger
                    className="h-8 text-sm"
                    aria-label={`Target collection for ${field.key}`}
                  >
                    <SelectValue>
                      {field.spec.references ?? "Pick a collection…"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {collections
                      .filter(
                        (collection) => collection.id !== currentCollectionId
                      )
                      .map((collection) => (
                        <SelectItem key={collection.id} value={collection.id}>
                          {collection.name}
                        </SelectItem>
                      ))}
                    <SelectItem value={currentCollectionId}>
                      This collection (self-relation)
                    </SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <label className="space-y-1 text-xs font-medium text-muted-foreground">
                On target delete
                <Select
                  value={field.spec.onDelete ?? "none"}
                  onValueChange={(next) =>
                    next !== null &&
                    onChange({
                      onDelete:
                        next === "none"
                          ? undefined
                          : (next as "restrict" | "setNull"),
                    })
                  }
                >
                  <SelectTrigger
                    className="h-8 text-sm"
                    aria-label={`Delete policy for ${field.key}`}
                  >
                    <SelectValue>
                      {ON_DELETE_LABELS[field.spec.onDelete ?? "none"]}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(ON_DELETE_LABELS).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="space-y-1 text-xs font-medium text-muted-foreground">
                Backlink name <span className="font-normal">optional</span>
                <Input
                  value={field.spec.inverse ?? ""}
                  onChange={(e) =>
                    onChange({ inverse: e.target.value || undefined })
                  }
                  placeholder="e.g. tasks"
                  className="h-8 text-sm"
                />
              </label>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ValuesEditor({
  values,
  onChange,
}: {
  values: string[]
  onChange: (values: string[]) => void
}) {
  const [draft, setDraft] = useState("")
  const add = () => {
    const value = draft.trim()
    if (!value || values.includes(value)) return
    onChange([...values, value])
    setDraft("")
  }
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">
        Options <span className="font-normal">empty list allows any value</span>
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        {values.map((value) => (
          <span
            key={value}
            className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/30 py-0.5 pr-1 pl-2.5 text-xs"
          >
            {value}
            <button
              type="button"
              className="flex size-4 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() =>
                onChange(values.filter((entry) => entry !== value))
              }
              aria-label={`Remove option ${value}`}
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              add()
            }
          }}
          onBlur={add}
          placeholder="Add option…"
          className="h-7 w-32 text-xs"
        />
      </div>
    </div>
  )
}

function AddFieldRow({
  existingKeys,
  onAdd,
}: {
  existingKeys: string[]
  onAdd: (name: string, type: string) => void
}) {
  const [name, setName] = useState("")
  const [type, setType] = useState<string>("string")
  const slug = slugifyFieldKey(name)
  const finalKey = slug ? dedupeFieldKey(slug, existingKeys) : ""

  const add = () => {
    if (!slug) return
    onAdd(name, type)
    setName("")
    setType("string")
  }

  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">Add field</p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add()
          }}
          placeholder="Field name"
          className="h-8 w-44 text-sm"
          aria-label="New field name"
        />
        <Select
          value={type}
          onValueChange={(next) => next !== null && setType(next)}
        >
          <SelectTrigger
            className="h-8 w-40 text-sm"
            aria-label="New field type"
          >
            <SelectValue>{TYPE_LABELS[type]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {EDITABLE_TYPES.map((entry) => (
              <SelectItem key={entry} value={entry}>
                {TYPE_LABELS[entry]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" onClick={add} disabled={!slug}>
          <Plus className="mr-1 size-3.5" />
          Add
        </Button>
        {slug && (
          <span className="text-xs text-muted-foreground">
            key: <span className="font-mono">{finalKey}</span>
          </span>
        )}
      </div>
    </div>
  )
}
