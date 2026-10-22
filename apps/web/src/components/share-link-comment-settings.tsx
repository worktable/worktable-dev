import { useId } from "react"
import type { ShareLinkCommentSettings } from "@worktable/types"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@worktable/ui/components/select"
import { SettingRow } from "@worktable/ui/components/setting-row"
import { Switch } from "@worktable/ui/components/switch"

export function ShareLinkCommentSettingsFields({value, onChange, disabled, allowAll, container}: {
  value: ShareLinkCommentSettings
  onChange: (value: ShareLinkCommentSettings) => void
  disabled: boolean
  allowAll: boolean
  container?: HTMLElement | null
}) {
  const id = useId()
  return <div className="space-y-3">
    <SettingRow label="Accept comments"><Switch aria-label="Accept comments" checked={value.acceptComments} disabled={disabled} onCheckedChange={acceptComments => onChange({...value, acceptComments})} /></SettingRow>
    <SettingRow label="Allow anonymous comments"><Switch aria-label="Allow anonymous comments" checked={value.anonymousAllowed} disabled={disabled} onCheckedChange={anonymousAllowed => onChange({...value, anonymousAllowed})} /></SettingRow>
    <SettingRow label="Show sharer’s name in replies"><Switch aria-label="Show sharer’s name in replies" checked={value.showSharerName} disabled={disabled} onCheckedChange={showSharerName => onChange({...value, showSharerName})} /></SettingRow>
    <div className="space-y-2">
      <label id={id} className="text-sm font-medium">Visitors see</label>
      <Select value={allowAll ? value.visitorsSee : "own"} disabled={disabled || !allowAll} onValueChange={visitorsSee => {if (visitorsSee) onChange({...value, visitorsSee})}}>
        <SelectTrigger aria-labelledby={id}><SelectValue>{allowAll && value.visitorsSee === "all" ? "All comments on this link" : "Only their own comments"}</SelectValue></SelectTrigger>
        <SelectContent container={container}><SelectItem value="own">Only their own comments</SelectItem><SelectItem value="all">All comments on this link</SelectItem></SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{!allowAll ? "Owners have limited visitors to their own comments." : value.visitorsSee === "all" ? "Anyone with this link can see every visitor’s comment and name." : "Each visitor sees their comments and the team’s replies."}</p>
    </div>
  </div>
}
