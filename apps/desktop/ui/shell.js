const elements = {
  bootstrap: document.querySelector("#bootstrap"),
  progressMessage: document.querySelector("#progress-message"),
  cancelCloudConnection: document.querySelector("#cancel-cloud-connection"),
  updateTitle: document.querySelector("#update-title"),
  updateMessage: document.querySelector("#update-message"),
  updateVersion: document.querySelector("#update-version"),
  updateProgress: document.querySelector("#update-progress"),
  updateProgressTrack: document.querySelector(".update-progress-track"),
  updateProgressValue: document.querySelector("#update-progress-value"),
  updateProgressLabel: document.querySelector("#update-progress-label"),
  updateNotes: document.querySelector("#update-notes"),
  updateNotesCopy: document.querySelector("#update-notes-copy"),
  installUpdate: document.querySelector("#install-update"),
  retryUpdate: document.querySelector("#retry-update"),
  dismissUpdate: document.querySelector("#dismiss-update"),
  openUpdateDownload: document.querySelector("#open-update-download"),
  chooseLocal: document.querySelector("#choose-local"),
  chooseSelfHosted: document.querySelector("#choose-self-hosted"),
  chooseCloud: document.querySelector("#choose-cloud"),
  providerBack: document.querySelector("#provider-back"),
  remoteProviderBack: document.querySelector("#remote-provider-back"),
  cloudProviderBack: document.querySelector("#cloud-provider-back"),
  cloudStatusMessage: document.querySelector("#cloud-status-message"),
  connectCloud: document.querySelector("#connect-cloud"),
  removeCloudConnection: document.querySelector("#remove-cloud-connection"),
  savedConnectionsSection: document.querySelector("#saved-connections-section"),
  savedConnections: document.querySelector("#saved-connections"),
  remoteConnectionForm: document.querySelector("#remote-connection-form"),
  remoteOrigin: document.querySelector("#remote-origin"),
  remoteOriginMessage: document.querySelector("#remote-origin-message"),
  remoteHttpWarning: document.querySelector("#remote-http-warning"),
  remoteHttpConfirm: document.querySelector("#remote-http-confirm"),
  connectRemote: document.querySelector("#connect-remote"),
  existingInstallation: document.querySelector("#existing-installation"),
  existingInstallationMessage: document.querySelector(
    "#existing-installation-message"
  ),
  existingInstallationPath: document.querySelector(
    "#existing-installation-path"
  ),
  useExistingInstallation: document.querySelector("#use-existing-installation"),
  createPath: document.querySelector("#create-path"),
  createMessage: document.querySelector("#create-message"),
  openMessage: document.querySelector("#open-message"),
  changeCreateLocation: document.querySelector("#change-create-location"),
  createWorkspace: document.querySelector("#create-workspace"),
  openExisting: document.querySelector("#open-existing"),
  recoveryTitle: document.querySelector("#recovery-title"),
  recoveryMessage: document.querySelector("#recovery-message"),
  recoveryWorkspace: document.querySelector("#recovery-workspace"),
  recoveryPath: document.querySelector("#recovery-path"),
  recoveryPrimaryActions: document.querySelector("#recovery-primary-actions"),
  recoverySecondaryActions: document.querySelector(
    "#recovery-secondary-actions"
  ),
  recoveryTroubleshooting: document.querySelector("#recovery-troubleshooting"),
  recoveryUtilityActions: document.querySelector("#recovery-utility-actions"),
  retryConnection: document.querySelector("#retry-connection"),
  restartLocalHost: document.querySelector("#restart-local-host"),
  repairLocalAuthority: document.querySelector("#repair-local-authority"),
  openLocalLogs: document.querySelector("#open-local-logs"),
  locateWorkspace: document.querySelector("#locate-workspace"),
  recoveryChangeWorkspace: document.querySelector("#recovery-change-workspace"),
  removeConnection: document.querySelector("#remove-connection"),
}

let currentStatus = null
let currentUpdaterStatus = null
let selectedCreatePath = ""
let selectedCreateIntent = "create"
let createCandidateValid = true
let busy = false
let updateBusy = false
let openFeedback = { message: "", tone: "neutral" }
let recoveryFeedback = ""
let scrollFadeFrame = 0
let savedConnectionsSignature = ""

const prefersDark = window.matchMedia("(prefers-color-scheme: dark)")
const prefersReducedMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)"
)
const applyTheme = () => {
  document.documentElement.dataset.theme = prefersDark.matches
    ? "dark"
    : "light"
}
applyTheme()
prefersDark.addEventListener("change", applyTheme)

