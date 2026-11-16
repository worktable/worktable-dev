import { lazy, Suspense, useEffect, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useHelpEnabled } from "@/hooks/use-deployment-info"
import { onOpenWelcome } from "@/lib/help/welcome-open"
import { welcomeRole, welcomesOnItsOwn } from "@/lib/help/welcome"
import {
  GETTING_STARTED_SPACE_ID,
  saveSetup,
  usePersonalSetup,
} from "@/lib/setup"

const WelcomeDialog = lazy(() =>
  import("./welcome-dialog").then((module) => ({
    default: module.WelcomeDialog,
  }))
)

/**
 * The welcome inside the app: for someone joining a team, who skips setup,
 * and from Settings > Help's Show Again for anyone. Setup shows the owner's.
 */
export function WelcomeHost() {
  const enabled = useHelpEnabled()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { workspace, person, setup } = usePersonalSetup()
  const [again, setAgain] = useState(false)
  // Closed now, before the saved choice comes back.
  const [finished, setFinished] = useState(false)
  useEffect(() => onOpenWelcome(() => setAgain(true)), [])

  const first =
    !finished &&
    welcomesOnItsOwn({
      enabled,
      welcomed: setup.welcomed,
      role: person?.role,
      where: "app",
    })
  if (!enabled || !person || !(again || first)) return null

  return (
    <Suspense fallback={null}>
      <WelcomeDialog
        key={again ? "again" : "first"}
        role={welcomeRole(person.role)}
        team={workspace?.name ?? ""}
        finishLabel={again ? "Done" : "Connect Your Agent"}
        onFinish={() => {
          setAgain(false)
          setFinished(true)
          // A failed save only means it opens once more another time.
          if (!setup.welcomed)
            void saveSetup(queryClient, { welcomed: true }).catch(() => {})
          // Connecting is in Getting Started for people who join.
          if (!again)
            void navigate({
              to: "/spaces/$spaceId",
              params: { spaceId: GETTING_STARTED_SPACE_ID },
            })
        }}
      />
    </Suspense>
  )
}
