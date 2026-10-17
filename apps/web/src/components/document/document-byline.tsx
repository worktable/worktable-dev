import { Link } from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useId, useState, type ReactNode } from "react"
import { ArrowDownLeft, ChevronDown, Database, History } from "lucide-react"
import type {
  ActivityActor,
  ActivityEntry,
  DocumentBacklink,
  DocumentContributors,
  DocumentProvenance,
  DocumentReferrer,
} from "@worktable/types"
import {
  Collapsible,
  CollapsibleContent,
} from "@worktable/ui/components/collapsible"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@worktable/ui/components/tooltip"
import { cn } from "@worktable/ui/lib/utils"
import {
  DOCUMENT_BYLINE_CHIP,
  DocumentLifetimeChip,
} from "@/components/document-organize"
import { DocumentFormatIcon } from "@/components/document-format-icon"
import { DocLocation } from "@/components/document/doc-location"
import { ActorBadge } from "@/components/home/activity-feed"
import { useSpaceDocumentTrees } from "@/hooks/use-space-document-trees"
import { activityQueryOptions, type ActivityOptions } from "@/lib/activity"
import { actorName, shortWhen } from "@/lib/activity-format"
import { documentRoute } from "@/lib/document-views"
import { findTreeNode } from "@/lib/space-document-tree"
import type { TreeNode } from "@/lib/tree"
import { RelativeTime } from "@/lib/time"
import {
  useBylineState,
  type BylineSection,
  type BylineState,
} from "@/hooks/use-byline-state"



const ACTIVITY_SHOWN = 6

/**
 * The line under a Doc's title: who last worked on it, what links here and
 * when it archives. Each part opens a short list in place, one at a time.
 */
