import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { SpaceFile } from "@worktable/types"
import {
  GETTING_STARTED_SETTING,
  GETTING_STARTED_SPACE_ID,
} from "@worktable/types/setup"
import { getSpaceArchiveInfo } from "./store.ts"
import { getSpacesDir } from "./workspace.ts"

/** The seeded Getting Started Space, as opposed to an older Welcome Space. */
export function isGettingStartedSpace(space: Pick<SpaceFile, "settings">): boolean {
  return space.settings?.[GETTING_STARTED_SETTING] === true
}

/**
 * Spaces that exist when Teams turns on stay with their owner, except
 * Getting Started, which every member needs to see.
 */
export function initialSpaceVisibility(
  space: Pick<SpaceFile, "settings">
): "shared" | "restricted" {
  return isGettingStartedSpace(space) ? "shared" : "restricted"
}

const SPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

function storedSpace(spaceId: string): Pick<SpaceFile, "settings"> | null {
  if (!SPACE_ID.test(spaceId)) return null
  try {
    const space = JSON.parse(
      readFileSync(join(getSpacesDir(), spaceId, "space.json"), "utf8")
    ) as Partial<Pick<SpaceFile, "settings">>
    return { settings: space.settings ?? {} }
  } catch {
    return null
  }
}

/** Whether a Space is in use, not archived, read from its file. */
export function spaceOpen(spaceId: string): boolean {
  const space = storedSpace(spaceId)
  return Boolean(space && !getSpaceArchiveInfo(space))
}

/** Whether this Worktable has a Getting Started Space in use. */
export function gettingStartedOpen(): boolean {
  const space = storedSpace(GETTING_STARTED_SPACE_ID)
  return Boolean(
    space && isGettingStartedSpace(space) && !getSpaceArchiveInfo(space)
  )
}

/** A Space's name from its file, for pages shown before anyone signs in. */
export function storedSpaceName(spaceId: string): string | null {
  if (!SPACE_ID.test(spaceId)) return null
  try {
    const space = JSON.parse(
      readFileSync(join(getSpacesDir(), spaceId, "space.json"), "utf8")
    ) as { name?: unknown }
    return typeof space.name === "string" ? space.name : null
  } catch {
    return null
  }
}
