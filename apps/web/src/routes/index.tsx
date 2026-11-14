import { useEffect, useSyncExternalStore } from "react"
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { ArrowRight } from "lucide-react"
import { toast } from "@worktable/ui/components/sonner"
import { cn } from "@worktable/ui/lib/utils"
import { WorktableAppIcon } from "@/components/worktable-app-icon"
import {
  ArchivingWeek,
  pageColumns,
  pinGrid,
  PinTile,
  PinTilesSkeleton,
  PlaceCard,
  PlaceCardsSkeleton,
  sectionHeading,
  sideColumn,
} from "@/components/home/home-cards"
import { LatestRuns, LatestSkeleton } from "@/components/home/home-latest"
import { HomeNewMenu } from "@/components/home/home-new-menu"
import { PendingSection } from "@/components/home/home-sections"
import { PageWithActivity } from "@/components/home/page-with-activity"
import { SpaceIcon } from "@/components/spaces/space-icon"
import type { SpaceView } from "@/lib/api"
import { useHomeFeed, useHomePins } from "@/lib/home"
import { useSpaces, useWorkspace } from "@/lib/queries"
import { recognitionChip } from "@/lib/recognition"
import { isGettingStartedSpace } from "@/lib/setup"
import { getSpaceArchiveInfo } from "@/lib/spaces"
import { recognitionColor } from "@worktable/types/recognition"

export const Route = createFileRoute("/")({
  component: HomePage,
})

/** Spaces shown as cards; the sidebar lists the rest. */
const SPACE_CARDS = 4

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <WorktableAppIcon className="mb-5 size-14" />
      <h2 className="text-base font-medium text-foreground">
        Welcome to Worktable
      </h2>
      <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted-foreground">
        Create documents in the sidebar, or ask an AI agent to create a visual
        HTML doc.
      </p>
    </div>
  )
}

const noChange = () => () => {}

// How many pins Home showed last time, so a cold load holds their place
// instead of moving the page when they arrive.
const PIN_COUNT_KEY = "worktable-home-pins"

function rememberedPinCount(): number {
  try {
    return Math.max(0, Math.min(8, Number(localStorage.getItem(PIN_COUNT_KEY)) || 0))
  } catch {
    return 0
  }
}

function greetingNow(): string {
  const hour = new Date().getHours()
  return hour >= 5 && hour < 12
    ? "Good morning"
    : hour >= 12 && hour < 18
      ? "Good afternoon"
      : "Good evening"
}

function todayNow(): string {
  return new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  })
}

/**
 * A greeting for the reader's time of day. The prerendered page has none,
 * since the server does not know the reader's clock.
 */
function useGreeting(name: string | undefined): string | null {
  const part = useSyncExternalStore(noChange, greetingNow, () => null)
  if (!part) return null
  // A Worktable whose owner has not named themselves greets no one by name.
  const first = name?.trim().split(/\s+/)[0]
  return first && first !== "Owner" ? `${part}, ${first}` : part
}