export function DocumentByline({
  spaceId,
  docPath,
  provenance,
  updatedAt,
  contributors,
  backlinks,
  referrers,
  onVersionHistory,
  state,
}: {
  spaceId: string
  docPath: string
  /** The last save, kept current while the Doc is open. */
  provenance?: DocumentProvenance
  /** When the catalog last saw the Doc change, for Docs without provenance. */
  updatedAt?: string
  contributors?: DocumentContributors
  backlinks?: DocumentBacklink[]
  /** Records and HTML Docs that point here. */
  referrers?: DocumentReferrer[]
  onVersionHistory?: () => void
  /** Shared with the page's other copy of this byline, if any. */
  state?: BylineState
}) {
  const local = useBylineState()
  const { open, setOpen, lifetimeOpen, setLifetimeOpen } = state ?? local
  const [opening, setOpening] = useState(false)
  const queryClient = useQueryClient()
  const panelId = useId()
  const trees = useSpaceDocumentTrees(spaceId)
  const activityOptions: ActivityOptions = {
    spaceId,
    docPath,
    limit: ACTIVITY_SHOWN,
  }

  // Only what the sidebar shows: archived sources stay out.
  const shown = (path: string) => {
    const node = trees ? findTreeNode(trees.active, path) : undefined
    return node && node.kind === "document" ? node : undefined
  }
  const linkedDocs = (backlinks ?? []).flatMap((link) => {
    const node = shown(link.path)
    return node ? [{ ...link, node }] : []
  })
  const linkedRecords = (referrers ?? []).flatMap((referrer) =>
    referrer.kind === "record" ? [referrer] : []
  )
  const linkedHtml = (referrers ?? []).flatMap((referrer) => {
    const node = referrer.kind === "html" ? shown(referrer.path) : undefined
    return node && referrer.kind === "html" ? [{ node, label: referrer.label }] : []
  })
  const linkedCount =
    linkedDocs.length + linkedRecords.length + linkedHtml.length

  const toggle = (panel: BylineSection) => setOpen(open === panel ? null : panel)
  // The list arrives before its panel opens, so the panel grows once to its
  // full height instead of stopping at a placeholder.
  const toggleActivity = async () => {
    if (open === "activity" || opening) return setOpen(null)
    setOpening(true)
    try {
      await queryClient.fetchQuery(activityQueryOptions(activityOptions))
    } catch {
      // The panel says so below.
    } finally {
      setOpening(false)
    }
    setOpen("activity")
  }
  const prefetchActivity = () =>
    void queryClient.prefetchQuery(activityQueryOptions(activityOptions))

  const editor = lastEditorName(contributors?.lastEditor, provenance)
  const faces = contributors?.recent.slice(0, 3) ?? []
  const editedAt = provenance?.updatedAt ?? updatedAt

  return (
    <div
      className="worktable-doc-byline mb-7 font-sans text-[0.8125rem] leading-5 text-muted-foreground"
      data-doc-byline
    >
      <div className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1.5">
        {editedAt && (
          <button
            type="button"
            className={cn(
              "-ml-1 inline-flex h-7 items-center gap-2 rounded-md pr-1.5 pl-1 transition-colors hover:bg-surface-hover hover:text-foreground",
              open === "activity" && "bg-surface-hover text-foreground"
            )}
            aria-expanded={open === "activity"}
            aria-controls={`${panelId}-activity`}
            aria-busy={opening}
            onPointerEnter={prefetchActivity}
            onFocus={prefetchActivity}
            onClick={() => void toggleActivity()}
          >
            {faces.length > 0 && (
              <span className="flex -space-x-1">
                {faces.map((actor) => (
                  <span
                    key={actor.id}
                    className="rounded-md ring-2 ring-background"
                  >
                    <ActorBadge actor={actor} />
                  </span>
                ))}
              </span>
            )}
            <span>
              {editor ? `${editor} edited ` : "Edited "}
              <RelativeTime iso={editedAt} />
            </span>
          </button>
        )}
        {linkedCount > 0 && (
          <BylineChip
            icon={<ArrowDownLeft className="size-3.5" />}
            label={String(linkedCount)}
            hint={
              linkedCount === 1
                ? "1 place links here"
                : `${linkedCount} places link here`
            }
            expanded={open === "links"}
            controls={`${panelId}-links`}
            onClick={() => toggle("links")}
          />
        )}
        <DocumentLifetimeChip
          spaceId={spaceId}
          path={docPath}
          inline
          open={lifetimeOpen}
          onOpenChange={setLifetimeOpen}
        />
      </div>

      <BylinePanel id={`${panelId}-activity`} open={open === "activity"}>
        <DocActivity
          options={activityOptions}
          onVersionHistory={onVersionHistory}
        />
      </BylinePanel>
      <BylinePanel id={`${panelId}-links`} open={open === "links"}>
        <LinkedFrom
          spaceId={spaceId}
          docs={linkedDocs}
          records={linkedRecords}
          html={linkedHtml}
        />
      </BylinePanel>
    </div>
  )
}

function BylineChip({
  icon,
  label,
  hint,
  expanded,
  controls,
  onClick,
}: {
  icon: ReactNode
  label: string
  /** What a short label means, as a tooltip and the chip's accessible name. */
  hint?: string
  expanded: boolean
  controls: string
  onClick: () => void
}) {
  const chip = (
    <button
      type="button"
      className={DOCUMENT_BYLINE_CHIP}
      aria-label={hint}
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onClick}
    >
      {icon}
      <span className="max-w-56 truncate">{label}</span>
      <ChevronDown
        aria-hidden="true"
        className={cn(
          "size-3 transition-transform duration-250 ease-[cubic-bezier(0.33,1,0.68,1)] motion-reduce:transition-none",
          expanded && "rotate-180"
        )}
      />
    </button>
  )
  if (!hint) return chip
  return (
    <Tooltip>
      <TooltipTrigger render={chip} />
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  )
}

