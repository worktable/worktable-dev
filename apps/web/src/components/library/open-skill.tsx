import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { ArrowUpRight, Plus, SquarePen, Trash2 } from "lucide-react"
import { lazy, Suspense, useEffect, useState } from "react"
import { savedSinceLive } from "@worktable/types"
import { SkillFrame, SkillHead } from "@/components/library/skill-frame"
import { SkillNameDialog } from "@/components/library/skill-name-dialog"
import { useIsMobile } from "@/hooks/use-mobile"
import { useStableCallback } from "@/hooks/use-stable-callback"
import {
  SetPageMetaContext,
  useSetPageMeta,
  type PageMeta,
  type PageOverflowAction,
} from "@/hooks/use-page-meta"
import { documentRoute } from "@/lib/document-views"
import {
  documentPageQueryOptions,
  documentQueryKeys,
} from "@/lib/documents-queries"
import { libraryKey, skillTitle, type LibraryEntry } from "@/lib/library"
import { useLibraryActions, type LibraryAction } from "@/lib/library-actions"
import { useSpaces } from "@/lib/queries"

// The Doc's own page, with its editor, loads when a skill is opened.
const DocRenderer = lazy(() =>
  import("@/components/doc-document").then((module) => ({
    default: module.DocDocumentRenderer,
  }))
)

/** What a skill keeps of its Doc's page actions: its history and recovery. */
const DOC_ACTIONS = new Set(["recover-offline-edits", "version-history"])

/**
 * One skill, open as its Doc: the Doc's own editor, with when to use it and
 * what waits on it under the title. Its actions go in the app's header, as
 * a Doc's do, with the skill's own in the header's menu.
 */
export function OpenSkill({
  entry,
  libraryName,
  onAdd,
}: {
  entry: LibraryEntry
  /** Its library's name, for the trail. */
  libraryName: string
  onAdd: () => void
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const isMobile = useIsMobile()
  const setPageMeta = useSetPageMeta()
  const { run } = useLibraryActions()
  const { data: spaces } = useSpaces()
  const spaceId = entry.doc.spaceId
  const path = entry.docPath ?? ""
  // The Doc is edited only from a check made for this open.
  const check = useQuery({
    ...documentPageQueryOptions(spaceId, path),
    staleTime: 0,
    enabled: path !== "",
  })
  const page =
    check.isFetchedAfterMount && check.data?.kind === "document"
      ? check.data
      : null
  // What the Doc's page offers its header; the skill keeps part of it.
  const [docMeta, setDocMeta] = useState<PageMeta | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [pending, setPending] = useState(false)

  // The Doc's page keeps its last save current while it is open, so a draft
  // shows as it is typed, without asking the server.
  const skill = page?.skills?.find((candidate) => candidate.id === entry.id)
  const draft = skill
    ? !skill.proposed && savedSinceLive(skill.live, page?.provenance)
    : entry.draft
  const at = entry.proposal
    ? `proposal:${entry.revision}`
    : `draft:${page?.provenance?.versionId ?? ""}`

  const act = useStableCallback(async (action: LibraryAction) => {
    if (pending) return
    setPending(true)
    const done = await run(action)
    if (done && action.kind === "remove") {
      await navigate({
        to: "/library/$",
        params: { _splat: libraryKey(entry.library) },
      })
      return
    }
    // The Doc's page names the version now live.
    if (done && path)
      await queryClient.invalidateQueries({
        queryKey: documentQueryKeys.page(spaceId, path),
        exact: true,
      })
    setPending(false)
  })
  const add = useStableCallback(onAdd)
  const remove = useStableCallback(() => act({ kind: "remove", entry }))

  const title = skillTitle(entry)
  const spaceName = spaces?.find((space) => space.id === spaceId)?.name
  const docSecondary = docMeta?.secondaryAction
  const docAnnotations = docMeta?.annotations
  const docActions = docMeta?.overflowActions
  const mayChange = entry.mayChange && !entry.removed
  useEffect(() => {
    const kept = (docActions ?? []).filter((action) =>
      DOC_ACTIONS.has(action.id)
    )
    const actions: PageOverflowAction[] = [...kept]
    if (path) {
      actions.push({
        id: "open-in-space",
        label: `Open In ${spaceName ?? "Space"}`,
        icon: ArrowUpRight,
        onSelect: () => void navigate(documentRoute(spaceId, path)),
        separatorBefore: kept.length > 0,
      })
    }
    if (mayChange) {
      actions.push(
        {
          id: "rename-skill",
          label: "Rename",
          icon: SquarePen,
          onSelect: () => setRenaming(true),
          separatorBefore: actions.length > 0,
        },
        {
          id: "remove-skill",
          label: "Remove",
          icon: Trash2,
          tone: "destructive",
          onSelect: () => void remove(),
        }
      )
    }
    setPageMeta({
      titleOverride: title,
      parentTitleOverride: libraryName,
      secondaryAction: docSecondary,
      annotations: docAnnotations,
      // A narrow screen keeps the header's one action for Edit.
      primaryAction: isMobile
        ? undefined
        : {
            label: "Add Skill",
            displayLabel: "Skill",
            icon: Plus,
            onClick: add,
          },
      overflowActions: actions,
    })
  }, [
    add,
    docActions,
    docAnnotations,
    docSecondary,
    isMobile,
    libraryName,
    mayChange,
    navigate,
    path,
    remove,
    setPageMeta,
    spaceId,
    spaceName,
    title,
  ])
  useEffect(() => () => setPageMeta(null), [setPageMeta])

  const head = (
    <SkillHead
      entry={{ ...entry, draft }}
      at={at}
      pending={pending}
      onAct={(action) => void act(action)}
    />
  )
  const unavailable =
    !path ||
    (check.isError && !check.isFetching) ||
    check.data?.kind === "conflict" ||
    (page !== null && page.renderer?.key !== "doc")
  // The title and head stay in the Doc's own frame until its page is ready.
  const frame = <SkillFrame entry={entry}>{head}</SkillFrame>

  return (
    <>
      <div className="relative min-h-0 flex-1">
        {unavailable ? (
          <div className="flex h-full items-center justify-center px-6 text-sm text-muted-foreground">
            Doc Missing
          </div>
        ) : page ? (
          <Suspense fallback={frame}>
            <SetPageMetaContext.Provider value={setDocMeta}>
              <DocRenderer
                spaceId={spaceId}
                documentPath={page.document.path}
                formatId={page.document.format.id}
                page={page}
                afterTitle={head}
              />
            </SetPageMetaContext.Provider>
          </Suspense>
        ) : (
          frame
        )}
      </div>

      {renaming && (
        <SkillNameDialog entry={entry} onClose={() => setRenaming(false)} />
      )}
    </>
  )
}
