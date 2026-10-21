import type {
  CollectionGrant,
  LinkGrant,
  RecordPredicate,
  ShareLinkAccess,
} from "@worktable/types"
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
import { FilterButton, FilterChips } from "./records/filter-bar"
import { recordFieldColumns, type RecordFilter } from "@/lib/records"

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

/** Edits only a proposed grant. Checking it never creates or widens a link. */
export function ShareLinkAccessEditor({
  spaceId,
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
  access: ShareLinkAccess | null
  grant: LinkGrant | null
  checked: boolean
  busy: boolean
  disabled: boolean
  error: boolean
  onChange: (grant: LinkGrant) => void
  onCheck: () => void
}) {
  function changeCollection(id: string, value: CollectionGrant | null) {
    if (!grant) return
    const collections = { ...grant.collections }
    if (value) collections[id] = value
    else delete collections[id]
    onChange({ ...grant, collections })
  }
  return (
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
          {Object.entries(access.collections).map(([id, schema]) => {
            const collection = Object.hasOwn(grant.collections, id)
              ? grant.collections[id]
              : undefined
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
                          changeCollection(id, { ...base, mode, fixed: saved })
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
                      <SelectContent>
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
                          This link keeps its existing combined row conditions.
                        </p>
                      )}
                    </div>
                    {collection.mode !== "summaries" ? (
                      <div className="space-y-2">
                        <p className="text-xs font-medium">
                          Fields visitors can see
                        </p>
                        <div className="grid gap-2 sm:grid-cols-2">
                          {columns.map(({ key, field }) => (
                            <Choice
                              key={key}
                              checked={collection.fields.includes(key)}
                              onChange={(enabled) =>
                                changeCollection(id, {
                                  ...collection,
                                  fields: enabled
                                    ? [...collection.fields, key]
                                    : collection.fields.filter(
                                        (name) => name !== key
                                      ),
                                })
                              }
                            >
                              {field?.name || key}
                            </Choice>
                          ))}
                        </div>
                        <Choice
                          checked={collection.timestamps}
                          onChange={(timestamps) =>
                            changeCollection(id, { ...collection, timestamps })
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
                        {columns
                          .filter((column) =>
                            ["select", "multi_select", "boolean"].includes(
                              column.type
                            )
                          )
                          .map(({ key, field }) => (
                            <Choice
                              key={key}
                              checked={collection.summaries!.groupBy.includes(
                                key
                              )}
                              onChange={(enabled) =>
                                changeCollection(id, {
                                  ...collection,
                                  summaries: {
                                    ...collection.summaries!,
                                    groupBy: enabled
                                      ? [...collection.summaries!.groupBy, key]
                                      : collection.summaries!.groupBy.filter(
                                          (name) => name !== key
                                        ),
                                  },
                                })
                              }
                            >
                              {field?.name || key}
                            </Choice>
                          ))}
                        <p className="text-xs font-medium">
                          Number fields for totals
                        </p>
                        {columns
                          .filter((column) => column.type === "number")
                          .map(({ key, field }) => (
                            <Choice
                              key={key}
                              checked={collection.summaries!.measures.includes(
                                key
                              )}
                              onChange={(enabled) =>
                                changeCollection(id, {
                                  ...collection,
                                  summaries: {
                                    ...collection.summaries!,
                                    measures: enabled
                                      ? [...collection.summaries!.measures, key]
                                      : collection.summaries!.measures.filter(
                                          (name) => name !== key
                                        ),
                                  },
                                })
                              }
                            >
                              {field?.name || key}
                            </Choice>
                          ))}
                        <label className="flex items-center justify-between gap-3 text-sm">
                          Minimum records per group
                          <Input
                            className="w-24"
                            type="number"
                            min={2}
                            max={1000}
                            value={collection.summaries!.minGroupSize}
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
            disabled={disabled || busy || !access.stateReadable}
            onChange={(enabled) =>
              onChange({ ...grant, state: enabled ? "team-read" : "visitor" })
            }
          >
            Read team saved state
          </Choice>
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
        disabled={disabled || busy}
        onClick={onCheck}
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : null}
        {busy ? "Checking access…" : "Check access"}
      </Button>
      <p className="text-xs text-muted-foreground">
        Text and data written directly into the tool are always included. Record
        rules do not hide them.
      </p>
    </section>
  )
}
