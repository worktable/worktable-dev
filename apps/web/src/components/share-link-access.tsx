import { useId, useState } from "react"
import type {
  CollectionGrant,
  LinkGrant,
  RecordCollectionSchema,
  ShareLinkAccess,
} from "@worktable/types"
import { countedRecordsName } from "@worktable/types"
import { LINK_GRANT_MAX_FIELDS } from "@worktable/types/constants"
import { ExternalLink, Loader2 } from "lucide-react"
import { Badge } from "@worktable/ui/components/badge"
import { Button } from "@worktable/ui/components/button"
import { Callout } from "@worktable/ui/components/callout"
import { Checkbox } from "@worktable/ui/components/checkbox"
import { SettingRow } from "@worktable/ui/components/setting-row"
import { Skeleton } from "@worktable/ui/components/skeleton"
import { Switch } from "@worktable/ui/components/switch"
import { InlineError } from "@/components/share-document-action"
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
    <>
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
    </>
  )
}

/** The fields a link may show, as record pages list them. */
function grantableColumns(schema: RecordCollectionSchema): RecordFieldColumn[] {
  return recordFieldColumns(schema, []).filter(
    (column) => column.type !== "document"
  )
}

/** What visitors read of one collection, and the fields kept from them. */
function CollectionSentence({
  name,
  count,
  grant,
  schema,
}: {
  name: string
  count: number | undefined
  grant: CollectionGrant
  schema: RecordCollectionSchema
}) {
  const hidden = grantableColumns(schema).filter(
    (column) => !grant.fields.includes(column.key)
  )
  const subject = countedRecordsName(name, count, grant.rows !== null)
  return (
    <div className="space-y-2">
      <p>
        Visitors can read {subject}
        {hidden.length > 0 ? ", except:" : "."}
      </p>
      {hidden.length > 0 ? (
        <ul
          aria-label={`Hidden from ${name}`}
          className="flex flex-wrap gap-1.5"
        >
          {hidden.map((column) => (
            <li key={column.key}>
              <Badge
                variant="outline"
                className="text-muted-foreground line-through"
              >
                {column.field?.name || column.key}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/**
 * Live data for the default link of an HTML Doc: on or off, what visitors
 * can read, and which fields stay hidden. Turning it on starts from the
 * access the server suggests for the tool.
 */
export function LiveDataPanel({
  grant,
  access,
  checking,
  checkFailed,
  canTurnOn,
  busy,
  url,
  onRetry,
  onTurnOn,
  onTurnOff,
  onSaveGrant,
}: {
  /** The link's saved access; null while live data is off. */
  grant: LinkGrant | null
  /** Counts and collections for `grant`, once checked. */
  access: ShareLinkAccess | null
  checking: boolean
  checkFailed: boolean
  /** The owner policy allows live links. Turning off is always allowed. */
  canTurnOn: boolean
  busy: boolean
  url: string | undefined
  onRetry: () => void
  onTurnOn: () => void
  onTurnOff: () => void
  /** Resolves once saved, so the field list can close. */
  onSaveGrant: (grant: LinkGrant) => Promise<unknown>
}) {
  const switchId = useId()
  const [hiding, setHiding] = useState<Record<string, CollectionGrant> | null>(
    null
  )
  const on = grant !== null || (checking && !access)
  const collections = access
    ? Object.entries(grant?.collections ?? {}).flatMap(([id, collection]) => {
        const schema = Object.hasOwn(access.collections, id)
          ? access.collections[id]
          : undefined
        return schema ? [{ id, collection, schema }] : []
      })
    : []

  function save() {
    if (!grant || !hiding) return
    void onSaveGrant({
      ...grant,
      collections: { ...grant.collections, ...hiding },
    }).then(
      () => setHiding(null),
      () => {}
    )
  }

  return (
    <div className="space-y-3">
      <SettingRow label="Show live data" htmlFor={switchId}>
        <Switch
          id={switchId}
          checked={on}
          disabled={busy || checking || (!canTurnOn && grant === null)}
          onCheckedChange={(enabled) => {
            setHiding(null)
            if (enabled) onTurnOn()
            else onTurnOff()
          }}
        />
      </SettingRow>

      {grant && access ? (
        <div className="space-y-3" aria-live="polite">
          {collections.length === 0 && access.issues.length === 0 ? (
            <p>Visitors see no Records.</p>
          ) : null}
          {collections.map(({ id, collection, schema }) => (
            <CollectionSentence
              key={id}
              name={schema.name || id}
              count={
                Object.hasOwn(access.counts, id) ? access.counts[id] : undefined
              }
              grant={collection}
              schema={schema}
            />
          ))}
          {grant.state === "team-read" ? (
            <p>Visitors can see what your team saved in this tool.</p>
          ) : null}
          {access.issues.length > 0 ? (
            <Callout>
              {access.issues.map((issue, index) => (
                <p key={index}>{issue.message}</p>
              ))}
            </Callout>
          ) : null}
          {access.warnings.map((warning, index) => (
            <p key={index} className="text-xs text-muted-foreground">
              {warning.message}
            </p>
          ))}

          {hiding ? (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault()
                save()
              }}
            >
              <fieldset disabled={busy} className="space-y-3">
                <legend className="sr-only">Fields visitors can see</legend>
                {collections.map(({ id, schema }) => {
                  const draft = hiding[id]
                  if (!draft) return null
                  const change = (next: CollectionGrant) =>
                    setHiding((current) =>
                      current ? { ...current, [id]: next } : current
                    )
                  return (
                    <div key={id} className="space-y-2">
                      {collections.length > 1 ? (
                        <p className="text-xs font-medium text-muted-foreground">
                          {schema.name || id}
                        </p>
                      ) : null}
                      <div className="grid gap-2 sm:grid-cols-2">
                        <FieldSelection
                          columns={grantableColumns(schema)}
                          selected={draft.fields}
                          limit={LINK_GRANT_MAX_FIELDS}
                          onChange={(fields) => change({ ...draft, fields })}
                        />
                        <Choice
                          checked={draft.timestamps}
                          onChange={(timestamps) =>
                            change({ ...draft, timestamps })
                          }
                        >
                          Created and updated times
                        </Choice>
                      </div>
                    </div>
                  )
                })}
              </fieldset>
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={busy}>
                  {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                  Save
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setHiding(null)}
                >
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap gap-2">
              {collections.length > 0 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    setHiding(
                      Object.fromEntries(
                        collections.map(({ id, collection }) => [
                          id,
                          collection,
                        ])
                      )
                    )
                  }
                >
                  Hide Fields
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!url}
                onClick={() =>
                  url && window.open(url, "_blank", "noopener,noreferrer")
                }
              >
                <ExternalLink className="size-4" />
                View as Visitor
              </Button>
            </div>
          )}
        </div>
      ) : on && checking ? (
        <div
          className="space-y-2"
          role="status"
          aria-label="Checking live data"
        >
          <Skeleton className="h-4 w-56" />
          <Skeleton className="h-5 w-40" />
        </div>
      ) : grant && checkFailed ? (
        <div className="space-y-2">
          <InlineError>Couldn’t check live data.</InlineError>
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            Try Again
          </Button>
        </div>
      ) : null}
      {/* Turning on stops before saving when the suggested access doesn't fit. */}
      {!grant && access && access.issues.length > 0 ? (
        <Callout>
          {access.issues.map((issue, index) => (
            <p key={index}>{issue.message}</p>
          ))}
        </Callout>
      ) : null}
    </div>
  )
}