const viewPages = {
  initializing: document.querySelector("#progress-page"),
  progress: document.querySelector("#progress-page"),
  update: document.querySelector("#update-page"),
  providers: document.querySelector("#provider-page"),
  local: document.querySelector("#local-page"),
  remote: document.querySelector("#remote-page"),
  cloud: document.querySelector("#cloud-page"),
  recovery: document.querySelector("#recovery-page"),
}

let viewTransitionTimer = 0

function syncPageAccessibility(activePage) {
  for (const page of new Set(Object.values(viewPages))) {
    const active = page === activePage
    page.inert = !active
    if (active) page.removeAttribute("aria-hidden")
    else page.setAttribute("aria-hidden", "true")
  }
}

function clearViewTransition() {
  if (viewTransitionTimer) window.clearTimeout(viewTransitionTimer)
  viewTransitionTimer = 0
  for (const page of new Set(Object.values(viewPages)))
    page.classList.remove("is-entering", "is-leaving")
  delete document.body.dataset.transitionDirection
}

function setView(nextView, direction = "replace") {
  const currentView = document.body.dataset.view
  if (currentView === nextView) return

  const currentPage = viewPages[currentView]
  const nextPage = viewPages[nextView]
  if (currentPage === nextPage) {
    document.body.dataset.view = nextView
    syncPageAccessibility(nextPage)
    return
  }

  clearViewTransition()
  const animate =
    currentPage &&
    nextPage &&
    currentView !== "ready" &&
    nextView !== "ready" &&
    !prefersReducedMotion.matches

  if (animate) {
    document.body.dataset.transitionDirection = direction
    currentPage.classList.add("is-leaving")
    nextPage.classList.add("is-entering")
  }

  document.body.dataset.view = nextView
  syncPageAccessibility(nextPage)
  scheduleBootstrapScrollFade()

  if (!animate) return
  viewTransitionTimer = window.setTimeout(() => {
    clearViewTransition()
    scheduleBootstrapScrollFade()
  }, 240)
}

function updateBootstrapScrollFade() {
  scrollFadeFrame = 0
  const { scrollTop, scrollHeight, clientHeight } = elements.bootstrap
  if (scrollTop <= 8) delete elements.bootstrap.dataset.scrollTop
  else elements.bootstrap.dataset.scrollTop = "true"
  if (scrollTop + clientHeight >= scrollHeight - 8)
    delete elements.bootstrap.dataset.scrollBottom
  else elements.bootstrap.dataset.scrollBottom = "true"
}

function scheduleBootstrapScrollFade() {
  if (scrollFadeFrame) return
  scrollFadeFrame = window.requestAnimationFrame(updateBootstrapScrollFade)
}

function setupBootstrapScrollFade() {
  elements.bootstrap.addEventListener("scroll", scheduleBootstrapScrollFade, {
    passive: true,
  })
  const resizeObserver = new ResizeObserver(scheduleBootstrapScrollFade)
  resizeObserver.observe(elements.bootstrap)
  for (const page of elements.bootstrap.querySelectorAll(".bootstrap-page"))
    resizeObserver.observe(page)
  new MutationObserver(scheduleBootstrapScrollFade).observe(document.body, {
    attributes: true,
    attributeFilter: ["data-view"],
  })
  updateBootstrapScrollFade()
}

async function invoke(command, args) {
  const tauri = window.__TAURI__
  if (!tauri?.core?.invoke)
    throw new Error("Tauri bridge unavailable in trusted shell")
  return tauri.core.invoke(command, args)
}

function compactPath(path, defaultPath = currentStatus?.defaultPath) {
  if (!path) return ""
  if (defaultPath && path === defaultPath && path.endsWith("/Worktable"))
    return "~/Worktable"
  return path
}

function setBusy(value) {
  busy = value
  document.body.dataset.busy = String(value)
  updateRemoteForm()
}

function setCreateCandidate(path, inspection) {
  selectedCreatePath = path
  elements.createPath.textContent = compactPath(path)
  elements.createPath.title = path
  setCreateFeedback("")
  createCandidateValid = true
  if (inspection?.outcome === "valid") {
    selectedCreateIntent = "open"
    elements.createWorkspace.textContent = "Open Worktable"
    setCreateFeedback(
      `This is already “${inspection.workspace.name}”. Worktable will open it without changing it.`,
      "success"
    )
  } else if (inspection?.outcome === "reject") {
    selectedCreateIntent = "create"
    createCandidateValid = false
    elements.createWorkspace.textContent = "Create Worktable"
    setCreateFeedback(inspection.message, "warning")
  } else {
    selectedCreateIntent = "create"
    elements.createWorkspace.textContent = "Create Worktable"
  }
  elements.createWorkspace.disabled = !createCandidateValid || busy
}

