import type { SettingsSectionId } from "@/components/settings/sections"

// Imperative "open Settings at a section" channel. The dialog is owned by the
// app shell; surfaces that live elsewhere in the tree (e.g. the
// update-nudge toast) dispatch this event instead of threading dialog state
// through the app shell.

const OPEN_SETTINGS_EVENT = "worktable:open-settings"

interface OpenSettingsDetail {
  section?: SettingsSectionId
}

export function openSettings(section?: SettingsSectionId): void {
  window.dispatchEvent(
    new CustomEvent<OpenSettingsDetail>(OPEN_SETTINGS_EVENT, {
      detail: { section },
    })
  )
}

/** Subscribe to openSettings calls; returns the unsubscribe function. */
export function onOpenSettings(
  handler: (section?: SettingsSectionId) => void
): () => void {
  const listener = (event: Event) => {
    handler((event as CustomEvent<OpenSettingsDetail>).detail?.section)
  }
  window.addEventListener(OPEN_SETTINGS_EVENT, listener)
  return () => window.removeEventListener(OPEN_SETTINGS_EVENT, listener)
}

// Read imperatively when an operation finishes: its visible status should not
// also announce itself in a toast. SettingsBody owns this lifetime.
let visibleSection: SettingsSectionId | null = null

export function markSettingsSectionVisible(
  section: SettingsSectionId
): () => void {
  visibleSection = section
  return () => {
    if (visibleSection === section) visibleSection = null
  }
}

export function getVisibleSettingsSection(): SettingsSectionId | null {
  return visibleSection
}