function BylinePanel({
  id,
  open,
  children,
}: {
  id: string
  open: boolean
  children: ReactNode
}) {
  return (
    <Collapsible open={open}>
      <CollapsibleContent id={id}>
        <div className="mt-2.5 flex max-h-80 flex-col overflow-y-auto rounded-xl card-surface px-2 py-1.5">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function DocActivity({
  options,
  onVersionHistory,
}: {
  options: ActivityOptions
  onVersionHistory?: () => void
}) {
  const { data, isError } = useQuery(activityQueryOptions(options))
  const entries = data?.entries ?? []
  return (
    <>
      {isError && <div className="px-2 py-1.5">Activity could not load.</div>}
      {!isError && data && entries.length === 0 && (
        <div className="px-2 py-1.5">No activity recorded yet.</div>
      )}
      {entries.map((entry) => (
        <ActivityRow key={entry.id} entry={entry} />
      ))}
      {onVersionHistory && (
        <button
          type="button"
          className="mt-0.5 inline-flex h-8 items-center gap-1.5 self-start rounded-md px-2 text-primary-text transition-colors hover:bg-surface-hover"
          onClick={onVersionHistory}
        >
          <History className="size-3.5" />
          Version History
        </button>
      )}
    </>
  )
}

const IN_DOC: Partial<Record<ActivityEntry["action"], string>> = {
  "doc.created": "created this doc",
  "doc.edited": "edited",
  "doc.archived": "archived it",
  "doc.restored": "restored it",
  "doc.kept": "kept it",
  "doc.madeTemporary": "made it temporary",
  "doc.pinned": "pinned it",
  "doc.unpinned": "unpinned it",
  "comment.replied": "replied to a comment",
}

/**
 * Activity as the Doc itself tells it: the Doc goes without saying, so it
 * reads "Claude edited", "Maya commented".
 */
function DocSentence({ entry }: { entry: ActivityEntry }) {
  if (entry.actor.kind === "system") return <>Changed outside Worktable</>
  const instruction = entry.category === "instruction"
  const verb =
    entry.action === "comment.created"
      ? instruction
        ? "left an instruction"
        : "commented"
      : entry.action === "comment.resolved"
        ? instruction
          ? "resolved an instruction"
          : "resolved a comment"
        : (IN_DOC[entry.action] ?? "changed it")
  const times =
    entry.action === "doc.edited" && entry.repeats > 1
      ? ` ${entry.repeats} times`
      : ""
  return (
    <>
      <span className="font-medium text-foreground">
        {actorName(entry.actor)}
      </span>{" "}
      {verb}
      {times}
    </>
  )
}

function ActivityRow({ entry }: { entry: ActivityEntry }) {
  const comment = entry.action.startsWith("comment.") && entry.quote
  return (
    <div className="flex items-start gap-2.5 px-2 py-1.5">
      <ActorBadge actor={entry.actor} />
      <div className="min-w-0 flex-1">
        <div className="text-foreground/85">
          <DocSentence entry={entry} />
        </div>
        {comment && <div className="mt-0.5 line-clamp-1">{entry.quote}</div>}
      </div>
      <span className="shrink-0 text-xs leading-5">{shortWhen(entry.at)}</span>
    </div>
  )
}

/**
 * What points at this Doc: Docs with the sentence their first link sits in,
 * records by the field that names it, and HTML Docs that open it. Each row
 * starts like a row on Home: icon, name, then where it lives. Kinds get a
 * heading only when more than one kind is here.
 */
function LinkedFrom({
  spaceId,
  docs,
  records,
  html,
}: {
  spaceId: string
  docs: Array<DocumentBacklink & { node: TreeNode }>
  records: Array<Extract<DocumentReferrer, { kind: "record" }>>
  html: Array<{ node: TreeNode; label?: string }>
}) {
  const groups = [docs.length, records.length, html.length].filter(Boolean).length
  const heading = (label: string) =>
    groups > 1 && (
      <div className="px-2.5 pt-3 pb-1 text-[0.6875rem] font-medium text-muted-foreground/70 first:pt-1.5">
        {label}
      </div>
    )
  return (
    <>
      {docs.length > 0 && heading("Docs")}
      {docs.map((link) => (
        <Link
          key={`doc:${link.path}`}
          {...documentRoute(spaceId, link.node.path)}
          className={REFERRER_ROW}
        >
          <ReferrerRow
            icon={<DocumentFormatIcon formatId={link.node.format?.id} />}
            name={link.node.label}
            where={<DocLocation path={link.path} />}
            note={link.count && link.count > 1 ? `${link.count} links` : undefined}
          >
            <Marked text={link.context} mark={link.mark} />
          </ReferrerRow>
        </Link>
      ))}
      {records.length > 0 && heading("Records")}
      {records.map((record) => (
        <Link
          key={`record:${record.collectionId}/${record.recordId}`}
          to="/spaces/$spaceId/records/$collectionId/$recordId"
          params={{
            spaceId,
            collectionId: record.collectionId,
            recordId: record.recordId,
          }}
          className={REFERRER_ROW}
        >
          <ReferrerRow
            icon={<Database />}
            name={record.title}
            where={<DocLocation path={`${record.collection}/`} />}
          >
            <span className={MARK}>{record.field}</span> field
          </ReferrerRow>
        </Link>
      ))}
      {html.length > 0 && heading("HTML Docs")}
      {html.map(({ node, label }) => (
        <Link
          key={`html:${node.path}`}
          {...documentRoute(spaceId, node.path)}
          className={REFERRER_ROW}
        >
          <ReferrerRow
            icon={<DocumentFormatIcon formatId="worktable.html" />}
            name={node.label}
            where={<DocLocation path={node.path} />}
          >
            {/* What people click there to come here, when it can be read. */}
            {label && <span className={MARK}>{label}</span>}
          </ReferrerRow>
        </Link>
      ))}
    </>
  )
}

const REFERRER_ROW =
  "group flex min-w-0 gap-3 rounded-lg px-2.5 py-2 transition-colors hover:bg-surface-hover"

/** The words that link, set like inline code in a Doc: the reading blue on its tint. */
const MARK =
  "rounded-[0.3em] bg-[var(--code-accent-background)] px-[0.25em] text-[var(--code-accent-foreground)] [box-decoration-break:clone]"

/** One source: a Home-style first line, then one quieter line of why it points here. */
function ReferrerRow({
  icon,
  name,
  where,
  note,
  children,
}: {
  icon: ReactNode
  name: string
  where?: ReactNode
  note?: string
  /** Why it points here; absent when there is nothing to show. */
  children?: ReactNode
}) {
  return (
    <>
      <span className="flex h-5 shrink-0 items-center text-muted-foreground transition-colors group-hover:text-foreground [&>svg]:size-4">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex h-5 min-w-0 items-center gap-3">
          <span className="min-w-0 truncate text-sm font-medium text-foreground">
            {name}
          </span>
          {where}
          {note && (
            <span className="shrink-0 text-xs text-muted-foreground">{note}</span>
          )}
        </span>
        {children && (
          <span className="mt-1 block truncate text-muted-foreground">
            {children}
          </span>
        )}
      </span>
    </>
  )
}

/** `text` with the link's words marked. */
function Marked({
  text,
  mark,
}: {
  text: string
  mark?: { start: number; length: number }
}) {
  if (!mark) return text
  const end = mark.start + mark.length
  return (
    <>
      {text.slice(0, mark.start)}
      <span className={MARK}>{text.slice(mark.start, end)}</span>
      {text.slice(end)}
    </>
  )
}

/**
 * Who made the last save. The activity summary names people and agents; the
 * save itself, which stays current while the Doc is open, says whether that
 * name still applies.
 */
function lastEditorName(
  actor: ActivityActor | undefined,
  provenance: DocumentProvenance | undefined
): string | undefined {
  const by = provenance?.updatedBy
  if (!by) return actor ? actorName(actor) : undefined
  const same =
    actor &&
    (actor.id === by ||
      (by === "user" && actor.kind === "person") ||
      (by.startsWith("agent:") && actor.id === by.slice("agent:".length)))
  if (same) return actorName(actor)
  return by === "user" ? "You" : undefined
}
