// ============================================================
// Home: the newest work, and where it happened
// ============================================================
//
// Home and Space Home open on a digest of the recorded history, not the
// history itself. One person's or agent's sitting in a Space reads as one
// run, however many docs it touched, and each Space (or, in one Space, each
// top-level folder) carries how busy its last two weeks were and who worked
// there. It reads the same logs Activity does, once per request.

import type {
  ActivityActor,
  HomeFeed,
  HomePin,
  HomePinRef,
  HomePlace,
  HomeRun,
  HomeRunDoc,
} from "@worktable/types"
import {
  movedPathResolver,
  namedDocuments,
  type NamedDocument,
} from "./activity-feed.ts"
import { listDocEvents } from "./activity-log.ts"
import { agentNamesByPrincipal } from "./agent-connection-store.ts"
import { createDocAliasResolver } from "./doc-aliases.ts"
import { withContentRevisions } from "./document-content-revision.ts"
import { listDocumentsWithAliases } from "./document-query.ts"
import { isGettingStartedSpace } from "./getting-started.ts"
import { getSpaceArchiveInfo, listSpaces } from "./store.ts"

/** Days a place's history covers, today included. */
export const HOME_DAYS = 14
/** A longer pause than this starts a new run. */
const RUN_GAP_MS = 90 * 60_000
/** Docs a run names; the rest are counted. */
const RUN_DOCS = 12
/** People and agents named on a place. */
const PLACE_ACTORS = 3
const DAY_MS = 86_400_000

export interface HomeFeedOptions {
  /** One Space: its runs, and its top-level folders as places. */
  spaceId?: string
  /** With `spaceId`: only runs in this top-level folder. */
  folder?: string
  /** Runs to return. */
  limit: number
  /** Reader's UTC offset in minutes (Date#getTimezoneOffset), for days. */
  timezoneOffset?: number
  now?: number
}

interface OpenRun {
  run: HomeRun
  docs: Map<string, HomeRunDoc>
  oldest: number
}

interface OpenPlace {
  days: Set<string>[]
  who: Map<string, ActivityActor>[]
  actors: Map<string, ActivityActor>
  lastAt: string
}

/**
 * Across Spaces, the active ones, without Getting Started's guides; or the
 * one asked for, even when it is archived.
 */
async function homeSpaces(spaceId?: string): Promise<string[]> {
  const spaces = await listSpaces()
  return spaces
    .filter((space) =>
      spaceId
        ? space.id === spaceId
        : !getSpaceArchiveInfo(space) && !isGettingStartedSpace(space)
    )
    .map((space) => space.id)
}

