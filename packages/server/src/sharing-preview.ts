import { isHosted } from "./hosted.ts"
import { getServerSettings } from "./settings-store.ts"

/**
 * Whether this Worktable runs the sharing features that aren't released yet.
 * Owners turn them on in Settings → System (machine-local);
 * WORKTABLE_SHARING_PREVIEW=1 or 0 overrides that for the process. Cloud
 * ignores the setting and stays off unless its environment says otherwise.
 *
 * Request paths call this: it reads the environment and the cached settings,
 * nothing else.
 */
export function sharingPreviewEnabled(): boolean {
  const override = sharingPreviewEnvOverride()
  if (override !== null) return override
  if (isHosted()) return false
  return getServerSettings().sharing.preview
}

/** WORKTABLE_SHARING_PREVIEW when it is set to on or off, else null. */
export function sharingPreviewEnvOverride(): boolean | null {
  const env = process.env["WORKTABLE_SHARING_PREVIEW"]?.trim().toLowerCase()
  if (env === "1" || env === "true") return true
  if (env === "0" || env === "false") return false
  return null
}
