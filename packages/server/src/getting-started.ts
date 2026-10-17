import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { SpaceFile } from "@worktable/types"
import {
  GETTING_STARTED_SETTING,
  GETTING_STARTED_SPACE_ID,
} from "@worktable/types/setup"
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

/** Whether this Worktable has a Getting Started Space, read from its file. */
export function gettingStartedExists(): boolean {
  try {
    const space = JSON.parse(
      readFileSync(
        join(getSpacesDir(), GETTING_STARTED_SPACE_ID, "space.json"),
        "utf8"
      )
    ) as Pick<SpaceFile, "settings">
    return isGettingStartedSpace(space)
  } catch {
    return false
  }
}
