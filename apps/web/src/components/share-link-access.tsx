import type {
  CollectionGrant,
  LinkGrant,
  RecordPredicate,
  ShareLinkAccess,
} from "@worktable/types"
import {
  LINK_GRANT_MAX_COLLECTIONS,
  LINK_GRANT_MAX_FIELDS,
  LINK_SUMMARY_MAX_GROUP_FIELDS,
  LINK_SUMMARY_MAX_MEASURES,
} from "@worktable/types/constants"
import { Loader2 } from "lucide-react"
import { Button } from "@worktable/ui/components/button"
import { Callout } from "@worktable/ui/components/callout"
import { Checkbox } from "@worktable/ui/components/checkbox"
import { Input } from "@worktable/ui/components/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@worktable/ui/components/select"
import { FieldEditorScope } from "./records/field-editor"
import { FilterButton, FilterChips } from "./records/filter-bar"
import {
  recordFieldColumns,
  type RecordFilter,
  type RecordFieldColumn,
} from "@/lib/records"

function rowFilters(rows: RecordPredicate | null): RecordFilter[] | null {
  if (!rows) return []
  if ("field" in rows)
    return [
      {
        f: rows.field,
        op: rows.op,
        ...(rows.value !== undefined ? { v: rows.value } : {}),
      },
    ]
  if ("and" in rows && rows.and.every((row) => "field" in row))
    return rows.and.map((row) => {
      const leaf = row as Extract<RecordPredicate, { field: string }>
      return {
        f: leaf.field,
        op: leaf.op,
        ...(leaf.value !== undefined ? { v: leaf.value } : {}),
      }
    })
  return null
}

function validGroupSize(size: number): boolean {
  return Number.isInteger(size) && size >= 2 && size <= 1000
}

function Choice({
  checked,
  disabled,
  onChange,
  children,
}: {
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
  children: React.ReactNode
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
      {children}
    </label>
  )
}

/** Keep persisted choices removable even when their schema field is gone. */
function FieldSelection({
  columns,
  selected,
  limit,
  onChange,
}: {
  columns: RecordFieldColumn[]
  selected: string[]
  limit: number
  onChange: (fields: string[]) => void
}) {
  const keys = [
    ...new Set([...columns.map((column) => column.key), ...selected]),
  ]
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {keys.map((key) => {
        const column = columns.find((entry) => entry.key === key)
        const checked = selected.includes(key)
        return (
          <Choice
            key={key}
            checked={checked}
            disabled={!checked && selected.length >= limit}
            onChange={(enabled) =>
              onChange(
                enabled
                  ? [...selected, key]
                  : selected.filter((name) => name !== key)
              )
            }
          >
            {column?.field?.name || key}
            {!column ? " (unavailable)" : ""}
          </Choice>
        )
      })}
    </div>
  )
}

