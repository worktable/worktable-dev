import { useState } from "react"
import type { RecordFile } from "@worktable/types"
import { coerceFieldInput, fieldEditorSeed, nextBooleanValue, toastRecordError, INLINE_EDITABLE_TYPES, type RecordFieldColumn } from "@/lib/records"
import { FieldValue, type ExpandedRecords } from "./field-value"
import { DocumentPicker, MultiSelectEditor, SelectEditor, TextishEditor } from "./field-editor"

/**
 * Grid cell with in-place editing. Scalar types swap to an input on click;
 * select/multi_select/document open a popover; booleans toggle directly.
 * Browse mode bypasses every editor so clicks open the detail rail safely.
 */
export function EditableCell({
  column,
  record,
  spaceId,
  expanded,
  danglingTargets,
  onCommitField,
  editingEnabled,
}: {
  column: RecordFieldColumn
  record: RecordFile
  spaceId: string
  expanded?: ExpandedRecords
  danglingTargets?: ReadonlySet<string>
  onCommitField: (recordId: string, key: string, value: unknown) => void
  editingEnabled: boolean
}) {
  const [editing, setEditing] = useState(false)
  const value = record.data[column.key]
  const display = (
    <FieldValue
      column={column}
      value={value}
      spaceId={spaceId}
      expanded={expanded}
      danglingTargets={danglingTargets}
      linksDisabled={editingEnabled && (column.type === "url" || column.type === "email" || column.type === "document")}
    />
  )

  // Browse mode owns the default click: the event bubbles to the row and
  // opens details. Links inside FieldValue stop propagation and navigate.
  if (!editingEnabled) return display

  const commitRaw = (raw: unknown) => {
    const { value: next, error } = coerceFieldInput(column, raw)
    if (error) {
      toastRecordError(new Error(`${column.key}: ${error}`), "Invalid value")
      return
    }
    // No-op commits (blur without change) skip the PATCH entirely.
    if (sameValue(next, value)) return
    onCommitField(record.id, column.key, next)
  }

  if (!INLINE_EDITABLE_TYPES.has(column.type)) {
    return display
  }

  if (column.type === "boolean") {
    return (
      <button
        type="button"
        className="flex min-h-6 w-full items-center"
        onClick={(e) => {
          e.stopPropagation()
          onCommitField(record.id, column.key, nextBooleanValue(value, column.field?.required ?? false))
        }}
        aria-label={`Toggle ${column.key}`}
        title={column.field?.required ? undefined : "Cycles yes, no, unset"}
      >
        {display}
      </button>
    )
  }

  if (column.type === "select" && column.field?.values?.length) {
    return (
      <SelectEditor column={column} value={value} open={editing} onOpenChange={setEditing} onCommit={commitRaw}>
        {display}
      </SelectEditor>
    )
  }

  if (column.type === "multi_select" && column.field?.values?.length) {
    return (
      <MultiSelectEditor column={column} value={value} open={editing} onOpenChange={setEditing} onCommit={commitRaw}>
        {display}
      </MultiSelectEditor>
    )
  }

  if (column.type === "document") {
    return (
      <DocumentPicker spaceId={spaceId} column={column} value={value} open={editing} onOpenChange={setEditing} onCommit={commitRaw}>
        {display}
      </DocumentPicker>
    )
  }

  // Text-like (string, text, number, date, datetime, url, email, person, and
  // optionless select/multi_select which accept free entry).
  if (editing) {
    return (
      <TextishEditor
        column={column}
        initial={fieldEditorSeed(column, value)}
        onCommit={commitRaw}
        onDone={() => setEditing(false)}
      />
    )
  }
  return (
    <span
      className="block min-h-6 w-full cursor-text"
      onClick={(e) => {
        e.stopPropagation()
        setEditing(true)
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.stopPropagation()
          setEditing(true)
        }
      }}
      aria-label={`Edit ${column.key}`}
    >
      {display}
    </span>
  )
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  // Clearing an already-absent value is a no-op.
  if ((a === null || a === undefined) && (b === null || b === undefined || b === "")) return true
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}
