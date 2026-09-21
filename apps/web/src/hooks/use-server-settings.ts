import { useQuery } from "@tanstack/react-query"
import { getSettings } from "@/lib/system-api"

// Single source for the server-settings query — shared by the Settings sections
// and the editor (spellcheck). One key so an optimistic patch and the editor
// read the same cache entry.
export const SETTINGS_QUERY_KEY = ["system", "settings"] as const

export function useServerSettings() {
  return useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: getSettings,
    // Settings change rarely; keep them warm so opening the dialog (or mounting
    // an editor) doesn't refetch on every navigation.
    staleTime: 5 * 60_000,
  })
}