/** Edits only a proposed grant. Checking it never creates or widens a link. */
export function ShareLinkAccessEditor({
  spaceId,
  container,
  access,
  grant,
  checked,
  busy,
  disabled,
  error,
  onChange,
  onCheck,
}: {
  spaceId: string
  container?: HTMLElement | null
  access: ShareLinkAccess | null
  grant: LinkGrant | null
  checked: boolean
  busy: boolean
  disabled: boolean
  error: boolean
  onChange: (grant: LinkGrant) => void
  onCheck: () => void
}) {
  const invalidTotals = Object.values(grant?.collections ?? {}).some(
    (collection) =>
      collection.mode === "summaries" &&
      !validGroupSize(collection.summaries!.minGroupSize)
  )
  function changeCollection(id: string, value: CollectionGrant | null) {
    if (!grant) return
    const collections = { ...grant.collections }
    if (value) collections[id] = value
    else delete collections[id]
    onChange({ ...grant, collections })
  }
  return (
    <FieldEditorScope container={container ?? null}>
      <section
        aria-label="What this link opens"
        className="space-y-3 rounded-lg border border-border p-3"
      >
        <div className="space-y-1">
          <h3 className="text-sm font-medium">What this link opens</h3>
          <p className="text-xs text-muted-foreground">
            Visitors can view records and use their own saved preferences. They
            cannot change your Worktable.
          </p>
        </div>
        {access && grant ? (
          <>
            {[
              ...new Set([
                ...Object.keys(access.collections),
                ...Object.keys(grant.collections),
              ]),
            ].map((id) => {
              const schema = Object.hasOwn(access.collections, id)
                ? access.collections[id]
                : undefined
              const collection = Object.hasOwn(grant.collections, id)
                ? grant.collections[id]
                : undefined
              if (!schema)
                return (
                  <fieldset
                    key={id}
                    disabled={disabled || busy}
                    className="space-y-2 border-t border-border pt-3"
                  >
                    <Choice
                      checked={Boolean(collection)}
                      onChange={() => changeCollection(id, null)}
                    >
                      {id} (unavailable)
                    </Choice>
                    <p className="text-xs text-muted-foreground">
                      Remove this collection to save other access changes. The
                      tool no longer opens it.
                    </p>
                  </fieldset>
                )
              const columns = recordFieldColumns(schema, []).filter(
                (column) => column.type !== "document"
              )
              const filters = collection ? rowFilters(collection.rows) : []
              const saved = Object.hasOwn(access.fixedReads, id)
                ? access.fixedReads[id]!
                : []
              const modeLabel =
                collection?.mode === "summaries"
                  ? "Totals"
                  : collection?.mode === "fixed"
                    ? "Saved reads"
                    : "Records"
              return (
                <fieldset
                  key={id}
                  disabled={disabled || busy}
                  className="space-y-3 border-t border-border pt-3"
                >
                  <Choice
                    checked={Boolean(collection)}
                    disabled={
                      !collection &&
                      Object.keys(grant.collections).length >=
                        LINK_GRANT_MAX_COLLECTIONS
                    }
                    onChange={(enabled) =>
                      changeCollection(
                        id,
                        enabled
                          ? {
                              fields: [],
                              rows: null,
                              timestamps: false,
                              mode: "scoped",
                            }
                          : null
                      )
                    }
                  >
                    {schema.name || id}
                  </Choice>
                  {collection ? (
                    <>
                      <Select
                        value={collection.mode}
                        onValueChange={(mode) => {
                          if (!mode) return
                          const base = { ...collection }
                          delete base.summaries
                          delete base.fixed
                          if (mode === "summaries")
                            changeCollection(id, {
                              ...base,
                              mode,
                              fields: [],
                              summaries: {
                                groupBy: [],
                                measures: [],
                                fns: ["count", "sum", "avg"],
                                minGroupSize: 5,
                              },
                            })
                          else if (mode === "fixed" && saved.length)
                            changeCollection(id, {
                              ...base,
                              mode,
                              fixed: saved,
                            })
                          else if (mode === "scoped")
                            changeCollection(id, { ...base, mode })
                        }}
                      >
                        <SelectTrigger
                          className="w-full"
                          aria-label={`Read mode for ${schema.name || id}`}
                        >
                          <SelectValue>{modeLabel}</SelectValue>
                        </SelectTrigger>
                        <SelectContent container={container}>
                          <SelectItem value="scoped">Records</SelectItem>
                          <SelectItem value="summaries">Totals</SelectItem>
                          <SelectItem
                            value="fixed"
                            disabled={
                              !saved.length && collection.mode !== "fixed"
                            }
                          >
                            Saved reads
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-medium">Rows</span>
                          {filters && (
                            <FilterButton
                              container={container}
                              spaceId={spaceId}
                              columns={columns}
                              filters={filters}
                              onChange={(next) =>
                                changeCollection(id, {
                                  ...collection,
                                  rows: next.length
                                    ? {
                                        and: next.map((filter) => ({
                                          field: filter.f,
                                          op: filter.op,
                                          ...(filter.v !== undefined
                                            ? { value: filter.v }
                                            : {}),
                                        })),
                                      }
                                    : null,
                                })
                              }
                            />
                          )}
                        </div>
                        {filters ? (
                          filters.length ? (
                            <FilterChips
                              container={container}
                              spaceId={spaceId}
                              columns={columns}
                              filters={filters}
                              onChange={(next) =>
                                changeCollection(id, {
                                  ...collection,
                                  rows: next.length
                                    ? {
                                        and: next.map((filter) => ({
                                          field: filter.f,
                                          op: filter.op,
                                          ...(filter.v !== undefined
                                            ? { value: filter.v }
                                            : {}),
                                        })),
                                      }
                                    : null,
                                })
                              }
                            />
                          ) : (
                            <p className="text-xs text-muted-foreground">
                              All live rows
                            </p>
                          )
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            This link keeps its existing combined row
                            conditions.
                          </p>
                        )}
                      </div>
                      {collection.mode !== "summaries" ? (
                        <div className="space-y-2">
                          <p className="text-xs font-medium">
                            Fields visitors can see
                          </p>
                          <FieldSelection
                            columns={columns}
                            selected={collection.fields}
                            limit={LINK_GRANT_MAX_FIELDS}
                            onChange={(fields) =>
                              changeCollection(id, { ...collection, fields })
                            }
                          />
                          {columns.length > LINK_GRANT_MAX_FIELDS ? (
                            <p className="text-xs text-muted-foreground">
                              Choose up to {LINK_GRANT_MAX_FIELDS} fields.
                            </p>
                          ) : null}
                          <Choice
                            checked={collection.timestamps}
                            onChange={(timestamps) =>
                              changeCollection(id, {
                                ...collection,
                                timestamps,
                              })
                            }
                          >
                            Created and updated times
                          </Choice>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          <p className="text-xs text-muted-foreground">
                            Only totals are returned. Individual records stay
                            hidden.
                          </p>
                          <p className="text-xs font-medium">Group totals by</p>
                          <FieldSelection
                            columns={columns.filter((column) =>
                              ["select", "multi_select", "boolean"].includes(
                                column.type
                              )
                            )}
                            selected={collection.summaries!.groupBy}
                            limit={LINK_SUMMARY_MAX_GROUP_FIELDS}
                            onChange={(groupBy) =>
                              changeCollection(id, {
                                ...collection,
                                summaries: {
                                  ...collection.summaries!,
                                  groupBy,
                                },
                              })
                            }
                          />
                          <p className="text-xs text-muted-foreground">
                            Choose up to {LINK_SUMMARY_MAX_GROUP_FIELDS}{" "}
                            grouping fields.
                          </p>
                          <p className="text-xs font-medium">
                            Number fields for totals
                          </p>
                          <FieldSelection
                            columns={columns.filter(
                              (column) => column.type === "number"
                            )}
                            selected={collection.summaries!.measures}
                            limit={LINK_SUMMARY_MAX_MEASURES}
                            onChange={(measures) =>
                              changeCollection(id, {
                                ...collection,
                                summaries: {
                                  ...collection.summaries!,
                                  measures,
                                },
                              })
                            }
                          />
                          <p className="text-xs text-muted-foreground">
                            Choose up to {LINK_SUMMARY_MAX_MEASURES} number
                            fields.
                          </p>
                          <label className="flex items-center justify-between gap-3 text-sm">
                            Minimum records per group
                            <Input
                              className="w-24"
                              type="number"
                              min={2}
                              max={1000}
                              step={1}
                              aria-invalid={
                                !validGroupSize(
                                  collection.summaries!.minGroupSize
                                )
                              }
                              value={collection.summaries!.minGroupSize || ""}
                              onChange={(event) =>
                                changeCollection(id, {
                                  ...collection,
                                  summaries: {
                                    ...collection.summaries!,
                                    minGroupSize: Number(event.target.value),
                                  },
                                })
                              }
                            />
                          </label>
                          {!validGroupSize(
                            collection.summaries!.minGroupSize
                          ) ? (
                            <p
                              role="alert"
                              className="text-xs text-destructive"
                            >
                              Choose a whole number from 2 to 1000.
                            </p>
                          ) : null}
                        </div>
                      )}
                      {collection.mode === "fixed" ? (
                        <p className="text-xs text-muted-foreground">
                          {collection.fixed?.length} saved reads. Other queries
                          are refused. Check the tool’s filters before sharing.
                        </p>
                      ) : null}
                    </>
                  ) : null}
                </fieldset>
              )
            })}
            <Choice
              checked={grant.state === "team-read"}
              disabled={
                disabled ||
                busy ||
                (!access.stateReadable && grant.state !== "team-read")
              }
              onChange={(enabled) =>
                onChange({ ...grant, state: enabled ? "team-read" : "visitor" })
              }
            >
              Read team saved state
            </Choice>
            {!access.stateReadable ? (
              <p className="text-xs text-muted-foreground">
                This tool no longer allows team saved state. Clear this access
                to keep it off.
              </p>
            ) : null}
            {checked ? (
              <div className="space-y-1" aria-live="polite">
                {access.sentences.map((sentence, index) => (
                  <p key={index} className="text-sm">
                    {sentence}
                  </p>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Check access to update counts and confirm these changes.
              </p>
            )}
            {checked && access.issues.length ? (
              <Callout>
                {access.issues.map((issue, index) => (
                  <p key={index}>
                    {issue.collectionId}: {issue.message}
                  </p>
                ))}
              </Callout>
            ) : null}
            {access.warnings.length ? (
              <Callout>
                {access.warnings.map((warning, index) => (
                  <p key={index}>{warning.message}</p>
                ))}
              </Callout>
            ) : null}
          </>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            Couldn’t check access. Try again.
          </p>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || busy || invalidTotals}
          onClick={onCheck}
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          {busy ? "Checking access…" : "Check access"}
        </Button>
        <p className="text-xs text-muted-foreground">
          Text and data written directly into the tool are always included.
          Record rules do not hide them.
        </p>
      </section>
    </FieldEditorScope>
  )
}
