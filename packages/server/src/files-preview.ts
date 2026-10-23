import { isHosted } from "./hosted.ts"
import { getServerSettings } from "./settings-store.ts"

/**
 * Whether this Worktable runs the file features that aren't released yet.
 * Owners turn them on in Settings → System (machine-local);
 * WORKTABLE_FILES_PREVIEW=1 or 0 overrides that for the process. Cloud
 * ignores the setting and stays off unless its environment says otherwise.
 *
 * Request paths call this: it reads the environment and the cached settings,
 * nothing else.
 */
export function filesPreviewEnabled(): boolean {
  const override = filesPreviewEnvOverride()
  if (override !== null) return override
  if (isHosted()) return false
  return getServerSettings().files.preview
}

/** WORKTABLE_FILES_PREVIEW when it is set to on or off, else null. */
export function filesPreviewEnvOverride(): boolean | null {
  const env = process.env["WORKTABLE_FILES_PREVIEW"]?.trim().toLowerCase()
  if (env === "1" || env === "true") return true
  if (env === "0" || env === "false") return false
  return null
}
