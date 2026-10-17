import { Link } from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useId, useState, type ReactNode } from "react"
import {
  AppWindow,
  ChevronDown,
  Database,
  FileText,
  History,
  Link2,
} from "lucide-react"
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
import { cn } from "@worktable/ui/lib/utils"
import {
  DOCUMENT_BYLINE_CHIP,
  DocumentLifetimeChip,
} from "@/components/document-organize"
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
    return node ? [node] : []
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
            icon={<Link2 className="size-3.5" />}
            label={`Linked from ${linkedCount}`}
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
          nodes={trees?.active}
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
  expanded,
  controls,
  onClick,
}: {
  icon: ReactNode
  label: string
  expanded: boolean
  controls: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={DOCUMENT_BYLINE_CHIP}
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
 * records by the field that names it, and HTML Docs that open it. Kinds get
 * a heading only when more than one kind is here.
 */
function LinkedFrom({
  spaceId,
  nodes,
  docs,
  records,
  html,
}: {
  spaceId: string
  nodes: TreeNode[] | undefined
  docs: Array<DocumentBacklink & { node: TreeNode }>
  records: Array<Extract<DocumentReferrer, { kind: "record" }>>
  html: TreeNode[]
}) {
  const groups = [docs.length, records.length, html.length].filter(
    Boolean
  ).length
  const heading = (label: string) =>
    groups > 1 && (
      <div className="px-2 pt-2 pb-0.5 text-[0.6875rem] font-medium tracking-wide text-muted-foreground/70 uppercase">
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
            icon={<FileText />}
            name={link.node.label}
            where={folderLabels(nodes, link.path)}
            note={
              link.count && link.count > 1 ? `${link.count} links` : undefined
            }
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
            where={record.collection}
          >
            <span className="text-foreground">{record.field}</span> field
          </ReferrerRow>
        </Link>
      ))}
      {html.length > 0 && heading("HTML Docs")}
      {html.map((node) => (
        <Link
          key={`html:${node.path}`}
          {...documentRoute(spaceId, node.path)}
          className={REFERRER_ROW}
        >
          <ReferrerRow
            icon={<AppWindow />}
            name={node.label}
            where={folderLabels(nodes, node.path)}
          >
            Opens this doc
          </ReferrerRow>
        </Link>
      ))}
    </>
  )
}

const REFERRER_ROW =
  "flex items-start gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-hover"

/** One source: its name, where it sits, and one line of why it points here. */
function ReferrerRow({
  icon,
  name,
  where,
  note,
  children,
}: {
  icon: ReactNode
  name: string
  where?: string
  note?: string
  children: ReactNode
}) {
  return (
    <>
      <span className="flex h-5 shrink-0 items-center [&>svg]:size-3.5">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate font-medium text-foreground">{name}</span>
          {where && <span className="shrink-0 truncate text-xs">{where}</span>}
          {note && <span className="shrink-0 text-xs">{note}</span>}
        </span>
        <span className="block truncate">{children}</span>
      </span>
    </>
  )
}

/** `text` with the link's words in the reading color. */
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
      <span className="text-foreground">{text.slice(mark.start, end)}</span>
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

/** "Research / Slite Review" for a doc in research/slite-review. */
function folderLabels(
  nodes: TreeNode[] | undefined,
  path: string
): string | undefined {
  if (!nodes) return undefined
  const segments = path.split("/").slice(0, -1)
  const labels: string[] = []
  for (let depth = 1; depth <= segments.length; depth += 1) {
    const node = findTreeNode(nodes, segments.slice(0, depth).join("/"))
    labels.push(node?.label ?? segments[depth - 1]!)
  }
  return labels.length > 0 ? labels.join(" / ") : undefined
}
