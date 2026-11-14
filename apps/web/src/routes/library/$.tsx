import { createFileRoute, Navigate } from "@tanstack/react-router"
import { Library as LibraryIcon, Plus } from "lucide-react"
import { lazy, Suspense, useEffect, useMemo, useState } from "react"
import { Button } from "@worktable/ui/components/button"
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@worktable/ui/components/empty"
import {
  AddSkillDialog,
  type DocChoice,
} from "@/components/library/add-skill-dialog"
import {
  LibraryColumn,
  LibraryHome,
  LibraryPanel,
  RECENT_ROWS,
  SkillRow,
} from "@/components/library/library-parts"
import { LibraryMark } from "@/components/library/library-mark"
import { SkillFrame } from "@/components/library/skill-frame"
import {
  useDeploymentInfo,
  useSkillLibrariesEnabled,
} from "@/hooks/use-deployment-info"
import { useIsMobile } from "@/hooks/use-mobile"
import { useScrollFade } from "@/hooks/use-scroll-fade"
import { useSetPageMeta } from "@/hooks/use-page-meta"
import {
  libraryKey,
  useLibrary,
  type LibraryEntry,
  type LibraryRef,
} from "@/lib/library"
import { useLibraryName } from "@/lib/library-actions"
import {
  parseLibraryPath,
  placesOf,
  recentOf,
  removedOf,
  skillsIn,
  pendingOf,
  type Place,
} from "@/lib/library-view"
import { useSpaces } from "@/lib/queries"

// The open skill brings the Doc's editor, so it loads when one is opened.
const OpenSkill = lazy(() =>
  import("@/components/library/open-skill").then((module) => ({
    default: module.OpenSkill,
  }))
)

export const Route = createFileRoute("/library/$")({
  component: LibraryPage,
})

const NO_ENTRIES: LibraryEntry[] = []

/** The library a key names, from the key alone. */
function libraryOf(key: string): LibraryRef {
  if (key.startsWith("space:"))
    return { kind: "space", spaceId: key.slice("space:".length) }
  if (key.startsWith("agent:"))
    return { kind: "agent", participantId: key.slice("agent:".length) }
  return { kind: "worktable" }
}

/**
 * The Library: the libraries that hold skills on the left, and on the right
 * the Library's Home, one library, what waits, or one skill as its Doc. A
 * narrow screen shows one at a time, and the header's trail leads back.
 */
