import { SettingRow } from "@worktable/ui/components/setting-row"
import { Switch } from "@worktable/ui/components/switch"
import { useServerSettings } from "@/hooks/use-server-settings"
import { useSettingsPatch } from "../use-settings-patch"

// The Editor section, server-backed via GET/PUT /api/system/settings. (A
// "prefer Markdown" toggle was considered and cut: storage picks the format
// from the input type — string → .md, blocks → .json — so there is no
// discretionary branch for a preference to bias.)
export function EditorSection() {
  const settingsQuery = useServerSettings()
  const patch = useSettingsPatch()
  const settings = settingsQuery.data
  // While the query is unresolved the switch is disabled so a click can't
  // patch against an unknown baseline.
  const pending = !settings || patch.isPending

  return (
    // The dialog's content header already names the section, and this lone
    // group has no sibling to disambiguate from — no group heading.
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1 rounded-xl border border-border bg-card p-4">
        {settingsQuery.isError ? (
          <p className="text-sm text-muted-foreground">
            Editor settings require owner access.
          </p>
        ) : (
          <SettingRow
            label="Spellcheck"
            description="Underline misspelled words."
          >
            <Switch
              checked={settings?.editor.spellcheck ?? false}
              disabled={pending}
              onCheckedChange={(v) =>
                patch.mutate({ editor: { spellcheck: v } })
              }
            />
          </SettingRow>
        )}
      </div>
    </section>
  )
}
