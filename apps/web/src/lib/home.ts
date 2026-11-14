import {
  keepPreviousData,
  queryOptions,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import type { HomeFeed, HomePin, HomePinRef } from "@worktable/types"
import { fetchJSON } from "./http.ts"
import { pollUnlessLive } from "./space-observation.ts"

export interface HomeFeedOptions {
  /** One Space: its runs, and its folders as places. */
  spaceId?: string
  /** With `spaceId`: only runs in this top-level folder. */
  folder?: string
}

// Under Activity's key, so whatever refreshes Activity after a change here
// (a kept doc, a pin, an edit) refreshes this digest of it too.
export const homeQueryKeys = {
  feed: (options: HomeFeedOptions = {}) =>
    ["activity", "home", options.spaceId ?? null, options.folder ?? null] as const,
}

/** Rows Latest shows, so the sections under it stay on a smaller screen. */
const LATEST_ROWS = 6

export function homeFeedQueryOptions(options: HomeFeedOptions = {}) {
  return queryOptions({
    queryKey: homeQueryKeys.feed(options),
    queryFn: () => {
      const query = new URLSearchParams({
        limit: String(LATEST_ROWS),
        timezoneOffset: String(new Date().getTimezoneOffset()),
        ...(options.spaceId ? { spaceId: options.spaceId } : {}),
        ...(options.folder ? { folder: options.folder } : {}),
      })
      return fetchJSON<HomeFeed>(`/api/home?${query}`)
    },
    staleTime: 10_000,
  })
}

/**
 * The newest runs of work and how busy each place was, kept current by the
 * Space's socket where there is one.
 */
export function useHomeFeed(options: HomeFeedOptions = {}) {
  return useQuery({
    ...homeFeedQueryOptions(options),
    placeholderData: keepPreviousData,
    // Home has no workspace-wide change feed yet, so it checks once a minute
    // while on screen, as Recent did before it.
    refetchInterval: pollUnlessLive(options.spaceId),
  })
}

/** The pin save in flight, if any. */
let pinSaves: Promise<unknown> = Promise.resolve()

const samePin = (a: HomePinRef, b: HomePinRef) =>
  a.spaceId === b.spaceId && a.path === b.path

/**
 * The reader's own Home pins. They arrive with Home's feed; a page that has
 * not shown Home yet reads them only when it changes them.
 */
export function useHomePins() {
  const queryClient = useQueryClient()
  const options = homeFeedQueryOptions()
  const { data } = useQuery({ ...options, enabled: false })
  const save = (change: (pins: HomePinRef[]) => HomePinRef[]) => {
    // A save sends the whole list, so each waits for the one before it and
    // starts from what that one left: two quick changes both hold.
    const saved = pinSaves.then(async () => {
      const current = await queryClient.ensureQueryData(options)
      const next = change(
        (current.pins ?? []).map(({ spaceId, path }) => ({ spaceId, path }))
      )
      const { pins } = await fetchJSON<{ pins: HomePin[] }>("/api/home/pins", {
        method: "PUT",
        body: JSON.stringify({ pins: next }),
      })
      queryClient.setQueryData(options.queryKey, (feed) =>
        feed ? { ...feed, pins } : feed
      )
    })
    pinSaves = saved.catch(() => undefined)
    return saved
  }
  return {
    pins: data?.pins,
    isPinned: (ref: HomePinRef) =>
      (data?.pins ?? []).some((pin) => samePin(pin, ref)),
    pin: (ref: HomePinRef) =>
      save((pins) => (pins.some((pin) => samePin(pin, ref)) ? pins : [...pins, ref])),
    unpin: (ref: HomePinRef) =>
      save((pins) => pins.filter((pin) => !samePin(pin, ref))),
  }
}
