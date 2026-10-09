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
import { listActivity, listActivityAgents } from "./activity-log.ts"
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
  actorId?: string
  before?: string | null
  limit: number
  timezoneOffset?: number
}

/** Active Spaces, or the one asked for even when it is archived. */
async function visibleSpacesFor(spaceId?: string): Promise<Set<string>> {
  const spaces = await listSpaces()
  return new Set(
    spaceId
      ? spaces.filter((space) => space.id === spaceId).map((s) => s.id)
      : spaces
          .filter((space) => !getSpaceArchiveInfo(space))
          .map((space) => space.id)
  )
}

/** Event kinds the reader's scopes let them open. */
function scopeFilters(scopes: string[]) {
  return {
    includeThreads: hasScope(scopes, "threads:read"),
    includeRecords: hasScope(scopes, "records:read"),
    includeComments: hasScope(scopes, "annotations:read"),
  }
}

export async function readActivityFeed(
  options: ActivityFeedOptions
): Promise<ActivityPage> {
  const visibleSpaces = await visibleSpacesFor(options.spaceId)
  if (options.spaceId && visibleSpaces.size === 0) {
    return { entries: [], nextCursor: null }
  }
  const page = await listActivity({
    ...(options.spaceId ? { spaces: [options.spaceId] } : {}),
    visibleSpaces,
    ...scopeFilters(options.scopes),
    ...(options.actorKind ? { actorKind: options.actorKind } : {}),
    ...(options.actorId ? { actorId: options.actorId } : {}),
    before: options.before ?? null,
    limit: options.limit,
    ...(options.timezoneOffset !== undefined
      ? { timezoneOffset: options.timezoneOffset }
      : {}),
  })
  return { ...page, entries: await withCurrentNames(page.entries) }
}

/** The agents a reader can filter Activity by, under their current names. */
export async function readActivityAgents(options: {
  spaceId?: string
  scopes: string[]
}): Promise<ActivityActor[]> {
  const visibleSpaces = await visibleSpacesFor(options.spaceId)
  if (options.spaceId && visibleSpaces.size === 0) return []
  const [agents, names] = await Promise.all([
    listActivityAgents({
      ...(options.spaceId ? { spaces: [options.spaceId] } : {}),
      visibleSpaces,
      ...scopeFilters(options.scopes),
    }),
    agentNamesByPrincipal().catch(() => new Map<string, string>()),
  ])
  return agents.map((agent) => ({
    ...agent,
    name: names.get(agent.id) ?? agent.name,
  }))
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
      const items = await listDocuments({
        spaceId,
        includeArchived: true,
      }).catch(() => [])
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
        new Map(
          collections.map((collection) => [collection.id, collection.name])
        ),
      ] as const
    })
  )
  return new Map(pairs)
}
