import { expect, test, type Page } from "@playwright/test"

interface BootstrapStatus {
  state: string
  provider?: string | null
  message?: string
  errorCode?: string
  origin?: string
  connectionProfileId?: string
  defaultPath?: string
  workspace?: { id: string; name: string; path: string }
  savedConnections?: unknown[]
  canRepair?: boolean
  canRetry?: boolean
  canRestart?: boolean
  canOpenLogs?: boolean
  canLocateWorkspace?: boolean
  canRemoveConnection?: boolean
}

interface UpdaterStatus {
  state: string
  surfaceVisible?: boolean
  currentVersion: string
  availableVersion?: string | null
  notes?: string | null
  downloadedBytes?: number
  totalBytes?: number | null
  message?: string
  canCheck?: boolean
  canInstall?: boolean
  canDismiss?: boolean
}

async function installTauriBoundary(
  page: Page,
  initialStatus: BootstrapStatus,
  initialUpdaterStatus: UpdaterStatus = {
    state: "idle",
    surfaceVisible: false,
    currentVersion: "0.0.45",
  }
): Promise<void> {
  await page.addInitScript(
    ({ status, updaterStatus }) => {
      const calls: Array<{ command: string; args: unknown }> = []
      let current = status
      let currentUpdater = {
        ...updaterStatus,
        surfaceVisible:
          updaterStatus.surfaceVisible ?? updaterStatus.state !== "idle",
      }
      Object.assign(window, {
        __desktopCalls: calls,
        __TAURI__: {
          core: {
            invoke: async (command: string, args: unknown) => {
              calls.push({ command, args })
              if (command === "desktop_shell_identity") {
                return { surface: "trusted-shell", nativeCapabilities: true }
              }
              if (command === "desktop_mark_shell_ready") return
              if (command === "desktop_bootstrap_state") return current
              if (command === "desktop_updater_state") return currentUpdater
              if (command === "desktop_dismiss_update") {
                currentUpdater = {
                  state: "idle",
                  surfaceVisible: false,
                  currentVersion: currentUpdater.currentVersion,
                }
                return
              }
              if (command === "desktop_install_update") {
                currentUpdater = {
                  ...currentUpdater,
                  state: "downloading",
                  surfaceVisible: true,
                  downloadedBytes: 0,
                  totalBytes: null,
                  canInstall: false,
                  canDismiss: false,
                }
                return
              }
              if (command === "desktop_select_connection_provider") {
                const provider = (args as { provider: string | null }).provider
                current = {
                  state: "needsSelection",
                  provider,
                  defaultPath: "/Users/test/Worktable",
                  savedConnections: [],
                }
                return
              }
              if (command === "desktop_choose_workspace_folder") {
                return "/Users/test/Existing"
              }
              if (command === "desktop_inspect_workspace") {
                return {
                  outcome: "valid",
                  workspace: {
                    id: "ws_existing",
                    name: "Existing",
                    path: "/Users/test/Existing",
                  },
                }
              }
              if (
                command === "desktop_start_local_connection" ||
                command === "desktop_start_self_hosted_connection"
              ) {
                current = { state: "ready", provider: "local" }
                return
              }
              if (command === "desktop_start_cloud_connection") {
                current = {
                  state: "authenticatingCloud",
                  provider: "cloud",
                  message: "Finish signing in through your system browser.",
                }
                return
              }
              if (command === "desktop_cancel_cloud_connection") {
                current = {
                  state: "needsSelection",
                  provider: "cloud",
                  message: "Cloud sign-in was cancelled.",
                }
                return
              }
              return false
            },
          },
        },
      })
    },
    {
      status: initialStatus,
      updaterStatus: initialUpdaterStatus,
    }
  )
}

async function desktopCalls(
  page: Page
): Promise<Array<{ command: string; args: unknown }>> {
  return page.evaluate(
    () =>
      (
        window as typeof window & {
          __desktopCalls: Array<{ command: string; args: unknown }>
        }
      ).__desktopCalls
  )
}

test("selects and opens an existing local workspace through the Tauri boundary", async ({
  page,
}) => {
  await installTauriBoundary(page, {
    state: "needsSelection",
    provider: null,
    savedConnections: [],
  })
  await page.goto("/")
  await expect(page.locator("body")).toHaveAttribute(
    "data-native-boundary",
    "verified"
  )
  expect(await desktopCalls(page)).toContainEqual({
    command: "desktop_mark_shell_ready",
    args: undefined,
  })

  await page.getByRole("button", { name: /On this Mac/ }).click()
  await expect(
    page.getByRole("heading", { name: "Set up Worktable" })
  ).toBeVisible()
  await page.getByRole("button", { name: "Change location" }).click()
  await expect(
    page.getByRole("button", { name: "Open Worktable" })
  ).toBeVisible()
  await page.getByRole("button", { name: "Open Worktable" }).click()

  await expect
    .poll(async () =>
      (await desktopCalls(page)).some(
        ({ command }) => command === "desktop_start_local_connection"
      )
    )
    .toBe(true)
  expect(await desktopCalls(page)).toContainEqual({
    command: "desktop_start_local_connection",
    args: { intent: "open", path: "/Users/test/Existing" },
  })
})

