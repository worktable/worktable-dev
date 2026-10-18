import { ensureWorkspaceManifest, getWorkspaceRoot } from "./workspace.ts"
import { randomUUID } from "node:crypto"
import { mkdir, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import type { SpaceFile } from "@worktable/types"
import {
  discardPreparedSpace,
  ensureSpaceDirectories,
  listDocs,
  listSpaces,
  markPreparedSpace,
  publishPreparedSpace,
  writeDoc,
  writePreparedSpace,
} from "./store.ts"
import {
  buildRecordCollectionSchema,
  createRecord,
  reconcileDiscardedRecordCollection,
  reconcilePublishedRecordCollection,
  writeRecordCollectionSchema,
} from "./record-store.ts"
import { listWidgets, readWidgetHtml } from "./widget-store.ts"
import { createHtmlDocument } from "./html-document-create.ts"
import { readDocumentInventory } from "./document-inventory.ts"
import { readDocumentPortableStateV2, writeDocumentPortableStateV2 } from "./document-data-v2.ts"
import {
  buildWhatAgentsCanMakeBlocks,
  LAUNCH_PLAN_COLLECTION_ID,
  PROMPTS_TO_TRY_MARKDOWN,
  REVIEWING_WITH_YOUR_AGENT_MARKDOWN,
  AGENTS_THAT_STAY_ON_MARKDOWN,
  TRACKING_WORK_IN_RECORDS_MARKDOWN,
  STARTER_RECORD_FIELDS,
  STARTER_RECORDS,
  STARTER_SPACE_ID,
  STARTER_WIDGETS,
} from "./starter-space.ts"
import { GETTING_STARTED_SETTING } from "@worktable/types/setup"

// A clean install must not open onto an empty void. It starts with Getting
// Started: each person's checklist is its Space Home, beside two guides and
// an example board over live Records. Existing workspaces are never modified,
// and an older Welcome Space keeps its own content.

const STARTER_SEED_VERSION = 1
const STARTER_SEED_STATUS_KEY = "starterSeedStatus"
const STARTER_SEED_VERSION_KEY = "starterSeedVersion"
let starterSeedBeforePublishHookForTests: (() => void | Promise<void>) | null =
  null

export function setStarterSeedBeforePublishHookForTests(
  hook: (() => void | Promise<void>) | null
): void {
  starterSeedBeforePublishHookForTests = hook
}

/** The guides Getting Started links to, in the order its Space lists them. */
const STARTER_GUIDE_DOCS = [
  "what-agents-can-make",
  "prompts-to-try",
  "reviewing-with-your-agent",
  "agents-that-stay-on",
  "tracking-work-in-records",
] as const

function makeStarterSpace(): SpaceFile {
  const now = new Date().toISOString()
  return {
    type: "worktable.space",
    version: 1,
    id: STARTER_SPACE_ID,
    name: "Getting Started",
    description: "Your first steps, with guides and prompts to try.",
    icon: "rocket",
    createdAt: now,
    updatedAt: now,
    createdBy: "worktable",
    settings: {
      docSort: "custom",
      docOrder: [...STARTER_GUIDE_DOCS],
      [GETTING_STARTED_SETTING]: true,
      [STARTER_SEED_VERSION_KEY]: STARTER_SEED_VERSION,
      [STARTER_SEED_STATUS_KEY]: "complete",
    },
  }
}

function assertWrite(
  result: { error?: string | null; data?: unknown },
  message: string
): void {
  if (result.error || result.data == null) {
    throw new Error(result.error ?? message)
  }
}

async function discardStarterPreparation(preparedId: string): Promise<void> {
  await discardPreparedSpace(preparedId)
  await reconcileDiscardedRecordCollection(preparedId, LAUNCH_PLAN_COLLECTION_ID)
}

// Portable state binds its digest to the Space identity. Prepare that state
// for the published identity while all files are still private; renaming the
// source directory alone would leave otherwise valid HTML docs unreadable.
async function prepareStarterPortableState(preparedId: string): Promise<void> {
  if (ensureWorkspaceManifest().version !== 2) return
  const workspaceRoot = getWorkspaceRoot()
  const preparedRoot = join(workspaceRoot, "spaces", preparedId)
  const publicationRoot = join(preparedRoot, ".publication")
  await mkdir(publicationRoot)
  const inventory = await readDocumentInventory(preparedId)
  let hasState = false
  for (const entry of inventory.entries.values()) {
    const state = await readDocumentPortableStateV2({
      workspaceRoot, spaceId: preparedId, documentId: entry.documentId,
    })
    if (!state) continue
    hasState = true
    await writeDocumentPortableStateV2({
      ...state.manifest,
      workspaceRoot: publicationRoot,
      spaceId: STARTER_SPACE_ID,
      entries: state.entries,
    })
  }
  if (hasState) {
    await rm(join(preparedRoot, "document-data"), { recursive: true })
    await rename(
      join(publicationRoot, "spaces", STARTER_SPACE_ID, "document-data"),
      join(preparedRoot, "document-data")
    )
  }
  await rm(publicationRoot, { recursive: true })
}

/**
 * Seed the complete welcome space on a completely empty workspace. The space
 * metadata and its durable completion setting are published atomically only
 * after every payload lands, so an interrupted seed is never exposed through
 * supported APIs. If any write fails, the unpublished internal directory is
 * discarded so the next launch can retry cleanly.
 */
export async function seedStarterWorkspace(): Promise<boolean> {
  if (ensureWorkspaceManifest().starterSeed?.status === "suppressed")
    return false
  const existing = await listSpaces()
  if (existing.length > 0) return false

  const space = makeStarterSpace()
  const preparedId = `${STARTER_SPACE_ID}-seed-${randomUUID()}`
  let preparedDirectoryCreated = false
  try {
    await ensureSpaceDirectories(preparedId)
    preparedDirectoryCreated = true
    await markPreparedSpace(preparedId)

    const guideWrite = await writeDoc(
      preparedId,
      "what-agents-can-make",
      await buildWhatAgentsCanMakeBlocks(),
      { updatedBy: "worktable", source: "seed", recordVersion: false, managedIdentity: true }
    )
    if (!guideWrite.ok) {
      throw new Error(guideWrite.error ?? "What Agents Can Make seed failed")
    }

    const promptsWrite = await writeDoc(
      preparedId,
      "prompts-to-try",
      PROMPTS_TO_TRY_MARKDOWN,
      { updatedBy: "worktable", source: "seed", recordVersion: false, managedIdentity: true }
    )
    if (!promptsWrite.ok) {
      throw new Error(promptsWrite.error ?? "Prompts to Try seed failed")
    }

    for (const [path, markdown] of [
      ["reviewing-with-your-agent", REVIEWING_WITH_YOUR_AGENT_MARKDOWN],
      ["agents-that-stay-on", AGENTS_THAT_STAY_ON_MARKDOWN],
      ["tracking-work-in-records", TRACKING_WORK_IN_RECORDS_MARKDOWN],
    ] as const) {
      const written = await writeDoc(preparedId, path, markdown, {
        updatedBy: "worktable",
        source: "seed",
        recordVersion: false,
        managedIdentity: true,
      })
      if (!written.ok) throw new Error(written.error ?? `${path} seed failed`)
    }

    const schema = buildRecordCollectionSchema({
      id: LAUNCH_PLAN_COLLECTION_ID,
      name: "Launch Plan",
      description: "An example plan, tracked as Records with a board.",
      fields: STARTER_RECORD_FIELDS,
      createdBy: "worktable",
    })
    assertWrite(
      await writeRecordCollectionSchema(preparedId, schema),
      "Launch Plan schema seed failed"
    )

    for (const record of STARTER_RECORDS) {
      assertWrite(
        await createRecord(preparedId, LAUNCH_PLAN_COLLECTION_ID, {
          id: record.id,
          data: { ...record.data },
          createdBy: "worktable",
        }),
        `Starter record seed failed: ${record.id}`
      )
    }

    // The board comes after its Records, so it never opens onto a missing
    // collection.
    for (const definition of STARTER_WIDGETS) {
      const result = await createHtmlDocument({
        spaceId: preparedId,
        explicitId: definition.id,
        name: definition.name,
        description: definition.description,
        html: definition.html,
        createdBy: "worktable",
        metadata: definition.metadata,
        permissions: definition.permissions,
        versionSource: "seed",
        versionUpdatedBy: "worktable",
        recordVersion: false,
      })
      assertWrite(result, `Starter HTML doc seed failed: ${definition.id}`)
    }

    // Store the final manifest inside the private directory, then atomically
    // claim `welcome`. A concurrent external writer makes the destination
    // non-empty, causing publication to fail without replacing their files.
    await prepareStarterPortableState(preparedId)
    await writePreparedSpace(preparedId, {
      ...space,
      updatedAt: new Date().toISOString(),
    })
    await starterSeedBeforePublishHookForTests?.()
    // The workspace may have been populated by an external sync while the
    // private starter payload was being prepared. Recheck at the publication
    // boundary so a no-longer-empty workspace remains untouched.
    if ((await listSpaces()).length > 0) {
      await discardStarterPreparation(preparedId)
      preparedDirectoryCreated = false
      return false
    }
    if (!(await publishPreparedSpace(preparedId, STARTER_SPACE_ID))) {
      await discardStarterPreparation(preparedId)
      preparedDirectoryCreated = false
      return false
    }
    preparedDirectoryCreated = false
    await reconcilePublishedRecordCollection(
      preparedId,
      STARTER_SPACE_ID,
      LAUNCH_PLAN_COLLECTION_ID
    )

    return true
  } catch (error) {
    if (preparedDirectoryCreated) await discardStarterPreparation(preparedId)
    throw error
  }
}

/**
 * Filesystem-truth readiness check shared by local supervisors. The completion
 * setting rejects interrupted writes, while the explicit payload checks keep
 * the contract clear for diagnostics and tests.
 */
export async function starterWorkspaceReady(): Promise<boolean> {
  const spaces = await listSpaces()
  const starter = spaces.find((space) => space.id === STARTER_SPACE_ID)
  if (
    !starter ||
    starter.settings[STARTER_SEED_VERSION_KEY] !== STARTER_SEED_VERSION ||
    starter.settings[STARTER_SEED_STATUS_KEY] !== "complete"
  ) {
    return false
  }

  const [docs, widgets, boardHtml] = await Promise.all([
    listDocs(STARTER_SPACE_ID),
    listWidgets(STARTER_SPACE_ID),
    readWidgetHtml(STARTER_SPACE_ID, "launch-board"),
  ])
  return (
    STARTER_GUIDE_DOCS.every((path) => docs.includes(path)) &&
    widgets.some((widget) => widget.id === "launch-board") &&
    boardHtml.data != null
  )
}
