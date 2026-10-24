import type {
  CollectionGrant,
  LinkGrant,
  ShareLinkAccess,
} from "@worktable/types"
import {
  LINK_GRANT_MAX_COLLECTIONS,
  LINK_GRANT_MAX_FIELDS,
} from "@worktable/types/constants"
import { Loader2 } from "lucide-react"
import { Button } from "@worktable/ui/components/button"
import { Callout } from "@worktable/ui/components/callout"
import { Checkbox } from "@worktable/ui/components/checkbox"
import { FieldEditorScope } from "./records/field-editor"
import { recordFieldColumns, type RecordFieldColumn } from "@/lib/records"

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
                          ? { fields: [], rows: null, timestamps: false }
                          : null
                      )
                    }
                  >
                    {schema.name || id}
                  </Choice>
                  {collection ? (
                    <>
                      {collection.rows ? (
                        <p className="text-xs text-muted-foreground">
                          Shows only records that match this link’s saved
                          conditions.
                        </p>
                      ) : null}
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
          disabled={disabled || busy}
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
