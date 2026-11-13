import {
  keepPreviousData,
  queryOptions,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import type { HomeFeed, HomePin, HomePinRef } from "@worktable/types"
import { fetchJSON } from "./http.ts"

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

export function homeFeedQueryOptions(options: HomeFeedOptions = {}) {
  return queryOptions({
    queryKey: homeQueryKeys.feed(options),
    queryFn: () => {
      const query = new URLSearchParams({
        timezoneOffset: String(new Date().getTimezoneOffset()),
        ...(options.spaceId ? { spaceId: options.spaceId } : {}),
        ...(options.folder ? { folder: options.folder } : {}),
      })
      return fetchJSON<HomeFeed>(`/api/home?${query}`)
    },
    staleTime: 10_000,
  })
}

/** The newest runs of work and how busy each place was. Read when the page opens. */
export function useHomeFeed(options: HomeFeedOptions = {}) {
  return useQuery({
    ...homeFeedQueryOptions(options),
    placeholderData: keepPreviousData,
  })
}

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
  const save = async (change: (pins: HomePinRef[]) => HomePinRef[]) => {
    const current = await queryClient.ensureQueryData(options)
    const next = change(
      (current.pins ?? []).map(({ spaceId, path }) => ({ spaceId, path }))
    )
    const saved = await fetchJSON<{ pins: HomePin[] }>("/api/home/pins", {
      method: "PUT",
      body: JSON.stringify({ pins: next }),
    })
    queryClient.setQueryData(options.queryKey, (feed) =>
      feed ? { ...feed, pins: saved.pins } : feed
    )
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