function renderInlineFeedback(element, message, tone = "neutral") {
  element.textContent = message
  element.dataset.tone = message ? tone : "neutral"
}

function setCreateFeedback(message, tone = "neutral") {
  renderInlineFeedback(elements.createMessage, message, tone)
}

function setOpenFeedback(message, tone = "neutral") {
  openFeedback = { message, tone }
  renderInlineFeedback(elements.openMessage, message, tone)
}

function validateRemoteOrigin(value) {
  const input = value.trim()
  if (!/^https?:\/\//i.test(input))
    return {
      message: "Enter a complete address beginning with https:// or http://.",
    }

  let url
  try {
    url = new URL(input)
  } catch {
    return { message: "Enter a valid Worktable address." }
  }

  if (!url.hostname) return { message: "The address must include a host." }
  if (url.username || url.password)
    return {
      message: "The address cannot include a username or password.",
    }
  if (url.pathname !== "/" || url.search || url.hash)
    return {
      message: "Enter the main server address without anything after it.",
    }
  const hostname = url.hostname.toLowerCase()
  if (hostname.includes("*") || ["0.0.0.0", "[::]", "::"].includes(hostname))
    return { message: "Enter a specific server address." }
  if (url.origin === "https://app.worktable.cloud")
    return {
      message: "Use the Worktable Cloud option to connect to this address.",
    }

  return { origin: url.origin, insecure: url.protocol === "http:" }
}

function updateRemoteForm() {
  const validation = validateRemoteOrigin(elements.remoteOrigin.value)
  const hasInput = elements.remoteOrigin.value.trim().length > 0
  const insecure = Boolean(validation.insecure)
  elements.remoteHttpWarning.hidden = !insecure
  if (!insecure) elements.remoteHttpConfirm.checked = false
  renderInlineFeedback(
    elements.remoteOriginMessage,
    validation.message && hasInput ? validation.message : "",
    validation.message && hasInput ? "error" : "neutral"
  )
  elements.connectRemote.disabled =
    busy ||
    !validation.origin ||
    (insecure && !elements.remoteHttpConfirm.checked)
  return validation
}

function prefillRemoteConnection(connection) {
  elements.remoteOrigin.value = connection.origin
  elements.remoteHttpConfirm.checked =
    !connection.requiresInsecureHttpConfirmation
  updateRemoteForm()
  elements.remoteOrigin.focus()
  elements.remoteOrigin.setSelectionRange(
    elements.remoteOrigin.value.length,
    elements.remoteOrigin.value.length
  )
}

function renderSavedConnections(connections = []) {
  const signature = JSON.stringify(connections)
  if (signature === savedConnectionsSignature) return
  savedConnectionsSignature = signature
  elements.savedConnections.replaceChildren()
  elements.savedConnectionsSection.hidden = connections.length === 0

  for (const connection of connections) {
    const row = document.createElement("article")
    row.className = "saved-connection-row"

    const copy = document.createElement("div")
    copy.className = "saved-connection-copy"
    const nameRow = document.createElement("div")
    nameRow.className = "saved-connection-name"
    const name = document.createElement("strong")
    name.textContent = connection.displayName
    nameRow.append(name)
    if (connection.origin.startsWith("http://")) {
      const badge = document.createElement("span")
      badge.className = "connection-badge"
      badge.textContent = "Unencrypted"
      nameRow.append(badge)
    }
    const origin = document.createElement("code")
    origin.textContent = connection.origin
    origin.title = connection.origin
    copy.append(nameRow, origin)

    const actions = document.createElement("div")
    actions.className = "saved-connection-actions"
    const open = document.createElement("button")
    open.className = "button secondary"
    open.type = "button"
    open.textContent = connection.verified ? "Open" : "Finish setup"
    open.addEventListener("click", () => {
      if (!connection.verified) {
        prefillRemoteConnection(connection)
        return
      }
      runAction(() =>
        invoke("desktop_start_saved_connection", {
          profileId: connection.id,
        })
      )
    })
    const forget = document.createElement("button")
    forget.className = "button quiet"
    forget.type = "button"
    forget.textContent = "Forget"
    forget.addEventListener("click", () => {
      if (!window.confirm(`Forget “${connection.displayName}” on this Mac?`))
        return
      runAction(() =>
        invoke("desktop_remove_connection", { profileId: connection.id })
      )
    })
    actions.append(open, forget)
    row.append(copy, actions)
    elements.savedConnections.append(row)
  }
}

function setRecoveryFeedback(message) {
  recoveryFeedback = message
  elements.recoveryMessage.textContent = message
}

function placeRecoveryAction(element, group, label, kind = "secondary") {
  element.textContent = label
  element.className = `button ${kind}`
  element.hidden = false
  group.append(element)
}

function groupHasVisibleActions(group) {
  return [...group.children].some((child) => !child.hidden)
}

function renderRecoveryActions(status) {
  const actions = [
    elements.retryConnection,
    elements.restartLocalHost,
    elements.repairLocalAuthority,
    elements.openLocalLogs,
    elements.locateWorkspace,
    elements.recoveryChangeWorkspace,
    elements.removeConnection,
  ]
  for (const action of actions) action.hidden = true

  if (status.provider === "selfHosted") {
    let primaryAction = elements.recoveryChangeWorkspace
    if (status.canRetry) {
      primaryAction = elements.retryConnection
      placeRecoveryAction(
        primaryAction,
        elements.recoveryPrimaryActions,
        "Try again",
        "primary"
      )
      placeRecoveryAction(
        elements.recoveryChangeWorkspace,
        elements.recoverySecondaryActions,
        "Change connection"
      )
    } else {
      placeRecoveryAction(
        primaryAction,
        elements.recoveryPrimaryActions,
        "Change connection",
        "primary"
      )
    }
    if (status.canRemoveConnection) {
      placeRecoveryAction(
        elements.removeConnection,
        elements.recoverySecondaryActions,
        "Forget this server",
        "quiet"
      )
    }
    elements.recoveryPrimaryActions.hidden = false
    elements.recoverySecondaryActions.hidden = !groupHasVisibleActions(
      elements.recoverySecondaryActions
    )
    elements.recoveryTroubleshooting.hidden = true
    return
  }

  if (status.provider === "cloud") {
    if (status.canRetry) {
      placeRecoveryAction(
        elements.retryConnection,
        elements.recoveryPrimaryActions,
        [
          "AUTHENTICATION_REQUIRED",
          "AUTH_REFRESH_FAILED",
          "UNAUTHORIZED",
          "CREDENTIAL_STORE_FAILED",
        ].includes(status.errorCode)
          ? "Sign in"
          : "Try again",
        "primary"
      )
      placeRecoveryAction(
        elements.recoveryChangeWorkspace,
        elements.recoverySecondaryActions,
        "Change connection"
      )
    } else {
      placeRecoveryAction(
        elements.recoveryChangeWorkspace,
        elements.recoveryPrimaryActions,
        "Change connection",
        "primary"
      )
    }
    if (status.canRemoveConnection) {
      placeRecoveryAction(
        elements.removeConnection,
        elements.recoverySecondaryActions,
        "Remove Cloud connection",
        "quiet"
      )
    }
    elements.recoveryPrimaryActions.hidden = false
    elements.recoverySecondaryActions.hidden = !groupHasVisibleActions(
      elements.recoverySecondaryActions
    )
    elements.recoveryTroubleshooting.hidden = true
    return
  }

  const corruptConnections = status.errorCode === "CORRUPT_CONNECTIONS"
  const unsupportedAuthoritySchema = [
    "LOCAL_RUNTIME_SCHEMA_UNSUPPORTED",
    "LOCAL_REGISTRY_SCHEMA_UNSUPPORTED",
  ].includes(status.errorCode)
  const corruptLocalConfig = status.errorCode === "CONFIG_CORRUPT"
  let primaryAction = null
  if (corruptConnections && status.canRemoveConnection) {
    primaryAction = elements.removeConnection
    placeRecoveryAction(
      primaryAction,
      elements.recoveryPrimaryActions,
      "Reset Desktop setup",
      "primary"
    )
  } else if (status.canRepair) {
    primaryAction = elements.repairLocalAuthority
    placeRecoveryAction(
      primaryAction,
      elements.recoveryPrimaryActions,
      "Repair Worktable",
      "primary"
    )
  } else if (status.canRetry) {
    primaryAction = elements.retryConnection
    placeRecoveryAction(
      primaryAction,
      elements.recoveryPrimaryActions,
      "Try again",
      "primary"
    )
  } else if (status.canRestart) {
    primaryAction = elements.restartLocalHost
    placeRecoveryAction(
      primaryAction,
      elements.recoveryPrimaryActions,
      "Restart local service",
      "primary"
    )
  }

  const canChangeWorkspace =
    !corruptConnections && !corruptLocalConfig && !unsupportedAuthoritySchema
  if (!primaryAction && canChangeWorkspace) {
    primaryAction = elements.recoveryChangeWorkspace
    placeRecoveryAction(
      primaryAction,
      elements.recoveryPrimaryActions,
      "Choose another Worktable",
      "primary"
    )
  } else if (canChangeWorkspace) {
    placeRecoveryAction(
      elements.recoveryChangeWorkspace,
      elements.recoverySecondaryActions,
      "Choose another Worktable"
    )
  }

  if (status.canRestart && primaryAction !== elements.restartLocalHost) {
    placeRecoveryAction(
      elements.restartLocalHost,
      elements.recoveryUtilityActions,
      "Restart local service"
    )
  }
  if (status.canOpenLogs) {
    placeRecoveryAction(
      elements.openLocalLogs,
      elements.recoveryUtilityActions,
      "Open logs"
    )
  }
  if (status.canLocateWorkspace) {
    placeRecoveryAction(
      elements.locateWorkspace,
      elements.recoveryUtilityActions,
      "Find moved Worktable…"
    )
  }
  if (
    status.canRemoveConnection &&
    primaryAction !== elements.removeConnection
  ) {
    placeRecoveryAction(
      elements.removeConnection,
      elements.recoveryUtilityActions,
      "Remove this Worktable",
      "quiet"
    )
  }

  elements.recoveryPrimaryActions.hidden = !primaryAction
  elements.recoverySecondaryActions.hidden = !groupHasVisibleActions(
    elements.recoverySecondaryActions
  )
  elements.recoveryTroubleshooting.hidden = !groupHasVisibleActions(
    elements.recoveryUtilityActions
  )
}

function render(status) {
  const previousState = currentStatus?.state
  const previousErrorCode = currentStatus?.errorCode
  currentStatus = status

  if (status.state === "ready") {
    openFeedback = { message: "", tone: "neutral" }
    recoveryFeedback = ""
    setView("ready")
    return
  }

  if (
    status.state === "initializing" ||
    status.state === "configuringLocal" ||
    status.state === "preparingWorkspace" ||
    status.state === "startingHost" ||
    status.state === "checkingRemote" ||
    status.state === "authenticatingRemote" ||
    status.state === "verifyingConnection" ||
    status.state === "authenticatingCloud" ||
    status.state === "restoringCloud" ||
    status.state === "provisioningCloud"
  ) {
    setView(status.state === "initializing" ? "initializing" : "progress")
    elements.progressMessage.textContent =
      status.message || "Preparing Worktable…"
    elements.cancelCloudConnection.hidden = ![
      "authenticatingCloud",
      "restoringCloud",
      "provisioningCloud",
    ].includes(status.state)
    return
  }
  elements.cancelCloudConnection.hidden = true

  if (status.state === "needsSelection") {
    if (previousState === "ready") {
      selectedCreatePath = ""
      openFeedback = { message: "", tone: "neutral" }
    }
    if (status.provider === "local" && !selectedCreatePath) {
      setCreateCandidate(
        status.defaultPath ?? "",
        status.workspace
          ? { outcome: "valid", workspace: status.workspace }
          : status.errorCode
            ? { outcome: "reject", message: status.message }
            : null
      )
    }
    setView(
      status.provider === "local"
        ? "local"
        : status.provider === "selfHosted"
          ? "remote"
          : status.provider === "cloud"
            ? "cloud"
            : "providers"
    )
    if (status.provider === "cloud") {
      elements.cloudStatusMessage.textContent =
        status.message || "Continue in your browser to sign in."
      elements.connectCloud.textContent = status.connectionProfileId
        ? "Sign in again"
        : "Sign in"
      elements.removeCloudConnection.hidden =
        !status.connectionProfileId || !status.canRemoveConnection
    }
    renderSavedConnections(status.savedConnections)
    if (
      status.provider === "selfHosted" &&
      status.connectionProfileId &&
      !elements.remoteOrigin.value
    ) {
      const incomplete = status.savedConnections.find(
        (connection) => connection.id === status.connectionProfileId
      )
      if (incomplete) prefillRemoteConnection(incomplete)
    }
    if (status.provider !== "local") return
    const existing = status.existingInstallation
    elements.existingInstallation.hidden = !existing
    if (existing) {
      elements.existingInstallationMessage.textContent = `“${existing.workspace.name}” is ready to open.`
      elements.existingInstallationPath.textContent = existing.workspace.path
      elements.existingInstallationPath.title = existing.workspace.path
    }
    renderInlineFeedback(
      elements.openMessage,
      openFeedback.message,
      openFeedback.tone
    )
    return
  }

  setView("recovery")
  elements.recoveryTitle.textContent =
    status.provider === "selfHosted"
      ? "Could not connect"
      : status.provider === "cloud"
        ? "Could not sign in"
        : "Could not open Worktable"
  elements.recoveryMessage.textContent = recoveryFeedback || status.message
  const path =
    status.provider === "selfHosted" || status.provider === "cloud"
      ? (status.origin ?? "")
      : (status.workspace?.path ?? status.selectedPath ?? "")
  elements.recoveryPath.textContent = path
  elements.recoveryPath.title = path
  elements.recoveryWorkspace.hidden = !path
  if (previousState !== status.state || previousErrorCode !== status.errorCode)
    elements.recoveryTroubleshooting.open = false
  renderRecoveryActions(status)
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB"]
  let amount = value
  let unit = 0
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024
    unit += 1
  }
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`
}

function renderUpdater(status) {
  currentUpdaterStatus = status
  setView("update")

  const titles = {
    checking: "Checking for updates",
    available: "Update Worktable",
    downloading: "Update Worktable",
    installing: "Update Worktable",
    current: "You’re up to date!",
    error: "Update incomplete",
    recovery: "Recover Worktable",
  }
  elements.updateTitle.textContent = titles[status.state] ?? "Worktable update"
  elements.updateMessage.textContent = status.message ?? ""

  const version =
    status.availableVersion &&
    `${status.currentVersion} → ${status.availableVersion}`
  elements.updateVersion.hidden = !version
  elements.updateVersion.textContent = version || ""

  const showProgress = ["downloading", "installing"].includes(status.state)
  elements.updateProgress.hidden = !showProgress
  if (showProgress) {
    const total = status.totalBytes
    const percentage =
      total > 0
        ? Math.min(100, Math.round((status.downloadedBytes / total) * 100))
        : status.state === "installing"
          ? 100
          : 0
    if (total > 0) {
      elements.updateProgressValue.style.width = `${percentage}%`
      elements.updateProgressTrack.setAttribute("aria-valuenow", percentage)
      elements.updateProgressTrack.removeAttribute("aria-valuetext")
      elements.updateProgressLabel.textContent = `${formatBytes(status.downloadedBytes)} of ${formatBytes(total)}`
    } else {
      elements.updateProgressValue.style.removeProperty("width")
      elements.updateProgressTrack.removeAttribute("aria-valuenow")
      elements.updateProgressTrack.setAttribute(
        "aria-valuetext",
        status.state === "installing" ? "Installing" : "Downloading"
      )
      elements.updateProgressLabel.textContent =
        status.state === "installing"
          ? "The app will restart when installation is complete."
          : formatBytes(status.downloadedBytes)
    }
  }

  const notes = status.notes?.trim()
  elements.updateNotes.hidden = !notes
  elements.updateNotesCopy.textContent = notes || ""

  elements.installUpdate.hidden = !status.canInstall
  elements.installUpdate.disabled = updateBusy || !status.canInstall
  elements.retryUpdate.hidden = !["error", "recovery"].includes(status.state)
  elements.retryUpdate.disabled = updateBusy
  elements.dismissUpdate.hidden = !status.canDismiss
  elements.dismissUpdate.disabled = updateBusy
  elements.dismissUpdate.textContent =
    status.state === "available" ? "Later" : "Return to Worktable"
  elements.openUpdateDownload.hidden = !["error", "recovery"].includes(
    status.state
  )
  elements.openUpdateDownload.disabled = updateBusy
}

async function checkTrustBoundary() {
  try {
    const identity = await invoke("desktop_shell_identity")
    if (
      identity.surface !== "trusted-shell" ||
      identity.nativeCapabilities !== true
    ) {
      throw new Error("Unexpected trusted-shell identity")
    }
    await invoke("desktop_mark_shell_ready")
    document.body.dataset.nativeBoundary = "verified"
  } catch (error) {
    document.body.dataset.nativeBoundary = "error"
    console.error(
      error instanceof Error ? error.message : "Native boundary check failed"
    )
  }
}

async function refreshStatus() {
  try {
    const [bootstrapStatus, updaterStatus] = await Promise.all([
      invoke("desktop_bootstrap_state"),
      invoke("desktop_updater_state"),
    ])
    currentUpdaterStatus = updaterStatus
    if (updaterStatus.surfaceVisible) {
      renderUpdater(updaterStatus)
      return
    }
    render(bootstrapStatus)
  } catch (error) {
    setView("recovery")
    elements.recoveryMessage.textContent =
      error instanceof Error ? error.message : "Desktop status unavailable"
  }
}

async function runUpdateAction(action) {
  if (updateBusy) return
  updateBusy = true
  let actionError = ""
  if (currentUpdaterStatus) renderUpdater(currentUpdaterStatus)
  try {
    await action()
    await refreshStatus()
  } catch (error) {
    actionError = error instanceof Error ? error.message : String(error)
  } finally {
    updateBusy = false
    if (currentUpdaterStatus?.surfaceVisible)
      renderUpdater(currentUpdaterStatus)
    if (actionError) elements.updateMessage.textContent = actionError
  }
}

async function chooseFolder() {
  return invoke("desktop_choose_workspace_folder")
}

async function inspect(path) {
  return invoke("desktop_inspect_workspace", { path })
}

async function runAction(action, onError = setRecoveryFeedback) {
  if (busy) return
  setBusy(true)
  try {
    const shouldRefresh = await action()
    if (shouldRefresh !== false) await refreshStatus()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    onError(message, "error")
    await refreshStatus()
  } finally {
    setBusy(false)
    elements.createWorkspace.disabled = !createCandidateValid
  }
}

elements.chooseLocal.addEventListener("click", () =>
  runAction(() =>
    invoke("desktop_select_connection_provider", { provider: "local" })
  )
)

elements.chooseSelfHosted.addEventListener("click", () =>
  runAction(() =>
    invoke("desktop_select_connection_provider", { provider: "selfHosted" })
  )
)

elements.chooseCloud.addEventListener("click", () =>
  runAction(() =>
    invoke("desktop_select_connection_provider", { provider: "cloud" })
  )
)

elements.providerBack.addEventListener("click", () =>
  runAction(() =>
    invoke("desktop_select_connection_provider", { provider: null })
  )
)

elements.remoteProviderBack.addEventListener("click", () =>
  runAction(() =>
    invoke("desktop_select_connection_provider", { provider: null })
  )
)

elements.cloudProviderBack.addEventListener("click", () =>
  runAction(() =>
    invoke("desktop_select_connection_provider", { provider: null })
  )
)

elements.connectCloud.addEventListener("click", () =>
  runAction(() => invoke("desktop_start_cloud_connection"))
)

elements.removeCloudConnection.addEventListener("click", () =>
  removeCurrentConnection()
)

elements.cancelCloudConnection.addEventListener("click", async () => {
  if (
    !["authenticatingCloud", "restoringCloud", "provisioningCloud"].includes(
      currentStatus?.state
    )
  ) {
    return
  }
  try {
    await invoke("desktop_cancel_cloud_connection")
    await refreshStatus()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    setRecoveryFeedback(message, "error")
  }
})

elements.remoteOrigin.addEventListener("input", updateRemoteForm)
elements.remoteHttpConfirm.addEventListener("change", updateRemoteForm)
elements.remoteConnectionForm.addEventListener("submit", (event) => {
  event.preventDefault()
  const validation = updateRemoteForm()
  if (!validation.origin || elements.connectRemote.disabled) {
    elements.remoteOrigin.focus()
    return
  }
  runAction(
    () =>
      invoke("desktop_start_self_hosted_connection", {
        origin: validation.origin,
        allowInsecureHttp: validation.insecure,
      }),
    (message) =>
      renderInlineFeedback(elements.remoteOriginMessage, message, "error")
  )
})

elements.useExistingInstallation.addEventListener("click", () =>
  runAction(() => invoke("desktop_use_existing_installation"))
)

elements.changeCreateLocation.addEventListener("click", () =>
  runAction(async () => {
    setOpenFeedback("")
    const path = await chooseFolder()
    if (!path) return false
    const inspection = await inspect(path)
    setCreateCandidate(path, inspection)
    return false
  }, setCreateFeedback)
)

elements.createWorkspace.addEventListener("click", () =>
  runAction(async () => {
    if (!selectedCreatePath || !createCandidateValid) return
    setOpenFeedback("")
    await invoke("desktop_start_local_connection", {
      intent: selectedCreateIntent,
      path: selectedCreatePath,
    })
  }, setCreateFeedback)
)

elements.openExisting.addEventListener("click", () =>
  runAction(async () => {
    setOpenFeedback("")
    const path = await chooseFolder()
    if (!path) return false
    const inspection = await inspect(path)
    if (inspection.outcome === "valid") {
      await invoke("desktop_start_local_connection", { intent: "open", path })
      return
    }
    if (inspection.outcome === "missing" || inspection.outcome === "empty") {
      setOpenFeedback(
        "That folder doesn’t contain Worktable yet. You can create one there instead.",
        "info"
      )
      setCreateCandidate(path, inspection)
      elements.createWorkspace.focus()
      return false
    }
    setOpenFeedback(inspection.message, "warning")
    return false
  }, setOpenFeedback)
)

elements.retryConnection.addEventListener("click", () =>
  runAction(() => {
    setRecoveryFeedback("")
    return invoke("desktop_retry_connection")
  })
)

elements.restartLocalHost.addEventListener("click", () =>
  runAction(() => {
    setRecoveryFeedback("")
    return invoke("desktop_restart_local_host")
  })
)

elements.repairLocalAuthority.addEventListener("click", () =>
  runAction(() => {
    setRecoveryFeedback("")
    return invoke("desktop_repair_local_authority")
  })
)

elements.openLocalLogs.addEventListener("click", () =>
  runAction(async () => {
    await invoke("desktop_open_local_logs")
    return false
  })
)

elements.locateWorkspace.addEventListener("click", () =>
  runAction(async () => {
    const path = await chooseFolder()
    if (!path) return false
    const inspection = await inspect(path)
    if (inspection.outcome !== "valid") {
      setRecoveryFeedback(
        inspection.outcome === "reject"
          ? inspection.message
          : "That folder doesn’t contain Worktable."
      )
      return false
    }
    if (
      currentStatus?.workspace?.id &&
      inspection.workspace.id !== currentStatus.workspace.id
    ) {
      setRecoveryFeedback(
        `That folder contains “${inspection.workspace.name}”, not the saved Worktable. Choose another Worktable if you want to switch.`
      )
      return false
    }
    setRecoveryFeedback("")
    await invoke("desktop_start_local_connection", { intent: "open", path })
  })
)

elements.recoveryChangeWorkspace.addEventListener("click", () =>
  runAction(async () => {
    selectedCreatePath = ""
    openFeedback = { message: "", tone: "neutral" }
    recoveryFeedback = ""
    await invoke("desktop_change_connection")
  })
)

function removeCurrentConnection() {
  const corrupt = currentStatus?.errorCode === "CORRUPT_CONNECTIONS"
  const remote = currentStatus?.provider === "selfHosted"
  const cloud = currentStatus?.provider === "cloud"
  const confirmed = window.confirm(
    corrupt
      ? "Reset Desktop setup? The unreadable connection file will be preserved for recovery."
      : remote
        ? "Forget this server on this Mac? Its Worktable session will be removed."
        : cloud
          ? "Remove this Cloud connection from this Mac? You’ll need to sign in again to reconnect."
          : "Remove this saved connection? Your files will not be changed."
  )
  if (!confirmed) return
  runAction(async () => {
    selectedCreatePath = ""
    openFeedback = { message: "", tone: "neutral" }
    recoveryFeedback = ""
    await invoke("desktop_remove_connection", {
      profileId: currentStatus?.connectionProfileId ?? null,
    })
  })
}

elements.removeConnection.addEventListener("click", () =>
  removeCurrentConnection()
)

elements.installUpdate.addEventListener("click", () =>
  runUpdateAction(() => invoke("desktop_install_update"))
)

elements.retryUpdate.addEventListener("click", () =>
  runUpdateAction(() => invoke("desktop_check_for_updates"))
)

elements.dismissUpdate.addEventListener("click", () =>
  runUpdateAction(() => invoke("desktop_dismiss_update"))
)

elements.openUpdateDownload.addEventListener("click", () =>
  runUpdateAction(async () => {
    await invoke("desktop_open_update_download")
    return false
  })
)

void checkTrustBoundary()
syncPageAccessibility(viewPages[document.body.dataset.view])
setupBootstrapScrollFade()
updateRemoteForm()
void refreshStatus()
window.setInterval(refreshStatus, 400)
