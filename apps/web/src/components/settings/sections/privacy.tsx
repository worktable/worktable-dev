import { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { SettingRow } from "@worktable/ui/components/setting-row"
import { Switch } from "@worktable/ui/components/switch"
import { getAnalyticsContext } from "@/lib/analytics"

// The Privacy section: the Cloud account's usage analytics choice. The
// dialog header names the section, so the lone card carries no heading.
export function PrivacySection() {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ["cloud", "analytics"],
    queryFn: () => getAnalyticsContext(),
    staleTime: 0,
  })
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(false)
  const change = async (enabled: boolean) => {
    setPending(true)
    setError(false)
    try {
      const result = await getAnalyticsContext({ enabled })
      if (!result?.preference) throw new Error("Unavailable")
      queryClient.setQueryData(["cloud", "analytics"], result)
      const consent = await import("@worktable/public-analytics/consent")
      consent.setBrowserAnalyticsPreference(result.preference)
      if (!enabled) window.dispatchEvent(new Event("worktable:analytics-stop"))
      await query.refetch()
      window.dispatchEvent(new Event("worktable:account-analytics-preference"))
    } catch {
      setError(true)
    } finally {
      setPending(false)
    }
  }
  // Analytics is on until someone turns it off, so no saved choice reads as on.
  return (
    <div className="flex flex-col gap-1 rounded-xl card-surface p-4">
      <SettingRow
        label="Share usage analytics"
        description="Helps us improve Worktable. Includes your connected agents. Analytics never sees your content."
      >
        <Switch
          checked={
            query.data ? query.data.preference?.enabled !== false : false
          }
          disabled={pending || query.isLoading || !query.data}
          onCheckedChange={(enabled) => void change(enabled)}
        />
      </SettingRow>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          Couldn’t save your analytics choice. Try again.
        </p>
      ) : query.isError || (!query.isLoading && !query.data) ? (
        <p role="alert" className="text-sm text-destructive">
          Couldn’t load analytics settings. Try again.
        </p>
      ) : null}
    </div>
  )
}
