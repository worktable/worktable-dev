import { useEffect } from "react"
import { useRouterState } from "@tanstack/react-router"
import { useDeploymentInfo } from "@/hooks/use-deployment-info"
import { noteScreen, screenOfRoute } from "@/lib/screen-views"

/** Notes each screen a person shows on Cloud; nothing elsewhere. */
export function ScreenViews({ settingsOpen }: { settingsOpen: boolean }) {
  const cloud = useDeploymentInfo().data?.capabilities.analyticsChoice === true
  const routeId = useRouterState({ select: (state) => state.matches.at(-1)?.routeId })
  useEffect(() => {
    if (!cloud) return
    noteScreen(settingsOpen ? "settings" : screenOfRoute(routeId))
  }, [cloud, routeId, settingsOpen])
  return null
}