export async function readHomeFeed(
  options: HomeFeedOptions
): Promise<Pick<HomeFeed, "runs" | "places">> {
  const spaceIds = await homeSpaces(options.spaceId)
  if (spaceIds.length === 0) return { runs: [], places: [] }
  const offsetMs = (options.timezoneOffset ?? 0) * 60_000
  const dayOf = (time: number) => Math.floor((time - offsetMs) / DAY_MS)
  const today = dayOf(options.now ?? Date.now())
  const since = (today - (HOME_DAYS - 1)) * DAY_MS + offsetMs
  const events = await listDocEvents({
    spaces: spaceIds,
    visibleSpaces: new Set(spaceIds),
  })
  if (events.length === 0) return { runs: [], places: [] }

  const agentNames = await agentNamesByPrincipal().catch(
    () => new Map<string, string>()
  )
  // Read a Space's docs when its first event comes up: a busy Worktable
  // fills Latest from a few Spaces and never reads the rest.
  const documents = new Map<string, Promise<Map<string, NamedDocument>>>()
  const documentsIn = (spaceId: string) => {
    let loading = documents.get(spaceId)
    if (!loading) {
      loading = namedDocuments([spaceId]).then(
        (named) => named.get(spaceId) ?? new Map<string, NamedDocument>()
      )
      documents.set(spaceId, loading)
    }
    return loading
  }
  const movedPath = movedPathResolver()
  const named = (actor: ActivityActor): ActivityActor =>
    actor.kind === "agent" && agentNames.has(actor.id)
      ? { ...actor, name: agentNames.get(actor.id)! }
      : actor

  const runs: HomeRun[] = []
  const openRuns = new Map<string, OpenRun>()
  // A doc is listed once, in the newest run that touched it: Latest says who
  // changed it last, not everyone who did.
  const listedDocs = new Map<string, HomeRun>()
  const places = new Map<string, OpenPlace>()
  let listedRuns = 0
  for (const event of events) {
    if (event.target.kind !== "doc" || !event.spaceId) continue
    const time = Date.parse(event.at)
    // Places count the last two weeks. Latest reaches further back only
    // until it is full, so a quiet Space still shows its last work.
    const recent = time >= since
    if (!recent && listedRuns >= options.limit) break
    const byPath = await documentsIn(event.spaceId)
    let path = event.target.path
    let current = byPath.get(path)
    if (!current) {
      const moved = await movedPath(event.spaceId, path)
      if (moved) {
        path = moved
        current = byPath.get(moved)
      }
    }

    // In one Space, a place is the doc's top-level folder.
    const placeId = options.spaceId
      ? path.includes("/")
        ? path.slice(0, path.indexOf("/"))
        : null
      : event.spaceId
    if (placeId !== null && recent) {
      let place = places.get(placeId)
      if (!place) {
        place = {
          days: Array.from({ length: HOME_DAYS }, () => new Set<string>()),
          who: Array.from({ length: HOME_DAYS }, () => new Map()),
          actors: new Map(),
          lastAt: event.at,
        }
        places.set(placeId, place)
      }
      const day = HOME_DAYS - 1 - (today - dayOf(time))
      place.days[day]?.add(path)
      const dayActors = place.who[day]
      if (
        dayActors &&
        dayActors.size < PLACE_ACTORS &&
        !dayActors.has(event.actor.id)
      ) {
        dayActors.set(event.actor.id, named(event.actor))
      }
      if (
        place.actors.size < PLACE_ACTORS &&
        !place.actors.has(event.actor.id)
      ) {
        place.actors.set(event.actor.id, named(event.actor))
      }
    }

    // A run lists docs a reader can open now.
    if (!current || current.archived) continue
    const key = `${event.actor.id}|${event.spaceId}`
    const docKey = `${event.spaceId}\n${path}`
    let open = openRuns.get(key)
    if (!open || open.oldest - time > RUN_GAP_MS) {
      const run: HomeRun = {
        id: event.id,
        actor: named(event.actor),
        spaceId: event.spaceId,
        at: event.at,
        docs: [],
        more: 0,
      }
      open = { run, docs: new Map(), oldest: time }
      openRuns.set(key, open)
      runs.push(run)
    }
    open.oldest = time
    // One folder narrows what a run lists, never where the sitting begins
    // and ends: work elsewhere in between still joins its two halves.
    if (options.folder !== undefined && placeId !== options.folder) continue
    const created = event.action === "doc.created"
    const listed = open.docs.get(path)
    if (listed) {
      if (created) listed.created = true
      continue
    }
    if (listedDocs.has(docKey)) continue
    const doc: HomeRunDoc = {
      path,
      title: current.title,
      formatId: current.formatId,
      at: event.at,
      created,
    }
    if (open.run.docs.length === 0) listedRuns += 1
    open.docs.set(path, doc)
    open.run.docs.push(doc)
    listedDocs.set(docKey, open.run)
  }

  return {
    runs: runs
      .filter((run) => run.docs.length > 0)
      // A row's time is when it last touched a doc it lists, which a folder
      // or a doc listed in a newer row can make earlier than its start.
      .map((run) => ({ ...run, at: run.docs[0]!.at }))
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, options.limit)
      .map((run) => ({
        ...run,
        docs: run.docs.slice(0, RUN_DOCS),
        more: Math.max(0, run.docs.length - RUN_DOCS),
      })),
    places: [...places]
      .map(
        ([id, place]): HomePlace => ({
          id,
          days: place.days.map((docs) => docs.size),
          who: place.who.map((actors) => [...actors.values()]),
          actors: [...place.actors.values()],
          lastAt: place.lastAt,
        })
      )
      .sort((a, b) => b.lastAt.localeCompare(a.lastAt)),
  }
}

/** A person's Home pins as they stand now: moved docs followed, gone ones marked. */
export async function resolveHomePins(
  refs: readonly HomePinRef[],
  canRead: (spaceId: string) => boolean
): Promise<HomePin[]> {
  const readable = refs.filter((ref) => canRead(ref.spaceId))
  const bySpace = new Map(
    await Promise.all(
      [...new Set(readable.map((ref) => ref.spaceId))].map(
        async (spaceId) =>
          [
            spaceId,
            await listDocumentsWithAliases({
              spaceId,
              includeArchived: true,
            }).catch(() => null),
          ] as const
      )
    )
  )
  const pins = readable.map((ref): HomePin => {
    const listed = bySpace.get(ref.spaceId)
    if (!listed) return { ...ref, status: "missing" }
    const path = createDocAliasResolver(listed.aliases)(ref.path) ?? ref.path
    const document = listed.documents.find(
      (item) => item.kind === "document" && item.path === path
    )
    if (!document || document.kind !== "document") {
      return { ...ref, status: "missing" }
    }
    return {
      spaceId: ref.spaceId,
      path,
      status: document.archived ? "archived" : "active",
      title: document.title,
      formatId: document.format.id,
    }
  })
  return withContentRevisions(
    pins,
    (pin) =>
      pin.status === "active" ? { spaceId: pin.spaceId, path: pin.path } : null,
    (pin, revision) => ({ ...pin, revision })
  )
}
