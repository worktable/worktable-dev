import { Link } from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useId, useState, type ReactNode } from "react"
import { ChevronDown, FileText, Folder, History, Link2 } from "lucide-react"
import type {
  ActivityActor,
  ActivityEntry,
  DocumentBacklink,
  DocumentContributors,
  DocumentProvenance,
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
import { documentRoute, documentPathKey } from "@/lib/document-views"
import { findTreeNode } from "@/lib/space-document-tree"
import type { TreeNode } from "@/lib/tree"
import { RelativeTime } from "@/lib/time"

type Panel = "activity" | "links" | "folder"

const ACTIVITY_SHOWN = 6

/**
 * The line under a Doc's title: who last worked on it, and where it sits
 * among other work (what links here, the rest of its folder, when it
 * archives). Each part opens a short list in place, one at a time.
 */
export function DocumentByline({
  spaceId,
  docPath,
  provenance,
  updatedAt,
  contributors,
  backlinks,
  onVersionHistory,
}: {
  spaceId: string
  docPath: string
  /** The last save, kept current while the Doc is open. */
  provenance?: DocumentProvenance
  /** When the catalog last saw the Doc change, for Docs without provenance. */
  updatedAt?: string
  contributors?: DocumentContributors
  backlinks?: DocumentBacklink[]
  onVersionHistory?: () => void
}) {
  const [open, setOpen] = useState<Panel | null>(null)
  const [opening, setOpening] = useState(false)
  const queryClient = useQueryClient()
  const panelId = useId()
  const trees = useSpaceDocumentTrees(spaceId)
  const activityOptions: ActivityOptions = {
    spaceId,
    docPath,
    limit: ACTIVITY_SHOWN,
  }

  const linked = (backlinks ?? []).flatMap((link) => {
    const node = trees ? findTreeNode(trees.active, link.path) : undefined
    return node && !node.isFolder ? [{ ...link, node }] : []
  })
  const parentPath = docPath.split("/").slice(0, -1).join("/")
  const folder = parentPath && trees ? findTreeNode(trees.active, parentPath) : undefined
  const folderDocs = folder?.children.filter((node) => !node.isFolder) ?? []

  const toggle = (panel: Panel) => setOpen(open === panel ? null : panel)
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
        {editedAt && (linked.length > 0 || folderDocs.length > 1) && (
          <span aria-hidden="true" className="opacity-50">
            ·
          </span>
        )}
        {linked.length > 0 && (
          <BylineChip
            icon={<Link2 className="size-3.5" />}
            label={`Linked from ${linked.length}`}
            expanded={open === "links"}
            controls={`${panelId}-links`}
            onClick={() => toggle("links")}
          />
        )}
        {folder && folderDocs.length > 1 && (
          <BylineChip
            icon={<Folder className="size-3.5" />}
            label={`${folderDocs.length} in ${folder.label}`}
            expanded={open === "folder"}
            controls={`${panelId}-folder`}
            onClick={() => toggle("folder")}
          />
        )}
        <DocumentLifetimeChip spaceId={spaceId} path={docPath} inline />
      </div>

      <BylinePanel id={`${panelId}-activity`} open={open === "activity"}>
        <DocActivity
          options={activityOptions}
          onVersionHistory={onVersionHistory}
        />
      </BylinePanel>
      <BylinePanel id={`${panelId}-links`} open={open === "links"}>
        {linked.map((link) => (
          <DocRow
            key={link.path}
            spaceId={spaceId}
            node={link.node}
            location={folderLabels(trees?.active, link.path)}
            detail={link.context}
          />
        ))}
      </BylinePanel>
      <BylinePanel id={`${panelId}-folder`} open={open === "folder"}>
        {folderDocs.map((node) => (
          <DocRow
            key={node.path}
            spaceId={spaceId}
            node={node}
            current={documentPathKey(node.path) === documentPathKey(docPath)}
          />
        ))}
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
        <div className="card-surface mt-2.5 flex max-h-80 flex-col overflow-y-auto rounded-xl px-2 py-1.5">
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
      {isError && (
        <div className="px-2 py-1.5">Activity could not load.</div>
      )}
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

function DocRow({
  spaceId,
  node,
  location,
  detail,
  current = false,
}: {
  spaceId: string
  node: TreeNode
  location?: string
  detail?: string
  current?: boolean
}) {
  const body = (
    <>
      <FileText className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate font-medium",
            current ? "text-primary-text" : "text-foreground"
          )}
        >
          {node.label}
        </span>
        {location && <span className="block truncate text-xs">{location}</span>}
        {detail && <span className="mt-0.5 line-clamp-2 block">{detail}</span>}
      </span>
    </>
  )
  const className = "flex items-start gap-2.5 rounded-lg px-2 py-1.5"
  return current ? (
    <div className={className} aria-current="page">
      {body}
    </div>
  ) : (
    <Link
      {...documentRoute(spaceId, node.path)}
      className={cn(className, "transition-colors hover:bg-surface-hover")}
    >
      {body}
    </Link>
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
function folderLabels(nodes: TreeNode[] | undefined, path: string): string | undefined {
  if (!nodes) return undefined
  const segments = path.split("/").slice(0, -1)
  const labels: string[] = []
  for (let depth = 1; depth <= segments.length; depth += 1) {
    const node = findTreeNode(nodes, segments.slice(0, depth).join("/"))
    labels.push(node?.label ?? segments[depth - 1]!)
  }
  return labels.length > 0 ? labels.join(" / ") : undefined
}