test("requires explicit confirmation before an HTTP self-hosted connection", async ({
  page,
}) => {
  await installTauriBoundary(page, {
    state: "needsSelection",
    provider: null,
    savedConnections: [],
  })
  await page.goto("/")
  await page.getByRole("button", { name: /Self-hosted/ }).click()
  const address = page.getByLabel("Worktable address")
  await address.fill("http://worktable.example.test")
  const connect = page.getByRole("button", { name: "Connect", exact: true })
  await expect(connect).toBeDisabled()
  await page
    .getByRole("checkbox", { name: /Continue with this address/ })
    .check()
  await connect.click()

  expect(await desktopCalls(page)).toContainEqual({
    command: "desktop_start_self_hosted_connection",
    args: {
      origin: "http://worktable.example.test",
      allowInsecureHttp: true,
    },
  })
})

test("starts native Cloud sign-in only through the trusted Tauri boundary", async ({
  page,
}) => {
  await installTauriBoundary(page, {
    state: "needsSelection",
    provider: null,
    savedConnections: [],
  })
  await page.goto("/")

  await page.getByRole("button", { name: /Worktable Cloud/ }).click()
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible()
  await expect(
    page.getByText("Continue in your browser to sign in.")
  ).toBeVisible()
  await page.getByRole("button", { name: "Sign in", exact: true }).click()

  expect(await desktopCalls(page)).toContainEqual({
    command: "desktop_start_cloud_connection",
    args: undefined,
  })
  await expect(page.locator("body")).toHaveAttribute("data-view", "progress")
  await expect(
    page.getByText("Finish signing in through your system browser.")
  ).toBeVisible()
})

test("can cancel an active native Cloud connection without leaving the trusted shell", async ({
  page,
}) => {
  await installTauriBoundary(page, {
    state: "authenticatingCloud",
    provider: "cloud",
    message: "Continue signing in through your browser.",
    savedConnections: [],
  })
  await page.goto("/")

  await page.getByRole("button", { name: "Cancel", exact: true }).click()

  expect(await desktopCalls(page)).toContainEqual({
    command: "desktop_cancel_cloud_connection",
    args: undefined,
  })
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible()
  await expect(page.getByText("Cloud sign-in was cancelled.")).toBeVisible()
})

test("removes a saved Cloud profile directly from the Cloud selection", async ({
  page,
}) => {
  await installTauriBoundary(page, {
    state: "needsSelection",
    provider: "cloud",
    message: "Sign in to reopen this workspace.",
    connectionProfileId: "cloud:user_owner",
    canRemoveConnection: true,
    savedConnections: [],
  })
  page.on("dialog", (dialog) => dialog.accept())
  await page.goto("/")

  const remove = page.getByRole("button", {
    name: "Remove connection",
  })
  await expect(remove).toBeVisible()
  await remove.click()

  await expect
    .poll(async () =>
      (await desktopCalls(page)).some(
        ({ command }) => command === "desktop_remove_connection"
      )
    )
    .toBe(true)
  expect(await desktopCalls(page)).toContainEqual({
    command: "desktop_remove_connection",
    args: { profileId: "cloud:user_owner" },
  })
})

test("routes the public production Cloud origin away from self-hosted setup", async ({
  page,
}) => {
  await installTauriBoundary(page, {
    state: "needsSelection",
    provider: "selfHosted",
    savedConnections: [],
  })
  await page.goto("/")
  const address = page.getByLabel("Worktable address")

  await address.fill("https://app.worktable.cloud")
  await expect(page.getByText(/Use the Worktable Cloud option/)).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Connect", exact: true })
  ).toBeDisabled()
})

test("keeps terminal Cloud failures fail-closed while allowing removal", async ({
  page,
}) => {
  await installTauriBoundary(page, {
    state: "error",
    provider: "cloud",
    message: "This Desktop client does not match Worktable Cloud.",
    errorCode: "CLOUD_CONFIGURATION_INVALID",
    origin: "https://app.worktable.cloud",
    connectionProfileId: "cloud:user_owner",
    canRetry: false,
    canRemoveConnection: true,
  })
  await page.goto("/")

  await expect(
    page.getByRole("heading", { name: "Could not sign in" })
  ).toBeVisible()
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "Change connection" })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Remove Cloud connection" })
  ).toBeVisible()
})

test("offers native reauthentication after a rejected Cloud refresh", async ({
  page,
}) => {
  await installTauriBoundary(page, {
    state: "recovery",
    provider: "cloud",
    message: "Sign in to Worktable Cloud on this Mac.",
    errorCode: "AUTH_REFRESH_FAILED",
    origin: "https://app.worktable.cloud",
    connectionProfileId: "cloud:user_owner",
    canRetry: true,
    canRemoveConnection: true,
  })
  await page.goto("/")

  await page.getByRole("button", { name: "Sign in", exact: true }).click()

  expect(await desktopCalls(page)).toContainEqual({
    command: "desktop_retry_connection",
    args: undefined,
  })
})

