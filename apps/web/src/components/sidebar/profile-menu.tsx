import { useEffect, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { LogOut, Monitor, Moon, SlidersHorizontal, Sun, UserRound } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@worktable/ui/components/dropdown-menu"
import { ConfirmDialog } from "@worktable/ui/components/confirm-dialog"
import { toast } from "@worktable/ui/components/sonner"
import { useTheme } from "@/components/theme-provider"
import { useDeploymentInfo } from "@/hooks/use-deployment-info"
import type { WorkspaceInfo } from "@/lib/api"
import { submitCloudLogout } from "@/lib/cloud-logout"
import { queryKeys, useWorkspace } from "@/lib/queries"
import { runtimePath } from "@/lib/runtime-path"
import { openSettings } from "@/lib/settings-open"
import { profileStorageKey, signOutLocalTeam } from "@/lib/team-context"

type SignOut = NonNullable<NonNullable<WorkspaceInfo["person"]>["signOut"]>

async function signOutWithPassword(): Promise<void> {
  const response = await fetch(runtimePath("/auth/logout"), {
    method: "POST",
    credentials: "include",
  })
  if (!response.ok) throw new Error("Could not sign out. Try again.")
  const channel =
    typeof BroadcastChannel !== "undefined"
      ? new BroadcastChannel("worktable-auth")
      : null
  channel?.postMessage({ type: "logout" })
  channel?.close()
  window.location.replace(runtimePath("/login"))
}

const SIGN_OUT: Record<SignOut, () => Promise<void>> = {
  cloud: submitCloudLogout,
  team: signOutLocalTeam,
  password: signOutWithPassword,
}

export function PersonAvatar({
  name,
  size = "sm",
}: {
  name: string
  size?: "sm" | "lg"
}) {
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center rounded-full bg-surface-tint font-semibold text-sidebar-foreground ${
        size === "lg" ? "size-9 text-sm" : "size-6 text-[11px]"
      }`}
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  )
}

/** Who is signed in here, opening what concerns them. */
export function ProfileMenu() {
  const queryClient = useQueryClient()
  const { data: workspace } = useWorkspace()
  // A rename in another tab updates this person's profile mirror; read the
  // name the sidebar shows again.
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key !== profileStorageKey()) return
      void queryClient.invalidateQueries({
        queryKey: queryKeys.workspace,
        exact: true,
      })
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [queryClient])
  const { data: deployment } = useDeploymentInfo()
  const { theme, setTheme } = useTheme()
  const [confirming, setConfirming] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const person = workspace?.person
  if (!person) return <div className="min-w-0 flex-1" />

  const role = person.role === "owner" ? "Owner" : "Member"
  const desktop = document.documentElement.hasAttribute("data-worktable-desktop")
  // Desktop keeps Cloud sign-out in its own menu, where it ends Desktop's
  // session too; the page cannot.
  const signOut: SignOut | null =
    deployment?.mode === "cloud" ? (desktop ? null : "cloud") : person.signOut

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label={`${person.name}, ${role}`}
              className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-180 hover:bg-sidebar-hover data-[popup-open]:bg-sidebar-accent"
            />
          }
        >
          <PersonAvatar name={person.name} />
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-[13px] font-medium text-sidebar-foreground">
              {person.name}
            </span>
            <span className="block truncate text-[11px] text-sidebar-foreground/50">
              {role}
            </span>
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" sideOffset={6} className="min-w-60">
          <div className="flex items-center gap-2.5 px-2 py-2">
            <PersonAvatar name={person.name} size="lg" />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{person.name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {role} · {workspace?.name}
              </p>
            </div>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => openSettings("profile")}>
            <UserRound className="mr-2 size-4" />
            Profile
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => openSettings("appearance")}>
            <SlidersHorizontal className="mr-2 size-4" />
            Preferences
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup
            value={theme}
            onValueChange={(value) => setTheme(value as typeof theme)}
          >
            <DropdownMenuRadioItem value="light">
              <Sun className="mr-2 size-4" />
              Light
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dark">
              <Moon className="mr-2 size-4" />
              Dark
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="system">
              <Monitor className="mr-2 size-4" />
              System
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          {signOut && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setConfirming(true)}>
                <LogOut className="mr-2 size-4" />
                Sign Out
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {signOut && (
        <ConfirmDialog
          open={confirming}
          onOpenChange={(open) => {
            if (!signingOut) setConfirming(open)
          }}
          title="Sign out of Worktable?"
          description="This signs you out on this browser. Your agents stay connected and your data stays intact."
          confirmLabel="Sign out"
          loadingLabel="Signing out…"
          loading={signingOut}
          icon={<LogOut className="size-5 text-primary" />}
          onConfirm={async () => {
            setSigningOut(true)
            try {
              await SIGN_OUT[signOut]()
            } catch (error) {
              setSigningOut(false)
              toast.error(error instanceof Error ? error.message : "Could not sign out")
            }
          }}
        />
      )}
    </>
  )
}