function LibraryPage() {
  const deployment = useDeploymentInfo()
  const enabled = useSkillLibrariesEnabled()
  const { _splat } = Route.useParams()
  const isMobile = useIsMobile()
  const setPageMeta = useSetPageMeta()
  const library = useLibrary()
  const { data: spaces } = useSpaces()
  const libraryName = useLibraryName()
  // Adding starts from a library, from a Doc already found, or from nothing.
  const [adding, setAdding] = useState<{
    library?: LibraryRef
    doc?: DocChoice
  } | null>(null)
  const panelFade = useScrollFade<HTMLDivElement>()
  const paneFade = useScrollFade<HTMLDivElement>()

  const path = parseLibraryPath(_splat)
  const entries = library.data?.entries ?? NO_ENTRIES
  const { places, pending, removed } = useMemo(
    () => placesOf(entries),
    [entries]
  )
  const placeName = (place: Pick<Place, "library" | "name">) =>
    place.library.kind === "space"
      ? (place.name ??
        spaces?.find(
          (space) =>
            place.library.kind === "space" && space.id === place.library.spaceId
        )?.name ??
        "Space")
      : libraryName({ library: place.library, libraryName: place.name })

  const skillId =
    path.kind === "library" || path.kind === "skill" ? path.skillId : undefined
  const opened = skillId
    ? entries.find((entry) => entry.id === skillId)
    : undefined
  const key = path.kind === "library" ? path.key : undefined
  const shownLibrary = key ? libraryOf(key) : undefined
  const shownName = shownLibrary
    ? placeName({
        library: shownLibrary,
        name: places.find((place) => place.key === key)?.name,
      })
    : undefined
  const view = path.kind === "view" ? path.view : undefined
  const current = view ?? key

  // A list sets the header; an open skill sets its own.
  const isOpen = Boolean(opened)
  useEffect(() => {
    if (isOpen) return
    setPageMeta({
      titleOverride:
        view === "pending"
          ? "Pending"
          : view === "removed"
            ? "Removed"
            : shownName,
      primaryAction: {
        label: "Add Skill",
        displayLabel: "Skill",
        icon: Plus,
        onClick: () => setAdding({ library: key ? libraryOf(key) : undefined }),
      },
    })
    return () => setPageMeta(null)
  }, [isOpen, key, setPageMeta, shownName, view])

  // Libraries ride with the preview agent tools.
  if (deployment.data && !enabled) return <Navigate to="/" replace />

  if (library.data) {
    // A link names a skill alone; its address names its library too.
    const misplaced = skillId && (!opened || libraryKey(opened.library) !== key)
    if (misplaced) {
      return (
        <Navigate
          to="/library/$"
          params={{
            _splat: opened ? `${libraryKey(opened.library)}/${opened.id}` : "",
          }}
          replace
        />
      )
    }
  }

  const panel = (
    <LibraryPanel
      places={places}
      pending={pending}
      removed={removed}
      current={current}
      nameOf={placeName}
    />
  )
  const add = () => setAdding({ library: shownLibrary })

  let pane: React.ReactNode = null
  if (opened) {
    pane = (
      <Suspense fallback={<SkillFrame entry={opened} />}>
        <OpenSkill
          key={opened.id}
          entry={opened}
          libraryName={placeName({
            library: opened.library,
            name: opened.libraryName,
          })}
          onAdd={() => setAdding({ library: opened.library })}
        />
      </Suspense>
    )
  } else if (!library.data) {
    pane = null
  } else if (view) {
    const shown = view === "pending" ? pendingOf(entries) : removedOf(entries)
    pane = (
      <LibraryColumn title={view === "pending" ? "Pending" : "Removed"}>
        <div className="-mx-2.5">
          {shown.map((entry) => (
            <SkillRow key={entry.id} entry={entry} marked />
          ))}
        </div>
      </LibraryColumn>
    )
  } else if (key && shownLibrary && shownName) {
    const shown = skillsIn(entries, key)
    pane = (
      <LibraryColumn
        title={shownName}
        mark={
          <LibraryMark
            library={shownLibrary}
            name={shownName}
            className="size-8 rounded-lg text-sm [&_svg]:size-4.5"
          />
        }
      >
        {shown.length > 0 ? (
          <div className="-mx-2.5">
            {shown.map((entry) => (
              <SkillRow key={entry.id} entry={entry} />
            ))}
          </div>
        ) : (
          <Empty className="min-h-60">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <LibraryIcon />
              </EmptyMedia>
              <EmptyTitle>No skills yet</EmptyTitle>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" size="sm" onClick={add}>
                <Plus />
                Skill
              </Button>
            </EmptyContent>
          </Empty>
        )}
      </LibraryColumn>
    )
  } else {
    pane = (
      <LibraryHome
        pending={pendingOf(entries)}
        recent={recentOf(entries, RECENT_ROWS)}
        skills={entries}
        onPick={(doc) => setAdding({ doc })}
      >
        {/* A narrow screen has no panel beside Home; its libraries follow. */}
        {isMobile && places.length > 0 && (
          <section aria-labelledby="library-all">
            <h2
              id="library-all"
              className="mb-2 text-sm font-semibold text-foreground"
            >
              Libraries
            </h2>
            <div className="-mx-2.5">{panel}</div>
          </section>
        )}
      </LibraryHome>
    )
  }

  // A narrow screen shows the panel only as part of Home.
  const home = path.kind === "home"
  return (
    <main className="flex h-full min-h-0 bg-background">
      <aside
        aria-label="Library"
        className="hidden w-60 shrink-0 flex-col border-r border-border/60 md:flex"
      >
        <div
          ref={panelFade}
          className="scroll-fade min-h-0 flex-1 overflow-y-auto p-2"
        >
          {library.data && panel}
        </div>
      </aside>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        {opened ? (
          pane
        ) : (
          <div
            ref={paneFade}
            key={home ? "home" : (current ?? "")}
            className="scroll-fade min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable_both-edges]"
          >
            {pane}
          </div>
        )}
      </section>
      {adding && (
        <AddSkillDialog
          library={adding.library}
          doc={adding.doc}
          skills={entries}
          onClose={() => setAdding(null)}
        />
      )}
    </main>
  )
}
