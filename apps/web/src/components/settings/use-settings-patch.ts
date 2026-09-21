import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "@worktable/ui/components/sonner"
import {
  patchSettings,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@/lib/system-api"
import { SETTINGS_QUERY_KEY } from "@/hooks/use-server-settings"

// Shared mutation for every settings toggle: optimistically flip the cached
// value so the switch responds instantly, and adopt the server's merged result
// on success (it's authoritative). On failure we do NOT restore the pre-mutate
// snapshot — with two in-flight patches from different sections, an earlier
// failure's snapshot would wipe the later patch's server-confirmed value.
// Refetching the server state converges the cache no matter how the in-flight
// mutations interleave.
export function useSettingsPatch() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (patch: ServerSettingsPatch) => patchSettings(patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: SETTINGS_QUERY_KEY })
      const previous =
        queryClient.getQueryData<ServerSettings>(SETTINGS_QUERY_KEY)
      if (previous) {
        queryClient.setQueryData<ServerSettings>(SETTINGS_QUERY_KEY, {
          ...previous,
          updates: { ...previous.updates, ...patch.updates },
          editor: { ...previous.editor, ...patch.editor },
          network: { ...previous.network, ...patch.network },
          history: { ...previous.history, ...patch.history },
        })
      }
    },
    onError: (err) => {
      void queryClient.invalidateQueries({ queryKey: SETTINGS_QUERY_KEY })
      toast.error(
        err instanceof Error ? err.message : "Couldn't save the setting."
      )
    },
    onSuccess: (settings) => {
      queryClient.setQueryData(SETTINGS_QUERY_KEY, settings)
    },
  })
}
