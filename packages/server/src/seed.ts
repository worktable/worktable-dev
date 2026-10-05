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
  buildWaysToWorkBlocks,
  EXAMPLE_PROMPTS_MARKDOWN,
  STARTER_RECORD_FIELDS,
  STARTER_RECORDS,
  STARTER_SPACE_ID,
  STARTER_WIDGETS,
} from "./starter-space.ts"

// A clean install must not open onto an empty void. The welcome space itself
// is the onboarding: two purposeful documents, a live Records collection,
// and two HTML docs that show what the product and an agent can create.
// Existing workspaces are never modified.

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

function makeStarterSpace(): SpaceFile {
  const now = new Date().toISOString()
  return {
    type: "worktable.space",
    version: 1,
    id: STARTER_SPACE_ID,
    name: "Welcome to Worktable",
    description:
      "Formats, example prompts, and a board connected to sample records.",
    icon: "hand",
    group: "meta",
    createdAt: now,
    updatedAt: now,
    createdBy: "worktable",
    settings: {
      docSort: "custom",
      docOrder: ["ways-to-work", "example-prompts"],
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
  await reconcileDiscardedRecordCollection(preparedId, "onboarding-work")
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

    const waysWrite = await writeDoc(
      preparedId,
      "ways-to-work",
      await buildWaysToWorkBlocks(),
      { updatedBy: "worktable", source: "seed", recordVersion: false, managedIdentity: true }
    )
    if (!waysWrite.ok) {
      throw new Error(waysWrite.error ?? "Ways to Work seed failed")
    }

    const promptsWrite = await writeDoc(
      preparedId,
      "example-prompts",
      EXAMPLE_PROMPTS_MARKDOWN,
      { updatedBy: "worktable", source: "seed", recordVersion: false, managedIdentity: true }
    )
    if (!promptsWrite.ok) {
      throw new Error(promptsWrite.error ?? "Example Prompts seed failed")
    }

    const schema = buildRecordCollectionSchema({
      id: "onboarding-work",
      name: "Welcome Guide",
      description:
        "The small set of independently changing improvements that shape the first-use guide.",
      fields: STARTER_RECORD_FIELDS,
      createdBy: "worktable",
      metadata: {
        note: "Each item represents one part of the starter experience that can be reviewed and improved independently.",
      },
    })
    assertWrite(
      await writeRecordCollectionSchema(preparedId, schema),
      "Welcome Guide schema seed failed"
    )

    for (const record of STARTER_RECORDS) {
      assertWrite(
        await createRecord(preparedId, "onboarding-work", {
          id: record.id,
          data: { ...record.data },
          createdBy: "worktable",
        }),
        `Starter record seed failed: ${record.id}`
      )
    }

    // Start Here remains last among the authored payloads so every dependency
    // it points to has already landed when the completion marker is written.
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
      "onboarding-work"
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

  const [docs, widgets, boardHtml, welcomeHtml] = await Promise.all([
    listDocs(STARTER_SPACE_ID),
    listWidgets(STARTER_SPACE_ID),
    readWidgetHtml(STARTER_SPACE_ID, "onboarding-board"),
    readWidgetHtml(STARTER_SPACE_ID, "welcome"),
  ])
  const widgetIds = new Set(widgets.map((widget) => widget.id))
  return (
    docs.includes("ways-to-work") &&
    docs.includes("example-prompts") &&
    widgetIds.has("onboarding-board") &&
    widgetIds.has("welcome") &&
    boardHtml.data != null &&
    welcomeHtml.data != null
  )
}
