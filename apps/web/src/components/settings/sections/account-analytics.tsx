import { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Switch } from "@worktable/ui/components/switch"
import { getAnalyticsContext } from "@/lib/analytics"

export function AccountAnalyticsSettings() {
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
  return (
    <>
      <h3 className="text-sm font-medium text-foreground">Privacy</h3>
      <div className="flex items-start justify-between gap-4 rounded-xl border border-border bg-card p-4">
        <div className="min-w-0">
          <label
            htmlFor="account-analytics"
            className="text-sm font-medium text-foreground"
          >
            Help improve Worktable
          </label>
          <p
            id="account-analytics-description"
            className="mt-1 text-sm text-muted-foreground"
          >
            Share usage analytics from your Cloud account and connected agents.
            We never collect your content. You can change this at any time.
          </p>
          {error && (
            <p role="alert" className="mt-2 text-sm text-destructive">
              Couldn’t save your analytics choice. Try again.
            </p>
          )}
          {!error && (query.isError || (!query.isLoading && !query.data)) && (
            <p role="alert" className="mt-2 text-sm text-destructive">
              Couldn’t load analytics settings. Try again.
            </p>
          )}
        </div>
        <Switch
          id="account-analytics"
          aria-label="Help improve Worktable"
          aria-describedby="account-analytics-description"
          checked={query.data?.preference?.enabled === true}
          disabled={pending || query.isLoading || !query.data}
          onCheckedChange={(enabled) => void change(enabled)}
        />
      </div>
    </>
  )
}