function HomePage() {
  const { data: spaces } = useSpaces()
  const { data: workspace } = useWorkspace()
  const greeting = useGreeting(workspace?.person?.name)
  // Read on each render, so it follows the day without a timer of its own.
  const today = useSyncExternalStore(noChange, todayNow, () => null)
  const feed = useHomeFeed()
  const homePins = useHomePins()
  const navigate = useNavigate()
  const expectedPins = useSyncExternalStore(noChange, rememberedPinCount, () => 0)
  const pinCount = feed.data?.pins?.length
  useEffect(() => {
    if (pinCount === undefined) return
    try {
      localStorage.setItem(PIN_COUNT_KEY, String(pinCount))
    } catch {
      // The page still loads; it only moves once when pins arrive.
    }
  }, [pinCount])
  if (spaces?.length === 0) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
        <EmptyState />
      </div>
    )
  }

  const byId = new Map((spaces ?? []).map((space) => [space.id, space]))
  const activeSpaces = (spaces ?? []).filter(
    (space) => !getSpaceArchiveInfo(space)
  )
  const tintOf = (space: SpaceView | undefined, spaceId: string) =>
    recognitionChip(recognitionColor(space?.settings?.color, spaceId))
  const runs = feed.data?.runs ?? []
  const places = (feed.data?.places ?? [])
    .filter((place) => byId.has(place.id))
    .slice(0, SPACE_CARDS)
  const pins = feed.data?.pins ?? []
  const temporary = feed.data?.temporary ?? []
  // Pins make the side column; Archiving alone sits under the page.
  const loadingPins = feed.isPending && expectedPins > 0
  const hasSide = pins.length > 0 || loadingPins

  const unpin = (pin: { spaceId: string; path: string }) =>
    void homePins.unpin(pin).catch((error: unknown) => {
      console.error("Failed to unpin from Home:", error)
      toast.error("Couldn’t unpin. Try again.")
    })

  return (
    <PageWithActivity wide>
      <header className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="mb-1.5 h-4 text-[0.6875rem] leading-4 font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            {today}
          </p>
          <h1 className="min-h-9 font-display text-[1.65rem] leading-tight font-semibold tracking-tight text-foreground sm:min-h-10 sm:text-[2rem]">
            {greeting}
          </h1>
        </div>
        <HomeNewMenu
          spaces={activeSpaces.filter((space) => !isGettingStartedSpace(space))}
        />
      </header>

      <div
        className={cn(
          "flex flex-col gap-9",
          hasSide && pageColumns
        )}
      >
        <div className="order-1 flex min-w-0 flex-col gap-9">
          <PendingSection />
          <section aria-labelledby="recent-heading" className="min-w-0">
          <div className="mb-2.5 flex items-baseline justify-between gap-3">
            <h2 id="recent-heading" className={sectionHeading}>
              Latest
            </h2>
            <Link
              to="/activity"
              className="inline-flex items-center gap-1 text-[0.8125rem] text-muted-foreground hover:text-foreground"
            >
              Activity
              <ArrowRight className="size-3.5" />
            </Link>
          </div>
          {feed.isPending ? (
            <LatestSkeleton />
          ) : feed.isError && !feed.data ? (
            <p className="text-sm text-muted-foreground">
              Couldn’t load the latest work.{" "}
              <button
                type="button"
                className="text-primary-text hover:underline"
                onClick={() => void feed.refetch()}
              >
                Try again
              </button>
            </p>
          ) : runs.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing yet.</p>
          ) : (
            <LatestRuns
              runs={runs}
              place={(run) => {
                const space = byId.get(run.spaceId)
                return (
                  <>
                    {space && <SpaceIcon space={space} size="xs" />}
                    <span className="min-w-0 truncate">
                      {space?.name ?? run.spaceId}
                    </span>
                  </>
                )
              }}
            />
          )}
          </section>
        </div>

        <aside
          className={cn(
            "order-2 contents",
            hasSide && sideColumn
          )}
        >
          {loadingPins && (
            <section aria-hidden className="order-2 min-w-0">
              <h2 className={cn(sectionHeading, "mb-2.5")}>Pinned</h2>
              <PinTilesSkeleton count={expectedPins} />
            </section>
          )}
          {pins.length > 0 && (
            <section aria-labelledby="pinned-heading" className="order-2 min-w-0">
              <h2 id="pinned-heading" className={cn(sectionHeading, "mb-2.5")}>
                Pinned
              </h2>
              <div className={pinGrid}>
                {pins.map((pin) => {
                  const space = byId.get(pin.spaceId)
                  return (
                    <PinTile
                      key={`${pin.spaceId}/${pin.path}`}
                      spaceId={pin.spaceId}
                      path={pin.path}
                      title={pin.title ?? pin.path.split("/").at(-1) ?? pin.path}
                      formatId={pin.formatId}
                      revision={pin.revision}
                      tint={tintOf(space, pin.spaceId)}
                      disabled={
                        pin.status === "active"
                          ? undefined
                          : pin.status === "archived"
                            ? "Archived"
                            : "Missing"
                      }
                      place={
                        <>
                          {space && <SpaceIcon space={space} size="xs" />}
                          <span className="min-w-0 truncate">
                            {space?.name ?? pin.spaceId}
                          </span>
                        </>
                      }
                      onUnpin={() => unpin(pin)}
                    />
                  )
                })}
              </div>
            </section>
          )}
          <div className="order-4 empty:hidden">
            <ArchivingWeek items={temporary} side={hasSide} />
          </div>
        </aside>

        {feed.isPending && (
          <section aria-hidden className="order-3 min-w-0 @3xl/page:col-span-2">
            <h2 className={cn(sectionHeading, "mb-2.5")}>Spaces</h2>
            <PlaceCardsSkeleton />
          </section>
        )}
        {places.length > 0 && (
          <section
            aria-labelledby="spaces-heading"
            className="order-3 min-w-0 @3xl/page:col-span-2"
          >
            <h2 id="spaces-heading" className={cn(sectionHeading, "mb-2.5")}>
              Spaces
            </h2>
            <div className="grid grid-cols-2 gap-3 @3xl/page:grid-cols-4">
              {places.map((place) => {
                const space = byId.get(place.id)!
                return (
                  <PlaceCard
                    key={place.id}
                    icon={<SpaceIcon space={space} />}
                    name={space.name}
                    days={place.days}
                    who={place.who}
                    actors={place.actors}
                    lastAt={place.lastAt}
                    onOpen={() =>
                      void navigate({
                        to: "/spaces/$spaceId",
                        params: { spaceId: place.id },
                      })
                    }
                  >
                    <Link
                      to="/spaces/$spaceId"
                      params={{ spaceId: place.id }}
                      className="absolute inset-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={space.name}
                    />
                  </PlaceCard>
                )
              })}
            </div>
          </section>
        )}
      </div>
    </PageWithActivity>
  )
}
