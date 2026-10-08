// ============================================================
// Activity as people read it
// ============================================================
//
// Reads the recorded history for the Spaces a reader can see and fills in
// current names: renamed docs and agents show what they are called now.

import type {
  ActivityActor,
  ActivityEntry,
  ActivityPage,
} from "@worktable/types"
import { listActivity } from "./activity-log.ts"
import { agentNamesByPrincipal } from "./agent-connection-store.ts"
import { resolveDocAlias } from "./doc-aliases.ts"
import { listDocuments } from "./document-query.ts"
import { listRecordCollections } from "./record-store.ts"
import { getSpaceArchiveInfo, listSpaces } from "./store.ts"
import { hasScope } from "./token-store.ts"

export interface ActivityFeedOptions {
  spaceId?: string
  scopes: string[]
  actorKind?: ActivityActor["kind"]
  before?: string | null
  limit: number
  timezoneOffset?: number
}

export async function readActivityFeed(
  options: ActivityFeedOptions
): Promise<ActivityPage> {
  const spaces = await listSpaces()
  const visibleSpaces = new Set(
    options.spaceId
      ? spaces.filter((space) => space.id === options.spaceId).map((s) => s.id)
      : spaces
          .filter((space) => !getSpaceArchiveInfo(space))
          .map((space) => space.id)
  )
  if (options.spaceId && visibleSpaces.size === 0) {
    return { entries: [], nextCursor: null }
  }
  const includeThreads = hasScope(options.scopes, "threads:read")
  const page = await listActivity({
    ...(options.spaceId
      ? { spaces: [options.spaceId] }
      : {}),
    visibleSpaces,
    includeThreads,
    includeRecords: hasScope(options.scopes, "records:read"),
    ...(options.actorKind ? { actorKind: options.actorKind } : {}),
    before: options.before ?? null,
    limit: options.limit,
    ...(options.timezoneOffset !== undefined
      ? { timezoneOffset: options.timezoneOffset }
      : {}),
  })
  return { ...page, entries: await withCurrentNames(page.entries) }
}

async function withCurrentNames(
  entries: ActivityEntry[]
): Promise<ActivityEntry[]> {
  if (entries.length === 0) return entries
  const spaceIds = [
    ...new Set(
      entries.flatMap((entry) => (entry.spaceId ? [entry.spaceId] : []))
    ),
  ]
  const [agentNames, documents, collections] = await Promise.all([
    agentNamesByPrincipal().catch(() => new Map<string, string>()),
    namedDocuments(spaceIds),
    namedCollections(spaceIds),
  ])
  return Promise.all(
    entries.map(async (entry) => {
      const actor =
        entry.actor.kind === "agent" && agentNames.has(entry.actor.id)
          ? { ...entry.actor, name: agentNames.get(entry.actor.id)! }
          : entry.actor
      const target = entry.target
      if (target.kind === "doc" && entry.spaceId) {
        const byPath = documents.get(entry.spaceId)
        let current = byPath?.get(target.path)
        let path = target.path
        if (!current) {
          const moved = await resolveDocAlias(entry.spaceId, target.path).catch(
            () => ({ path: null })
          )
          if (moved.path) {
            path = moved.path
            current = byPath?.get(moved.path)
          }
        }
        return {
          ...entry,
          actor,
          target: {
            ...target,
            path,
            ...(current
              ? { title: current.title, formatId: current.formatId }
              : {}),
          },
        }
      }
      if (target.kind === "collection" && entry.spaceId) {
        const name = collections.get(entry.spaceId)?.get(target.collectionId)
        return {
          ...entry,
          actor,
          target: name ? { ...target, name } : target,
        }
      }
      return { ...entry, actor }
    })
  )
}

async function namedDocuments(
  spaceIds: string[]
): Promise<Map<string, Map<string, { title: string; formatId: string }>>> {
  const pairs = await Promise.all(
    spaceIds.map(async (spaceId) => {
      const items = await listDocuments({ spaceId, includeArchived: true }).catch(
        () => []
      )
      const byPath = new Map<string, { title: string; formatId: string }>()
      for (const item of items) {
        if (item.kind === "document") {
          byPath.set(item.path, { title: item.title, formatId: item.format.id })
        }
      }
      return [spaceId, byPath] as const
    })
  )
  return new Map(pairs)
}

async function namedCollections(
  spaceIds: string[]
): Promise<Map<string, Map<string, string>>> {
  const pairs = await Promise.all(
    spaceIds.map(async (spaceId) => {
      const collections = await listRecordCollections(spaceId).catch(() => [])
      return [
        spaceId,
        new Map(collections.map((collection) => [collection.id, collection.name])),
      ] as const
    })
  )
  return new Map(pairs)
}