test("offers native reauthentication after a rejected Cloud session", async ({
  page,
}) => {
  await installTauriBoundary(page, {
    state: "recovery",
    provider: "cloud",
    message: "Desktop authentication is required.",
    errorCode: "UNAUTHORIZED",
    origin: "https://app.worktable.cloud",
    connectionProfileId: "cloud:user_owner",
    canRetry: true,
    canRemoveConnection: true,
  })
  await page.goto("/")

  await page.getByRole("button", { name: "Sign in", exact: true }).click()

  expect(await desktopCalls(page)).toContainEqual({
    command: "desktop_retry_connection",
    args: undefined,
  })
})

test("offers upgrade-only recovery for a newer local-authority schema", async ({
  page,
}) => {
  await installTauriBoundary(page, {
    state: "error",
    provider: "local",
    message: "Update Worktable Desktop to continue.",
    errorCode: "LOCAL_RUNTIME_SCHEMA_UNSUPPORTED",
    canRepair: false,
    canRetry: false,
    canRestart: false,
    canOpenLogs: false,
    canLocateWorkspace: false,
    canRemoveConnection: false,
  })
  await page.goto("/")

  await expect(
    page.getByRole("heading", { name: "Could not open Worktable" })
  ).toBeVisible()
  await expect(page.getByRole("alert")).toContainText(
    "Update Worktable Desktop"
  )
  await expect(
    page.getByRole("button", { name: /Repair|Try again|Choose another/ })
  ).toHaveCount(0)
})

test("prompts before downloading a newer signed Desktop release", async ({
  page,
}) => {
  await installTauriBoundary(
    page,
    {
      state: "ready",
      provider: "local",
    },
    {
      state: "available",
      currentVersion: "0.0.45",
      availableVersion: "0.0.46",
      notes: "Native Worktable Cloud.",
      message: "Worktable 0.0.46 is ready to download.",
      downloadedBytes: 0,
      totalBytes: null,
      canCheck: false,
      canInstall: true,
      canDismiss: true,
    }
  )
  await page.goto("/")

  await expect(
    page.getByRole("heading", { name: "Update Worktable" })
  ).toBeVisible()
  await expect(page.getByText("0.0.45 → 0.0.46")).toBeVisible()
  await expect(page.getByText("Native Worktable Cloud.")).toBeVisible()
  await expect(page.getByRole("button", { name: "Check again" })).toBeHidden()
  await expect(
    page.getByRole("button", { name: "Download Worktable" })
  ).toBeHidden()
  expect(await desktopCalls(page)).not.toContainEqual({
    command: "desktop_install_update",
    args: undefined,
  })

  await page.getByRole("button", { name: "Later" }).click()
  await expect
    .poll(async () =>
      (await desktopCalls(page)).some(
        ({ command }) => command === "desktop_dismiss_update"
      )
    )
    .toBe(true)
  expect(await desktopCalls(page)).toContainEqual({
    command: "desktop_dismiss_update",
    args: undefined,
  })
})

test("keeps a silent startup update check behind the ready workspace", async ({
  page,
}) => {
  await installTauriBoundary(
    page,
    {
      state: "ready",
      provider: "local",
    },
    {
      state: "checking",
      surfaceVisible: false,
      currentVersion: "0.0.45",
      message: "",
      canDismiss: false,
    }
  )
  await page.goto("/")

  await expect(page.locator("body")).toHaveAttribute("data-view", "ready")
  await expect(
    page.getByRole("heading", { name: "Checking for updates" })
  ).toBeHidden()
})

test("does not allow a manual check to be dismissed while in flight", async ({
  page,
}) => {
  await installTauriBoundary(
    page,
    {
      state: "ready",
      provider: "local",
    },
    {
      state: "checking",
      surfaceVisible: true,
      currentVersion: "0.0.45",
      message: "",
      canDismiss: false,
    }
  )
  await page.goto("/")

  await expect(
    page.getByRole("heading", { name: "Checking for updates" })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Return to Worktable" })
  ).toBeHidden()
})

test("starts download and restart only after explicit approval", async ({
  page,
}) => {
  await installTauriBoundary(
    page,
    {
      state: "ready",
      provider: "local",
    },
    {
      state: "available",
      currentVersion: "0.0.45",
      availableVersion: "0.0.46",
      message: "Worktable 0.0.46 is ready to download.",
      notes: "Added\n\n• Signed Desktop updates.",
      canInstall: true,
      canDismiss: true,
    }
  )
  await page.goto("/")
  await page.getByRole("button", { name: "Download and Restart" }).click()

  expect(await desktopCalls(page)).toContainEqual({
    command: "desktop_install_update",
    args: undefined,
  })
  await expect(
    page.getByRole("heading", { name: "Update Worktable" })
  ).toBeVisible()
  await expect(
    page.getByRole("progressbar", { name: "Update download" })
  ).not.toHaveAttribute("aria-valuenow")
})
