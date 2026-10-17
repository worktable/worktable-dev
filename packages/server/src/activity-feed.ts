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
import {
  createDocAliasResolver,
  readDocAliases,
  resolveDocAliasIn,
  type DocAliases,
} from "./doc-aliases.ts"
import { listDocuments } from "./document-query.ts"
import { listRecordCollectionNames } from "./record-store.ts"
import { getSpaceArchiveInfo, listSpaces } from "./store.ts"
import { hasScope } from "./token-store.ts"

export interface ActivityFeedOptions {
  spaceId?: string
  scopes: string[]
  actorKind?: ActivityActor["kind"]
  actorId?: string
  /** One doc in `spaceId`, including events recorded before it moved. */
  docPath?: string
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
  const docPath =
    options.spaceId && options.docPath
      ? await docPathMatcher(options.spaceId, options.docPath)
      : undefined
  const page = await listActivity({
    ...(options.spaceId ? { spaces: [options.spaceId] } : {}),
    visibleSpaces,
    ...scopeFilters(options.scopes),
    ...(options.actorKind ? { actorKind: options.actorKind } : {}),
    ...(options.actorId ? { actorId: options.actorId } : {}),
    ...(docPath ? { docPath } : {}),
    before: options.before ?? null,
    limit: options.limit,
    ...(options.timezoneOffset !== undefined
      ? { timezoneOffset: options.timezoneOffset }
      : {}),
  })
  return { ...page, entries: await withCurrentNames(page.entries) }
}

/** Matches a doc's current path and the paths it had before it moved. */
async function docPathMatcher(
  spaceId: string,
  docPath: string
): Promise<(path: string) => boolean> {
  const aliases = await readDocAliases(spaceId).then(
    (result) => result.aliases,
    () => null
  )
  const resolve = aliases ? createDocAliasResolver(aliases) : null
  return (path) => path === docPath || resolve?.(path) === docPath
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
  const movedPath = movedPathResolver()
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
          const moved = await movedPath(entry.spaceId, target.path)
          if (moved) {
            path = moved
            current = byPath?.get(moved)
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

/** Where a moved doc lives now, reading each Space's aliases at most once. */
function movedPathResolver(): (
  spaceId: string,
  path: string
) => Promise<string | null> {
  const aliasesBySpace = new Map<string, Promise<DocAliases | null>>()
  return async (spaceId, path) => {
    let aliases = aliasesBySpace.get(spaceId)
    if (!aliases) {
      aliases = readDocAliases(spaceId).then(
        (result) => result.aliases,
        () => null
      )
      aliasesBySpace.set(spaceId, aliases)
    }
    const loaded = await aliases
    return loaded ? resolveDocAliasIn(loaded, path) : null
  }
}

async function namedCollections(
  spaceIds: string[]
): Promise<Map<string, Map<string, string>>> {
  const pairs = await Promise.all(
    spaceIds.map(
      async (spaceId) =>
        [
          spaceId,
          await listRecordCollectionNames(spaceId).catch(
            () => new Map<string, string>()
          ),
        ] as const
    )
  )
  return new Map(pairs)
}
