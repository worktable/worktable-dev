#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cloud_auth;
mod connections;
mod credential_store;
mod host_cookie;
mod remote_connection;
mod updater;

use cloud_auth::{
    CloudAuthController, CloudAuthError, CloudUser, CloudWebViewSession, WORKTABLE_CLOUD_ORIGIN,
};
use connections::{
    connections_path, persist_connections_for_boot, quarantine_connections,
    read_connections_for_boot, resolve_saved_workspace, DesktopConnectionProfile,
    DesktopConnections, InspectionEnvelope, PreparationEnvelope, SavedWorkspaceResolution,
    WorkspaceInspection, WorkspacePrepared,
};
use credential_store::system_credential_store;
use host_cookie::{purge_persisted_host_only_cookie, set_host_only_cookie};
use remote_connection::{
    normalize_remote_origin, remote_origin_string, validate_remote_origin, RemoteConnectionError,
    RemoteHttpClient, RemoteWorkspace, WorkspaceProbe,
};
use serde::{Deserialize, Serialize};
#[cfg(test)]
use std::net::TcpListener;
use std::{
    env,
    fs::OpenOptions,
    io::{Read, Write},
    net::{TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    process,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{
        Menu, MenuItemBuilder, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
    },
    path::BaseDirectory,
    webview::{
        Cookie, DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder,
        WebviewWindowBuilder,
    },
    AppHandle, Manager, Runtime, State, Webview, WebviewUrl, WindowEvent,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
#[cfg(all(target_os = "macos", not(feature = "staging")))]
use tauri_plugin_updater::UpdaterExt;
#[cfg(all(target_os = "macos", not(feature = "staging")))]
use updater::now_rfc3339;
use updater::{now_epoch_seconds, versioned_dmg_url, DesktopUpdaterState, DesktopUpdaterStatus};

const TRUSTED_WEBVIEW_LABEL: &str = "trusted-shell";
const WORKSPACE_WEBVIEW_LABEL: &str = "workspace";
// A WebviewWindow uses one label for both the native window and its content
// webview. Keeping the trusted shell as that content view avoids leaving Tao's
// cursor-owning placeholder view underneath every workspace WKWebView.
const WINDOW_LABEL: &str = TRUSTED_WEBVIEW_LABEL;
const WORKSPACE_BOUNDARY_TITLE_PREFIX: &str = "__WORKTABLE_DESKTOP_BOUNDARY__:";
// WebKit may coalesce very short-lived document-title changes before the
// native callback observes them. Keep the unprivileged-boundary result visible
// long enough for the callback and packaged release smoke test to consume it.
const WORKSPACE_BOUNDARY_REPORT_MS: u64 = 1_000;
const WORKSPACE_MENU_ID: &str = "workspace";
const SHOW_WORKTABLE_MENU_ID: &str = "window.show-worktable";
const SWITCH_WORKSPACE_MENU_ID: &str = "workspace.switch";
const REVEAL_WORKSPACE_MENU_ID: &str = "workspace.reveal";
const CLOUD_SIGN_OUT_MENU_ID: &str = "workspace.cloud-sign-out";
const CLOUD_END_SESSION_MENU_ID: &str = "workspace.cloud-end-session";
const CHECK_UPDATES_MENU_ID: &str = "help.check-updates";
const HEALTH_TIMEOUT: Duration = Duration::from_secs(25);
const SEED_TIMEOUT: Duration = Duration::from_secs(30);
const HTTP_READ_TIMEOUT: Duration = Duration::from_millis(700);
const SEED_HTTP_READ_TIMEOUT: Duration = Duration::from_secs(5);
const ATTACHED_HOST_MONITOR_INTERVAL: Duration = Duration::from_secs(2);
const ATTACHED_HOST_FAILURE_LIMIT: u8 = 3;
const MAX_HTTP_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const REMOTE_MONITOR_INTERVAL: Duration = Duration::from_secs(15);
const REMOTE_FAILURE_LIMIT: u8 = 3;
const LOCAL_MACHINE_CONTRACT_SCHEMA_VERSION: u8 = 1;
const DESKTOP_SKILL_TARGET_IDS: [&str; 2] = ["claude", "agents"];
const DESKTOP_SKILL_OPERATIONS: [&str; 4] = ["install", "update", "repair", "remove"];
#[cfg(all(target_os = "macos", not(feature = "staging")))]
const AUTOMATIC_UPDATE_CHECK_DELAY: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopShellIdentity {
    surface: &'static str,
    native_capabilities: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopWorkspaceSummary {
    id: String,
    name: String,
    path: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSavedConnectionSummary {
    id: String,
    provider: &'static str,
    display_name: String,
    origin: String,
    verified: bool,
    requires_insecure_http_confirmation: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopExistingInstallation {
    workspace: DesktopWorkspaceSummary,
    origin: String,
    running: bool,
    owner: Option<String>,
    service_installed: bool,
    service_state: String,
    logs_path: String,
    requires_owner_login: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopBootstrapStatus {
    state: &'static str,
    message: String,
    origin: Option<String>,
    provider: Option<&'static str>,
    default_path: Option<String>,
    selected_path: Option<String>,
    workspace: Option<DesktopWorkspaceSummary>,
    existing_installation: Option<DesktopExistingInstallation>,
    error_code: Option<String>,
    can_retry: bool,
    can_restart: bool,
    can_repair: bool,
    can_open_logs: bool,
    can_locate_workspace: bool,
    can_remove_connection: bool,
    connection_profile_id: Option<String>,
    saved_connections: Vec<DesktopSavedConnectionSummary>,
    workspace_native_commands: &'static str,
}

impl DesktopBootstrapStatus {
    fn base(state: &'static str, message: impl Into<String>) -> Self {
        Self {
            state,
            message: message.into(),
            origin: None,
            provider: None,
            default_path: None,
            selected_path: None,
            workspace: None,
            existing_installation: None,
            error_code: None,
            can_retry: false,
            can_restart: false,
            can_repair: false,
            can_open_logs: false,
            can_locate_workspace: false,
            can_remove_connection: false,
            connection_profile_id: None,
            saved_connections: Vec::new(),
            workspace_native_commands: "pending",
        }
    }

    fn selection(inspection: WorkspaceInspection) -> Self {
        let mut status = Self::base("needsSelection", "Choose where this Worktable lives.");
        status.provider = Some("local");
        status.default_path = Some(inspection.path().to_string());
        match inspection {
            WorkspaceInspection::Valid { path, workspace } => {
                status.workspace = Some(DesktopWorkspaceSummary {
                    id: workspace.id,
                    name: workspace.name,
                    path: Some(path),
                });
            }
            WorkspaceInspection::Reject { message, .. } => {
                status.message = message;
                status.error_code = Some("DEFAULT_WORKSPACE_UNAVAILABLE".into());
            }
            WorkspaceInspection::Missing { .. } | WorkspaceInspection::Empty { .. } => {}
        }
        status
    }

    fn provider_selection() -> Self {
        Self::base("needsSelection", "Choose where this Worktable lives.")
    }

    fn self_hosted_selection() -> Self {
        let mut status = Self::base(
            "needsSelection",
            "Choose a saved server or enter a Worktable address.",
        );
        status.provider = Some("selfHosted");
        status
    }

    fn cloud_selection(message: impl Into<String>, profile_id: Option<String>) -> Self {
        let mut status = Self::base("needsSelection", message);
        status.provider = Some("cloud");
        status.origin = Some(WORKTABLE_CLOUD_ORIGIN.into());
        status.connection_profile_id = profile_id;
        status.can_remove_connection = status.connection_profile_id.is_some();
        status
    }

    fn progress(state: &'static str, message: impl Into<String>, path: &str) -> Self {
        let mut status = Self::base(state, message);
        status.provider = Some("local");
        status.selected_path = Some(path.to_string());
        status
    }

    fn ready(origin: String, workspace: DesktopWorkspaceSummary) -> Self {
        let mut status = Self::base("ready", "Local workspace connected");
        status.origin = Some(origin);
        status.provider = Some("local");
        status.selected_path = workspace.path.clone();
        status.workspace = Some(workspace);
        status.can_retry = true;
        status
    }

    fn remote_ready(
        origin: String,
        profile_id: String,
        workspace: DesktopWorkspaceSummary,
    ) -> Self {
        let mut status = Self::base("ready", "Self-hosted Worktable connected");
        status.origin = Some(origin);
        status.provider = Some("selfHosted");
        status.connection_profile_id = Some(profile_id);
        status.workspace = Some(workspace);
        status.can_retry = true;
        status.can_remove_connection = true;
        status
    }

    fn remote_progress(
        state: &'static str,
        message: impl Into<String>,
        origin: String,
        profile_id: Option<String>,
    ) -> Self {
        let mut status = Self::base(state, message);
        status.origin = Some(origin);
        status.provider = Some("selfHosted");
        status.connection_profile_id = profile_id;
        status
    }

    fn remote_recovery(
        message: impl Into<String>,
        code: &'static str,
        origin: String,
        profile_id: Option<String>,
        workspace: Option<DesktopWorkspaceSummary>,
        can_retry: bool,
    ) -> Self {
        let mut status = Self::base("recovery", message);
        status.origin = Some(origin);
        status.provider = Some("selfHosted");
        status.connection_profile_id = profile_id;
        status.workspace = workspace;
        status.error_code = Some(code.into());
        status.can_retry = can_retry;
        status.can_remove_connection = status.connection_profile_id.is_some();
        status
    }

    fn recovery(
        message: impl Into<String>,
        code: &'static str,
        workspace: Option<DesktopWorkspaceSummary>,
        can_retry: bool,
    ) -> Self {
        let mut status = Self::base("recovery", message);
        status.provider = Some("local");
        status.error_code = Some(code.into());
        status.can_retry = can_retry;
        status.selected_path = workspace.as_ref().and_then(|item| item.path.clone());
        status.workspace = workspace;
        status
    }

    fn error(
        message: impl Into<String>,
        origin: Option<String>,
        workspace: Option<DesktopWorkspaceSummary>,
        can_retry: bool,
    ) -> Self {
        let mut status = Self::base("recoverableError", message);
        status.origin = origin;
        status.provider = Some("local");
        status.selected_path = workspace.as_ref().and_then(|item| item.path.clone());
        status.workspace = workspace;
        status.error_code = Some("CONNECTION_FAILED".into());
        status.can_retry = can_retry;
        status.can_restart = can_retry;
        status.can_open_logs = can_retry;
        status
    }

    fn cloud_progress(
        state: &'static str,
        message: impl Into<String>,
        profile_id: Option<String>,
    ) -> Self {
        let mut status = Self::base(state, message);
        status.provider = Some("cloud");
        status.origin = Some(WORKTABLE_CLOUD_ORIGIN.into());
        status.connection_profile_id = profile_id;
        status
    }

    fn cloud_ready(profile_id: String, workspace: DesktopWorkspaceSummary) -> Self {
        let mut status = Self::base("ready", "Worktable Cloud connected");
        status.provider = Some("cloud");
        status.origin = Some(WORKTABLE_CLOUD_ORIGIN.into());
        status.connection_profile_id = Some(profile_id);
        status.workspace = Some(workspace);
        status.can_retry = true;
        status.can_remove_connection = true;
        status
    }

    fn cloud_recovery(
        error: &CloudAuthError,
        profile_id: Option<String>,
        workspace: Option<DesktopWorkspaceSummary>,
    ) -> Self {
        let mut status = Self::base("recovery", error.message.clone());
        status.provider = Some("cloud");
        status.origin = Some(WORKTABLE_CLOUD_ORIGIN.into());
        status.connection_profile_id = profile_id;
        status.workspace = workspace;
        status.error_code = Some(error.code.clone());
        status.can_retry = error.retryable
            || matches!(
                error.code.as_str(),
                "AUTHENTICATION_REQUIRED"
                    | "AUTH_REFRESH_FAILED"
                    | "UNAUTHORIZED"
                    | "AUTH_IDENTITY_MISMATCH"
                    | "CREDENTIAL_STORE_FAILED"
            );
        status.can_remove_connection = status.connection_profile_id.is_some();
        status
    }

    fn with_remove_connection(mut self) -> Self {
        self.can_remove_connection = true;
        self
    }

    fn with_saved_connection_recovery(mut self) -> Self {
        self.can_locate_workspace = true;
        self.can_remove_connection = true;
        self
    }
}

#[derive(Clone, Debug)]
struct PackagedRuntimeLayout {
    release_root: PathBuf,
    static_root: PathBuf,
    version: String,
}

#[derive(Debug, Deserialize)]
struct PackagedRuntimeManifest {
    version: String,
}

impl PackagedRuntimeLayout {
    fn resolve<R: Runtime>(app: &tauri::App<R>) -> Result<Self, String> {
        let release_root = app
            .path()
            .resolve("worktable-runtime", BaseDirectory::Resource)
            .map_err(|error| format!("failed to resolve packaged Worktable resources: {error}"))?;
        let manifest_path = release_root.join("manifest.json");
        let manifest: PackagedRuntimeManifest =
            serde_json::from_str(&std::fs::read_to_string(&manifest_path).map_err(|error| {
                format!(
                    "failed to read packaged Worktable manifest {}: {error}",
                    manifest_path.display()
                )
            })?)
            .map_err(|error| {
                format!(
                    "failed to parse packaged Worktable manifest {}: {error}",
                    manifest_path.display()
                )
            })?;
        if manifest.version.trim().is_empty() {
            return Err("packaged Worktable manifest has an empty version".into());
        }
        let static_root = release_root.join("web");
        Ok(Self {
            release_root,
            static_root,
            version: manifest.version,
        })
    }
}

#[derive(Clone, Debug)]
struct DesktopRuntime {
    shell_data_root: PathBuf,
    local_app_data_root: Option<PathBuf>,
    packaged: PackagedRuntimeLayout,
}

impl DesktopRuntime {
    fn resolve<R: Runtime>(app: &tauri::App<R>) -> Result<Self, String> {
        let shell_data_root = env::var_os("WORKTABLE_DESKTOP_APP_DIR")
            .map(PathBuf::from)
            .map(Ok)
            .unwrap_or_else(|| app.path().app_data_dir().map(|path| path.join("host")))
            .map_err(|error| format!("failed to resolve desktop app data: {error}"))?;
        let local_app_data_root = env::var_os("WORKTABLE_DESKTOP_LOCAL_APP_DIR").map(PathBuf::from);
        Ok(Self {
            shell_data_root,
            local_app_data_root,
            packaged: PackagedRuntimeLayout::resolve(app)?,
        })
    }
}

#[derive(Clone, Debug)]
struct LocalHostConfig {
    instance_token: String,
    verification_token: String,
    runtime: DesktopRuntime,
}

impl LocalHostConfig {
    fn sidecar_args(&self, workspace: &str, host: &str, port: u16) -> Vec<String> {
        vec![
            "launch".into(),
            "--foreground".into(),
            "--no-browser".into(),
            "--workspace".into(),
            workspace.into(),
            "--host".into(),
            host.into(),
            "--port".into(),
            port.to_string(),
        ]
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalActivationWorkspace {
    id: String,
    name: String,
    path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalActivationError {
    code: Option<String>,
    message: String,
}

#[derive(Debug)]
struct LocalAuthorityCommandError {
    code: Option<String>,
    message: String,
}

impl LocalAuthorityCommandError {
    fn untyped(message: impl Into<String>) -> Self {
        Self {
            code: None,
            message: message.into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalActivationEnvelope {
    schema_version: u8,
    ok: bool,
    action: Option<String>,
    workspace: Option<LocalActivationWorkspace>,
    host: Option<String>,
    port: Option<u16>,
    origin: Option<String>,
    logs_path: Option<String>,
    error: Option<LocalActivationError>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalAuthorityConfig {
    workspace: String,
    host: String,
    port: u16,
    origin: String,
    requires_owner_login: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalAuthorityRuntime {
    owner: String,
    workspace_id: String,
    workspace_path: String,
    host: String,
    port: u16,
    endpoint_verified: bool,
}

#[derive(Clone, Debug, Deserialize)]
struct LocalAuthorityLogs {
    stdout: String,
}

#[derive(Clone, Debug, Deserialize)]
struct LocalAuthorityHostLogs {
    desktop: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalAuthorityService {
    installed: bool,
    state: String,
    logs: LocalAuthorityLogs,
}

#[derive(Clone, Debug, Deserialize)]
struct LocalAuthorityActivation {
    pending: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalAuthorityInspection {
    schema_version: u8,
    ok: bool,
    configured: Option<bool>,
    config: Option<LocalAuthorityConfig>,
    registry_error: Option<String>,
    registry_error_code: Option<String>,
    runtime: Option<LocalAuthorityRuntime>,
    runtime_error: Option<String>,
    runtime_error_code: Option<String>,
    service: Option<LocalAuthorityService>,
    activation: Option<LocalAuthorityActivation>,
    logs: Option<LocalAuthorityHostLogs>,
    error: Option<LocalActivationError>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalRestartEnvelope {
    schema_version: u8,
    ok: bool,
    action: Option<String>,
    error: Option<LocalActivationError>,
}

#[derive(Clone, Debug)]
struct PendingRemoteConnection {
    origin: String,
    profile_id: Option<String>,
    expected_workspace_id: Option<String>,
    allow_insecure_http: bool,
}

struct DesktopHostState {
    runtime: Mutex<Option<DesktopRuntime>>,
    child: Mutex<Option<CommandChild>>,
    status: Mutex<DesktopBootstrapStatus>,
    connections: Mutex<DesktopConnections>,
    pending_local: Mutex<Option<WorkspacePrepared>>,
    pending_remote: Mutex<Option<PendingRemoteConnection>>,
    remote_http: Mutex<Option<RemoteHttpClient>>,
    operation_in_progress: Mutex<bool>,
    active_instance_token: Mutex<Option<String>>,
    workspace_native_commands: Mutex<&'static str>,
    picker_directory_hint: Mutex<Option<PathBuf>>,
    connection_generation: AtomicU64,
    connection_changed: tokio::sync::Notify,
    cloud_cookie_refresh_pending: AtomicU64,
    cloud_cookie_refresh_at: AtomicU64,
    cloud_cookie_operation: Mutex<()>,
    cloud_refresh_operation: tokio::sync::Mutex<()>,
    cloud_connection_commit: Mutex<()>,
    cloud_connection_started_with_profile: AtomicBool,
    trusted_shell_ready: AtomicBool,
    connections_loaded: AtomicBool,
    connections_migration_pending: AtomicBool,
    healthy_boot_completed: AtomicBool,
    healthy_boot_transition: Mutex<()>,
    remote_probe_in_progress: AtomicBool,
    shutdown_started: AtomicBool,
}

impl Default for DesktopHostState {
    fn default() -> Self {
        Self {
            runtime: Mutex::new(None),
            child: Mutex::new(None),
            status: Mutex::new(DesktopBootstrapStatus::base(
                "initializing",
                "Preparing Worktable…",
            )),
            connections: Mutex::new(DesktopConnections::default()),
            pending_local: Mutex::new(None),
            pending_remote: Mutex::new(None),
            remote_http: Mutex::new(None),
            operation_in_progress: Mutex::new(false),
            active_instance_token: Mutex::new(None),
            workspace_native_commands: Mutex::new("pending"),
            picker_directory_hint: Mutex::new(picker_directory_hint_from_env()),
            connection_generation: AtomicU64::new(0),
            connection_changed: tokio::sync::Notify::new(),
            cloud_cookie_refresh_pending: AtomicU64::new(0),
            cloud_cookie_refresh_at: AtomicU64::new(0),
            cloud_cookie_operation: Mutex::new(()),
            cloud_refresh_operation: tokio::sync::Mutex::new(()),
            cloud_connection_commit: Mutex::new(()),
            cloud_connection_started_with_profile: AtomicBool::new(false),
            trusted_shell_ready: AtomicBool::new(false),
            connections_loaded: AtomicBool::new(false),
            connections_migration_pending: AtomicBool::new(false),
            healthy_boot_completed: AtomicBool::new(false),
            healthy_boot_transition: Mutex::new(()),
            remote_probe_in_progress: AtomicBool::new(false),
            shutdown_started: AtomicBool::new(false),
        }
    }
}

fn canonical_picker_directory(path: &Path) -> Option<PathBuf> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return None;
    }
    path.canonicalize().ok()
}

fn picker_directory_hint_from_env() -> Option<PathBuf> {
    env::var_os("WORKTABLE_DESKTOP_PICKER_DIRECTORY")
        .map(PathBuf::from)
        .as_deref()
        .and_then(canonical_picker_directory)
}

fn nearest_existing_picker_directory(path: &Path) -> Option<PathBuf> {
    let mut candidate = path.to_path_buf();
    loop {
        if let Some(directory) = canonical_picker_directory(&candidate) {
            return Some(directory);
        }
        if !candidate.pop() {
            return None;
        }
    }
}

fn picker_start_directory(hint: Option<&Path>, proposed: Option<&Path>) -> Option<PathBuf> {
    hint.and_then(canonical_picker_directory).or_else(|| {
        proposed.and_then(|path| {
            if path.is_file() {
                path.parent().and_then(nearest_existing_picker_directory)
            } else {
                nearest_existing_picker_directory(path)
            }
        })
    })
}

fn update_picker_hint_after_selection(hint: &mut Option<PathBuf>, selected: bool) {
    if selected {
        *hint = None;
    }
}

fn require_trusted_surface(webview: &Webview) -> Result<(), String> {
    if webview.label() == TRUSTED_WEBVIEW_LABEL {
        Ok(())
    } else {
        Err(format!(
            "native command denied for webview '{}'",
            webview.label()
        ))
    }
}

fn trusted_local_agent_skill_origin(
    current_url: &tauri::Url,
    expected_origin: &tauri::Url,
) -> bool {
    let trusted_scheme = matches!(expected_origin.scheme(), "http" | "https");
    let trusted_host = expected_origin.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("localhost")
            || host
                .parse::<std::net::IpAddr>()
                .is_ok_and(|address| address.is_loopback())
    });
    trusted_scheme && trusted_host && same_workspace_origin(current_url, expected_origin)
}

fn desktop_agent_skill_workspace_allowed(
    label: &str,
    status: &str,
    provider: Option<&str>,
    current_url: &tauri::Url,
    expected_origin: &tauri::Url,
) -> bool {
    label == WORKSPACE_WEBVIEW_LABEL
        && status == "ready"
        && provider == Some("local")
        && trusted_local_agent_skill_origin(current_url, expected_origin)
}

fn require_desktop_agent_skill_surface(
    webview: &Webview,
    state: &DesktopHostState,
) -> Result<(), String> {
    if webview.label() == TRUSTED_WEBVIEW_LABEL {
        return Ok(());
    }
    if webview.label() != WORKSPACE_WEBVIEW_LABEL {
        return Err(format!(
            "native agent skill command denied for webview '{}'",
            webview.label()
        ));
    }
    let (status_name, provider, expected_origin) = {
        let status = state
            .status
            .lock()
            .map_err(|_| "desktop status lock is poisoned".to_string())?;
        (
            status.state,
            status.provider,
            status
                .origin
                .clone()
                .ok_or_else(|| "the active local Desktop origin is unavailable".to_string())?,
        )
    };
    let expected_origin = expected_origin
        .parse::<tauri::Url>()
        .map_err(|_| "the active local Desktop origin is invalid".to_string())?;
    let current_url = webview
        .url()
        .map_err(|_| "the active Desktop workspace URL is unavailable".to_string())?;
    if desktop_agent_skill_workspace_allowed(
        webview.label(),
        status_name,
        provider,
        &current_url,
        &expected_origin,
    ) {
        Ok(())
    } else {
        Err(
            "native agent skill command requires the active local Desktop workspace and origin"
                .into(),
        )
    }
}

#[tauri::command]
fn desktop_shell_identity(webview: Webview) -> Result<DesktopShellIdentity, String> {
    require_trusted_surface(&webview)?;
    Ok(DesktopShellIdentity {
        surface: TRUSTED_WEBVIEW_LABEL,
        native_capabilities: true,
    })
}

#[tauri::command]
fn desktop_bootstrap_state(
    webview: Webview,
    state: State<'_, DesktopHostState>,
) -> Result<DesktopBootstrapStatus, String> {
    require_trusted_surface(&webview)?;
    let mut status = state
        .status
        .lock()
        .map(|status| status.clone())
        .map_err(|_| "desktop status lock is poisoned".to_string())?;
    status.workspace_native_commands = *state
        .workspace_native_commands
        .lock()
        .map_err(|_| "workspace boundary lock is poisoned".to_string())?;
    Ok(status)
}

#[tauri::command]
fn desktop_updater_state(
    webview: Webview,
    state: State<'_, DesktopUpdaterState>,
) -> Result<DesktopUpdaterStatus, String> {
    require_trusted_surface(&webview)?;
    state.snapshot()
}

#[tauri::command]
fn desktop_mark_shell_ready(webview: Webview, app: AppHandle) -> Result<(), String> {
    require_trusted_surface(&webview)?;
    app.state::<DesktopHostState>()
        .trusted_shell_ready
        .store(true, Ordering::SeqCst);
    if let Err(error) = complete_healthy_desktop_boot(&app) {
        eprintln!("[Worktable Desktop] failed to finish the healthy boot transition: {error}");
    }
    schedule_automatic_update_check(app);
    Ok(())
}

fn complete_healthy_desktop_boot<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = app.state::<DesktopHostState>();
    if state.healthy_boot_completed.load(Ordering::SeqCst) {
        return Ok(());
    }
    if !healthy_desktop_boot_ready(
        state.trusted_shell_ready.load(Ordering::SeqCst),
        state.connections_loaded.load(Ordering::SeqCst),
        desktop_connection_boot_ready(&state)?,
    ) {
        return Ok(());
    }
    let _transition = state
        .healthy_boot_transition
        .lock()
        .map_err(|_| "healthy Desktop boot transition lock is poisoned".to_string())?;
    if state.healthy_boot_completed.load(Ordering::SeqCst) {
        return Ok(());
    }
    if !healthy_desktop_boot_ready(
        state.trusted_shell_ready.load(Ordering::SeqCst),
        state.connections_loaded.load(Ordering::SeqCst),
        desktop_connection_boot_ready(&state)?,
    ) {
        return Ok(());
    }
    app.state::<DesktopUpdaterState>().mark_healthy_boot()?;
    if state.connections_migration_pending.load(Ordering::SeqCst) {
        let runtime = runtime_for(app)?;
        let connections = state
            .connections
            .lock()
            .map_err(|_| "desktop connections lock is poisoned".to_string())?
            .clone();
        let migration_pending = persist_connections_for_boot(
            &connections_path(&runtime.shell_data_root),
            &connections,
            true,
            true,
        )?;
        state
            .connections_migration_pending
            .store(migration_pending, Ordering::SeqCst);
    }
    state.healthy_boot_completed.store(true, Ordering::SeqCst);
    Ok(())
}

fn desktop_connection_boot_ready(state: &DesktopHostState) -> Result<bool, String> {
    let status = state
        .status
        .lock()
        .map_err(|_| "desktop status lock is poisoned".to_string())?
        .clone();
    let has_active_connection = state
        .connections
        .lock()
        .map_err(|_| "desktop connections lock is poisoned".to_string())?
        .active_profile_id
        .is_some();
    Ok(desktop_connection_status_ready_for_healthy_boot(
        &status,
        has_active_connection,
    ))
}

fn desktop_connection_status_ready_for_healthy_boot(
    status: &DesktopBootstrapStatus,
    has_active_connection: bool,
) -> bool {
    status.state == "ready"
        || (status.state == "needsSelection"
            && status.connection_profile_id.is_none()
            && !has_active_connection)
}

fn healthy_desktop_boot_ready(
    trusted_shell_ready: bool,
    connections_loaded: bool,
    connection_boot_ready: bool,
) -> bool {
    trusted_shell_ready && connections_loaded && connection_boot_ready
}

fn persist_desktop_connections(app: &AppHandle, next: DesktopConnections) -> Result<(), String> {
    let state = app.state::<DesktopHostState>();
    let _transition = state
        .healthy_boot_transition
        .lock()
        .map_err(|_| "healthy Desktop boot transition lock is poisoned".to_string())?;
    let migration_pending = state.connections_migration_pending.load(Ordering::SeqCst);
    let runtime = runtime_for(app)?;
    let mut current = state
        .connections
        .lock()
        .map_err(|_| "desktop connections lock is poisoned".to_string())?;
    let migration_pending = persist_connections_for_boot(
        &connections_path(&runtime.shell_data_root),
        &next,
        migration_pending,
        false,
    )?;
    *current = next;
    state
        .connections_migration_pending
        .store(migration_pending, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
async fn desktop_check_for_updates(webview: Webview, app: AppHandle) -> Result<(), String> {
    require_trusted_surface(&webview)?;
    run_updater_check(app, true).await
}

#[tauri::command]
async fn desktop_install_update(webview: Webview, app: AppHandle) -> Result<(), String> {
    require_trusted_surface(&webview)?;
    install_available_update(app).await
}

#[tauri::command]
fn desktop_dismiss_update(webview: Webview, app: AppHandle) -> Result<(), String> {
    require_trusted_surface(&webview)?;
    app.state::<DesktopUpdaterState>()
        .dismiss(now_epoch_seconds()?)?;
    restore_workspace_surface(&app)
}

#[tauri::command]
fn desktop_open_update_download(webview: Webview, app: AppHandle) -> Result<(), String> {
    require_trusted_surface(&webview)?;
    let updater_status = app.state::<DesktopUpdaterState>().snapshot()?;
    let download_url = updater_status.manual_download_url;
    let recovery_version = updater_status
        .recovery
        .as_ref()
        .map(|attempt| attempt.from_version.as_str());
    let download_version = recovery_version.unwrap_or(&updater_status.current_version);
    let expected_url = versioned_dmg_url(download_version);
    if download_url != expected_url {
        return Err("Desktop recovery download URL does not match the recorded release".into());
    }
    let parsed = download_url
        .parse::<tauri::Url>()
        .map_err(|error| format!("invalid signed Desktop download URL: {error}"))?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("worktable.dev")
        || parsed.path()
            != format!(
                "/releases/v{}/worktable-desktop-darwin-arm64.dmg",
                download_version
            )
    {
        return Err("Desktop recovery download URL is outside worktable.dev".into());
    }
    app.opener()
        .open_url(download_url, None::<&str>)
        .map_err(|error| format!("failed to open signed Desktop download: {error}"))
}

#[tauri::command]
async fn desktop_select_connection_provider(
    webview: Webview,
    app: AppHandle,
    provider: Option<String>,
) -> Result<(), String> {
    require_trusted_surface(&webview)?;
    match provider.as_deref() {
        None => {
            set_status(&app, DesktopBootstrapStatus::provider_selection());
            Ok(())
        }
        Some("selfHosted") => {
            set_status(&app, DesktopBootstrapStatus::self_hosted_selection());
            Ok(())
        }
        Some("cloud") => {
            let profile_id = app
                .state::<DesktopHostState>()
                .connections
                .lock()
                .map_err(|_| "desktop connections lock is poisoned".to_string())?
                .profiles
                .iter()
                .find_map(|profile| match profile {
                    DesktopConnectionProfile::Cloud { id, .. } => Some(id.clone()),
                    _ => None,
                });
            set_status(
                &app,
                DesktopBootstrapStatus::cloud_selection(
                    if profile_id.is_some() {
                        "Sign in again to reopen your Worktable Cloud workspace."
                    } else {
                        "Sign in to Worktable Cloud"
                    },
                    profile_id,
                ),
            );
            Ok(())
        }
        Some("local") => {
            run_guarded_operation(&app, async {
                let existing = discover_existing_installation(&app).await?;
                let inspection = inspect_workspace(&app, None).await?;
                let mut status = DesktopBootstrapStatus::selection(inspection);
                status.existing_installation = existing;
                set_status(&app, status);
                Ok(())
            })
            .await
        }
        Some(_) => Err("unknown Desktop connection provider".into()),
    }
}

#[tauri::command]
async fn desktop_start_self_hosted_connection(
    webview: Webview,
    app: AppHandle,
    origin: String,
    allow_insecure_http: bool,
) -> Result<(), String> {
    require_trusted_surface(&webview)?;
    let canonical =
        validate_remote_origin(&origin, allow_insecure_http).map_err(|error| error.message)?;
    let canonical_origin = remote_origin_string(&canonical);
    let allow_insecure_http = canonical.scheme() == "http" && allow_insecure_http;
    let existing = app
        .state::<DesktopHostState>()
        .connections
        .lock()
        .map_err(|_| "desktop connections lock is poisoned".to_string())?
        .profiles
        .iter()
        .find_map(|profile| match profile {
            DesktopConnectionProfile::SelfHosted {
                id,
                origin,
                workspace_id,
                ..
            } if origin == &canonical_origin => Some((id.clone(), workspace_id.clone())),
            _ => None,
        });
    let pending = PendingRemoteConnection {
        origin: canonical_origin,
        profile_id: existing.as_ref().map(|(id, _)| id.clone()),
        expected_workspace_id: existing.and_then(|(_, workspace_id)| workspace_id),
        allow_insecure_http,
    };
    begin_remote_connection(&app, pending)?;
    Ok(())
}

#[tauri::command]
async fn desktop_start_cloud_connection(webview: Webview, app: AppHandle) -> Result<(), String> {
    require_trusted_surface(&webview)?;
    run_cloud_connection_operation(&app, true).await
}

#[tauri::command]
async fn desktop_cancel_cloud_connection(webview: Webview, app: AppHandle) -> Result<(), String> {
    require_trusted_surface(&webview)?;
    let cancellable = app
        .state::<DesktopHostState>()
        .status
        .lock()
        .map_err(|_| "desktop status lock is poisoned".to_string())
        .map(|status| {
            status.provider == Some("cloud")
                && matches!(
                    status.state,
                    "authenticatingCloud" | "restoringCloud" | "provisioningCloud"
                )
        })?;
    if !cancellable {
        return Err("no Worktable Cloud connection is waiting to be cancelled".into());
    }
    let profile = saved_cloud_profile(&app)?;
    let profile_identity = cloud_cancellation_profile_identity(
        profile.as_ref(),
        app.state::<DesktopHostState>()
            .cloud_connection_started_with_profile
            .load(Ordering::SeqCst),
    );
    next_connection_generation(&app);
    let controller = app.state::<CloudAuthController>();
    controller.cancel_auth_operation();
    {
        let state = app.state::<DesktopHostState>();
        let _commit = state
            .cloud_connection_commit
            .lock()
            .map_err(|_| "Desktop Cloud connection commit lock is poisoned".to_string())?;
        let committed = if profile_identity.is_none() {
            saved_cloud_profile(&app)?
        } else {
            None
        };
        if let Some(profile) = committed.as_ref() {
            remove_saved_connection(&app, profile.id())?;
        }
        clear_cloud_webview_cookie(&app)?;
        close_workspace_webview(&app);
    }
    let current_user_id = controller.current_user().map(|user| user.id);
    if let Some((_, remembered_user_id)) = profile_identity.as_ref() {
        if let Some(current_user_id) = current_user_id.as_deref() {
            if current_user_id != remembered_user_id {
                controller.clear_local(current_user_id).await?;
            }
        }
    } else {
        controller.clear_all_local().await?;
    }
    set_status(
        &app,
        DesktopBootstrapStatus::cloud_selection(
            if profile_identity.is_some() {
                "Cloud sign-in was cancelled. Sign in again to reopen this workspace."
            } else {
                "Cloud sign-in was cancelled."
            },
            profile_identity.map(|(id, _)| id),
        ),
    );
    size_current_window(&app);
    Ok(())
}

fn cloud_cancellation_profile_identity(
    profile: Option<&DesktopConnectionProfile>,
    connection_started_with_profile: bool,
) -> Option<(String, String)> {
    if !connection_started_with_profile {
        return None;
    }
    profile.and_then(|profile| match profile {
        DesktopConnectionProfile::Cloud {
            id, workos_user_id, ..
        } => Some((id.clone(), workos_user_id.clone())),
        _ => None,
    })
}

fn saved_cloud_profile(app: &AppHandle) -> Result<Option<DesktopConnectionProfile>, String> {
    Ok(app
        .state::<DesktopHostState>()
        .connections
        .lock()
        .map_err(|_| "desktop connections lock is poisoned".to_string())?
        .profiles
        .iter()
        .find(|profile| matches!(profile, DesktopConnectionProfile::Cloud { .. }))
        .cloned())
}

fn has_saved_cloud_profile(connections: &DesktopConnections) -> bool {
    connections
        .profiles
        .iter()
        .any(|profile| matches!(profile, DesktopConnectionProfile::Cloud { .. }))
}

fn cloud_profile_recovery_context(
    profile: Option<&DesktopConnectionProfile>,
) -> Option<(String, DesktopWorkspaceSummary)> {
    match profile {
        Some(DesktopConnectionProfile::Cloud {
            id,
            display_name,
            hosted_workspace_id,
            ..
        }) => Some((
            id.clone(),
            DesktopWorkspaceSummary {
                id: hosted_workspace_id.clone(),
                name: display_name.clone(),
                path: None,
            },
        )),
        _ => None,
    }
}

fn unfinished_cloud_credential_error() -> CloudAuthError {
    CloudAuthError {
        code: "CREDENTIAL_STORE_FAILED".into(),
        message: "macOS Keychain couldn’t remove the saved Cloud credential. Remove the Cloud connection before signing in again.".into(),
        retryable: true,
        clears_credential: true,
        retry_after: None,
    }
}

fn rejected_cloud_credential_error() -> CloudAuthError {
    CloudAuthError {
        code: "CREDENTIAL_STORE_FAILED".into(),
        message: "macOS Keychain couldn’t remove the saved Cloud credential. Remove the Cloud connection before signing in again.".into(),
        retryable: false,
        clears_credential: false,
        retry_after: None,
    }
}

async fn clear_unfinished_cloud_connection(
    app: &AppHandle,
    workos_user_id: &str,
) -> Result<(), CloudAuthError> {
    app.state::<CloudAuthController>()
        .clear_local(workos_user_id)
        .await
        .map_err(|_| unfinished_cloud_credential_error())?;
    clear_cloud_webview_cookie(app).map_err(cloud_local_error)?;
    close_workspace_webview(app);
    Ok(())
}

async fn clear_rejected_cloud_credential(
    app: &AppHandle,
    workos_user_id: &str,
    error: CloudAuthError,
) -> CloudAuthError {
    if !error.clears_credential {
        return error;
    }
    match app
        .state::<CloudAuthController>()
        .clear_local(workos_user_id)
        .await
    {
        Ok(()) => error,
        Err(_) => rejected_cloud_credential_error(),
    }
}

async fn run_cloud_connection_operation(app: &AppHandle, interactive: bool) -> Result<(), String> {
    run_guarded_operation(app, async {
        match connect_cloud(app, interactive).await {
            Ok(()) => Ok(()),
            Err(error) => {
                let profile = saved_cloud_profile(app).ok().flatten();
                if error.code == "AUTH_CANCELLED" {
                    let profile_id = cloud_profile_recovery_context(profile.as_ref())
                        .map(|(profile_id, _)| profile_id);
                    set_status(
                        app,
                        DesktopBootstrapStatus::cloud_selection(
                            if profile_id.is_some() {
                                "Cloud sign-in was cancelled. Sign in again to reopen this workspace."
                            } else {
                                "Cloud sign-in was cancelled."
                            },
                            profile_id,
                        ),
                    );
                    size_current_window(app);
                    return Ok(());
                }
                let (profile_id, workspace) =
                    match cloud_profile_recovery_context(profile.as_ref()) {
                        Some((profile_id, workspace)) => (Some(profile_id), Some(workspace)),
                        None => (None, None),
                    };
                if error.clears_credential {
                    let _ = clear_cloud_webview_cookie(app);
                    close_workspace_webview(app);
                }
                set_status(
                    app,
                    DesktopBootstrapStatus::cloud_recovery(&error, profile_id, workspace),
                );
                size_current_window(app);
                Ok(())
            }
        }
    })
    .await
}

async fn connect_cloud(app: &AppHandle, interactive: bool) -> Result<(), CloudAuthError> {
    let profile = saved_cloud_profile(app).map_err(|message| CloudAuthError {
        code: "CLOUD_PROFILE_UNAVAILABLE".into(),
        message,
        retryable: true,
        clears_credential: false,
        retry_after: None,
    })?;
    let (profile_id, mut expected_user_id, expected_hosted_id, expected_portable_id) =
        match profile.as_ref() {
            Some(DesktopConnectionProfile::Cloud {
                id,
                workos_user_id,
                hosted_workspace_id,
                portable_workspace_id,
                ..
            }) => (
                Some(id.clone()),
                Some(workos_user_id.clone()),
                Some(hosted_workspace_id.clone()),
                Some(portable_workspace_id.clone()),
            ),
            _ => (None, None, None, None),
        };
    app.state::<DesktopHostState>()
        .cloud_connection_started_with_profile
        .store(profile_id.is_some(), Ordering::SeqCst);
    if expected_user_id.is_none() && !interactive {
        expected_user_id = app
            .state::<CloudAuthController>()
            .stored_profileless_user_id()?;
    }
    let generation = next_connection_generation(app);
    close_workspace_webview(app);
    set_status(
        app,
        DesktopBootstrapStatus::cloud_progress(
            if interactive {
                "authenticatingCloud"
            } else {
                "restoringCloud"
            },
            if interactive {
                "Continue signing in through your browser."
            } else {
                "Restoring your Worktable Cloud session…"
            },
            profile_id.clone(),
        ),
    );
    let desktop_version = app.package_info().version.to_string();
    let (user, provisioning_deadline) = if interactive {
        let user = app
            .state::<CloudAuthController>()
            .authenticate_interactively(app, &desktop_version)
            .await?;
        (
            user,
            tokio::time::Instant::now() + Duration::from_secs(5 * 60),
        )
    } else {
        let expected_user_id = expected_user_id.as_deref().ok_or_else(|| CloudAuthError {
            code: "AUTHENTICATION_REQUIRED".into(),
            message: "Sign in to Worktable Cloud on this Mac.".into(),
            retryable: true,
            clears_credential: false,
            retry_after: None,
        })?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5 * 60);
        (
            resume_cloud_with_retry(
                app,
                generation,
                expected_user_id,
                &desktop_version,
                deadline,
            )
            .await?,
            deadline,
        )
    };
    if expected_user_id
        .as_deref()
        .is_some_and(|expected| expected != user.id)
    {
        app.state::<CloudAuthController>()
            .clear_local(&user.id)
            .await
            .map_err(|_| rejected_cloud_credential_error())?;
        return Err(CloudAuthError {
            code: "AUTH_IDENTITY_MISMATCH".into(),
            message: "This installation is connected to a different Worktable Cloud account. Remove the Cloud connection before switching accounts.".into(),
            retryable: false,
            clears_credential: false,
            retry_after: None,
        });
    }
    if !connection_generation_is_active(app, generation) {
        if profile_id.is_none() {
            app.state::<CloudAuthController>()
                .clear_local(&user.id)
                .await
                .map_err(|_| unfinished_cloud_credential_error())?;
        }
        return Ok(());
    }
    set_status(
        app,
        DesktopBootstrapStatus::cloud_progress(
            "provisioningCloud",
            "Opening your hosted workspace…",
            profile_id.clone(),
        ),
    );
    let session = match wait_for_cloud_session(
        app,
        generation,
        &desktop_version,
        &user.id,
        provisioning_deadline,
    )
    .await
    {
        Ok(session) => session,
        Err(mut error) => {
            if profile_id.is_none() {
                clear_unfinished_cloud_connection(app, &user.id).await?;
            } else if error.clears_credential {
                error = clear_rejected_cloud_credential(app, &user.id, error).await;
            }
            return Err(error);
        }
    };
    if expected_hosted_id
        .as_deref()
        .is_some_and(|expected| expected != session.workspace.hosted_workspace_id)
        || expected_portable_id
            .as_deref()
            .is_some_and(|expected| expected != session.workspace.portable_workspace_id)
    {
        let error = cloud_workspace_identity_conflict(
            "Worktable Cloud returned a different workspace identity for this account.",
        );
        return Err(clear_rejected_cloud_credential(app, &user.id, error).await);
    }
    if let Err(error) = finish_cloud_connection(app, generation, user.clone(), session) {
        if profile_id.is_none() {
            clear_unfinished_cloud_connection(app, &user.id).await?;
        }
        return Err(error);
    }
    Ok(())
}

async fn resume_cloud_with_retry(
    app: &AppHandle,
    generation: u64,
    workos_user_id: &str,
    desktop_version: &str,
    deadline: tokio::time::Instant,
) -> Result<CloudUser, CloudAuthError> {
    loop {
        if !connection_generation_is_active(app, generation) {
            return Err(cloud_cancelled_error());
        }
        match app
            .state::<CloudAuthController>()
            .resume(workos_user_id, desktop_version)
            .await
        {
            Ok(user) => return Ok(user),
            Err(error) => {
                wait_before_cloud_session_retry(
                    app,
                    generation,
                    deadline,
                    error,
                    CloudSessionRetryPhase::Renewal,
                )
                .await?;
            }
        }
    }
}

async fn wait_for_cloud_session(
    app: &AppHandle,
    generation: u64,
    desktop_version: &str,
    workos_user_id: &str,
    deadline: tokio::time::Instant,
) -> Result<CloudWebViewSession, CloudAuthError> {
    loop {
        if !connection_generation_is_active(app, generation) {
            return Err(CloudAuthError {
                code: "AUTH_CANCELLED".into(),
                message: "Worktable Cloud connection was cancelled.".into(),
                retryable: true,
                clears_credential: false,
                retry_after: None,
            });
        }
        let state = app.state::<DesktopHostState>();
        let connection_changed = state.connection_changed.notified();
        if !connection_generation_is_active(app, generation) {
            continue;
        }
        let renewal_result = await_connection_operation(
            app.state::<CloudAuthController>()
                .renew_if_needed(workos_user_id, desktop_version),
            connection_changed,
        )
        .await?;
        if let Err(error) = renewal_result {
            wait_before_cloud_session_retry(
                app,
                generation,
                deadline,
                error,
                CloudSessionRetryPhase::Renewal,
            )
            .await?;
            continue;
        }

        let state = app.state::<DesktopHostState>();
        let connection_changed = state.connection_changed.notified();
        if !connection_generation_is_active(app, generation) {
            continue;
        }
        let session_result = await_connection_operation(
            app.state::<CloudAuthController>()
                .issue_webview_session(desktop_version),
            connection_changed,
        )
        .await?;
        match session_result {
            Ok(session) => return Ok(session),
            Err(error) => {
                wait_before_cloud_session_retry(
                    app,
                    generation,
                    deadline,
                    error,
                    CloudSessionRetryPhase::Provisioning,
                )
                .await?;
            }
        }
    }
}

#[derive(Clone, Copy)]
enum CloudSessionRetryPhase {
    Renewal,
    Provisioning,
}

async fn wait_before_cloud_session_retry(
    app: &AppHandle,
    generation: u64,
    deadline: tokio::time::Instant,
    error: CloudAuthError,
    phase: CloudSessionRetryPhase,
) -> Result<(), CloudAuthError> {
    if !cloud_session_operation_retryable(&error, phase) || tokio::time::Instant::now() >= deadline
    {
        return Err(error);
    }
    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    let Some(delay) = cloud_session_poll_delay(error.retry_after, remaining) else {
        return Err(error);
    };
    let reaches_deadline = delay == remaining;
    let state = app.state::<DesktopHostState>();
    let connection_changed = state.connection_changed.notified();
    tokio::pin!(connection_changed);
    if !connection_generation_is_active(app, generation) {
        return Ok(());
    }
    let delay_completed = tokio::select! {
        _ = tokio::time::sleep(delay) => true,
        _ = &mut connection_changed => false,
    };
    if delay_completed && (reaches_deadline || tokio::time::Instant::now() >= deadline) {
        return Err(error);
    }
    Ok(())
}

async fn await_connection_operation<T>(
    operation: impl std::future::Future<Output = T>,
    connection_changed: impl std::future::Future<Output = ()>,
) -> Result<T, CloudAuthError> {
    tokio::pin!(operation);
    tokio::pin!(connection_changed);
    tokio::select! {
        result = &mut operation => Ok(result),
        _ = &mut connection_changed => Err(cloud_cancelled_error()),
    }
}

fn cloud_session_polling_retryable(code: &str) -> bool {
    matches!(
        code,
        "PROVISIONING"
            | "CONFIRMING_PAYMENT"
            | "PROVISIONING_UNAVAILABLE"
            | "CLOUD_UNAVAILABLE"
            | "INSTANCE_MIGRATING"
            | "CONTROL_PLANE_DOWN"
            | "AUTH_VERIFICATION_UNAVAILABLE"
    )
}

fn cloud_session_operation_retryable(
    error: &CloudAuthError,
    phase: CloudSessionRetryPhase,
) -> bool {
    error.retryable
        && !error.clears_credential
        && error.code != "AUTH_CANCELLED"
        && (matches!(phase, CloudSessionRetryPhase::Renewal)
            || cloud_session_polling_retryable(&error.code))
}

fn cloud_session_poll_delay(
    retry_after: Option<Duration>,
    remaining: Duration,
) -> Option<Duration> {
    if remaining.is_zero() {
        return None;
    }
    Some(
        retry_after
            .unwrap_or(Duration::from_secs(5))
            .clamp(Duration::from_secs(1), Duration::from_secs(30))
            .min(remaining),
    )
}

fn finish_cloud_connection(
    app: &AppHandle,
    generation: u64,
    user: CloudUser,
    session: CloudWebViewSession,
) -> Result<(), CloudAuthError> {
    let state = app.state::<DesktopHostState>();
    let _commit = state.cloud_connection_commit.lock().map_err(|_| {
        cloud_local_error("Desktop Cloud connection commit lock is poisoned".into())
    })?;
    if !connection_generation_is_active(app, generation) {
        return Err(cloud_cancelled_error());
    }
    let profile = DesktopConnectionProfile::cloud(
        session.workspace.name.clone(),
        user.id.clone(),
        session.workspace.hosted_workspace_id.clone(),
        session.workspace.portable_workspace_id.clone(),
    );
    let profile_id = profile.id().to_string();
    let (previous, next) = {
        let state = app.state::<DesktopHostState>();
        let current = state
            .connections
            .lock()
            .map_err(|_| cloud_local_error("desktop connections lock is poisoned".into()))?;
        let mut next = current.clone();
        next.activate(profile);
        (current.clone(), next)
    };
    let renew_at_epoch_seconds = session.renew_at_epoch_seconds;
    create_workspace_webview(
        app,
        WORKTABLE_CLOUD_ORIGIN.into(),
        "/",
        Some((session.cookie, generation)),
    )
    .map_err(cloud_local_error)?;
    if !connection_generation_is_active(app, generation) {
        close_workspace_webview(app);
        return Err(cloud_cancelled_error());
    }
    if let Err(error) = persist_desktop_connections(app, next) {
        close_workspace_webview(app);
        return Err(cloud_local_error(error));
    }
    if !connection_generation_is_active(app, generation) {
        let _ = persist_desktop_connections(app, previous);
        close_workspace_webview(app);
        return Err(cloud_cancelled_error());
    }
    let summary = DesktopWorkspaceSummary {
        id: session.workspace.hosted_workspace_id,
        name: session.workspace.name,
        path: None,
    };
    set_status(
        app,
        DesktopBootstrapStatus::cloud_ready(profile_id, summary),
    );
    size_current_window(app);
    reveal_cloud_workspace_if_ready(app);
    app.state::<DesktopHostState>()
        .cloud_cookie_refresh_pending
        .store(0, Ordering::SeqCst);
    app.state::<DesktopHostState>()
        .cloud_cookie_refresh_at
        .store(renew_at_epoch_seconds, Ordering::SeqCst);
    schedule_cloud_refresh(app.clone(), generation, user.id);
    Ok(())
}

fn cloud_cancelled_error() -> CloudAuthError {
    CloudAuthError {
        code: "AUTH_CANCELLED".into(),
        message: "Worktable Cloud connection was cancelled.".into(),
        retryable: true,
        clears_credential: false,
        retry_after: None,
    }
}

fn cloud_local_error(message: String) -> CloudAuthError {
    CloudAuthError {
        code: "CLOUD_DESKTOP_STATE_FAILED".into(),
        message,
        retryable: true,
        clears_credential: false,
        retry_after: None,
    }
}

fn cloud_workspace_identity_conflict(message: impl Into<String>) -> CloudAuthError {
    CloudAuthError {
        code: "WORKSPACE_IDENTITY_CONFLICT".into(),
        message: message.into(),
        retryable: false,
        clears_credential: true,
        retry_after: None,
    }
}

fn remove_saved_connection(app: &AppHandle, profile_id: &str) -> Result<(), String> {
    let next = {
        let state = app.state::<DesktopHostState>();
        let current = state
            .connections
            .lock()
            .map_err(|_| "desktop connections lock is poisoned".to_string())?;
        let mut next = current.clone();
        next.remove(profile_id);
        next
    };
    persist_desktop_connections(app, next)
}

fn schedule_cloud_refresh(app: AppHandle, generation: u64, workos_user_id: String) {
    tauri::async_runtime::spawn(async move {
        let mut retry_delay = Duration::ZERO;
        let mut retry_pending = false;
        loop {
            if !connection_generation_is_active(&app, generation) || !cloud_shell_is_ready(&app) {
                return;
            }
            let pending_cookie = app
                .state::<DesktopHostState>()
                .cloud_cookie_refresh_pending
                .load(Ordering::SeqCst)
                == generation;
            let retrying = pending_cookie || retry_pending;
            let access_delay = match app.state::<CloudAuthController>().refresh_delay() {
                Ok(delay) => delay,
                Err(_) => return,
            };
            let cookie_delay = cloud_cookie_refresh_delay(&app);
            let Some(delay) =
                cloud_refresh_scheduler_delay(retrying, retry_delay, access_delay, cookie_delay)
            else {
                return;
            };
            tokio::time::sleep(delay).await;
            if !connection_generation_is_active(&app, generation) || !cloud_shell_is_ready(&app) {
                return;
            }
            hide_cloud_workspace_before_refresh_if_needed(&app, &workos_user_id);
            match refresh_cloud_session(&app, generation, &workos_user_id).await {
                Ok(()) => {
                    if !cloud_shell_is_ready(&app) {
                        return;
                    }
                    retry_delay = Duration::ZERO;
                    retry_pending = false;
                    reveal_cloud_workspace_if_ready(&app);
                }
                Err(error)
                    if cloud_refresh_should_retry(
                        error.retryable,
                        app.state::<CloudAuthController>()
                            .access_is_valid(&workos_user_id),
                        cloud_shell_is_ready(&app),
                    ) =>
                {
                    retry_delay = next_cloud_refresh_retry_delay(retry_delay, error.retry_after);
                    retry_pending = true;
                }
                Err(_) => return,
            }
        }
    });
}

fn cloud_refresh_should_retry(
    error_retryable: bool,
    access_is_valid: bool,
    cloud_shell_ready: bool,
) -> bool {
    error_retryable && access_is_valid && cloud_shell_ready
}

fn cloud_refresh_scheduler_delay(
    retrying: bool,
    retry_delay: Duration,
    access_delay: Option<Duration>,
    cookie_delay: Option<Duration>,
) -> Option<Duration> {
    if retrying {
        return Some(if retry_delay.is_zero() {
            Duration::from_secs(1)
        } else {
            retry_delay
        });
    }
    match (access_delay, cookie_delay) {
        (Some(access), Some(cookie)) => Some(access.min(cookie)),
        (Some(delay), None) | (None, Some(delay)) => Some(delay),
        (None, None) => None,
    }
}

fn next_cloud_refresh_retry_delay(current: Duration, retry_after: Option<Duration>) -> Duration {
    let backoff = if current.is_zero() {
        Duration::from_secs(1)
    } else {
        current.saturating_mul(2).min(Duration::from_secs(30))
    };
    retry_after.map_or(backoff, |requested| requested.max(backoff))
}

async fn refresh_cloud_session(
    app: &AppHandle,
    generation: u64,
    workos_user_id: &str,
) -> Result<(), CloudAuthError> {
    let state = app.state::<DesktopHostState>();
    let connection_changed = state.connection_changed.notified();
    tokio::pin!(connection_changed);
    if !connection_generation_is_active(app, generation) {
        return Ok(());
    }
    let _refresh_operation = tokio::select! {
        operation = state.cloud_refresh_operation.lock() => operation,
        _ = &mut connection_changed => return Ok(()),
    };
    if !cloud_refresh_operation_is_allowed(
        app.state::<DesktopHostState>()
            .status
            .lock()
            .as_deref()
            .ok(),
        connection_generation_is_active(app, generation),
    ) {
        return Ok(());
    }
    let desktop_version = app.package_info().version.to_string();
    let refreshed = app
        .state::<CloudAuthController>()
        .renew_if_needed(workos_user_id, &desktop_version)
        .await;
    let refreshed = match refreshed {
        Ok(refreshed) => refreshed,
        Err(error)
            if error.retryable
                && app
                    .state::<CloudAuthController>()
                    .access_is_valid(workos_user_id) =>
        {
            return Err(error);
        }
        Err(error) => {
            let error = clear_rejected_cloud_credential(app, workos_user_id, error).await;
            enter_cloud_refresh_recovery(app, generation, &error);
            return Err(error);
        }
    };
    if !connection_generation_is_active(app, generation) {
        return Ok(());
    }
    if refreshed || cloud_cookie_refresh_is_due(app) {
        app.state::<DesktopHostState>()
            .cloud_cookie_refresh_pending
            .store(generation, Ordering::SeqCst);
    }
    let cookie_refresh_pending = app
        .state::<DesktopHostState>()
        .cloud_cookie_refresh_pending
        .load(Ordering::SeqCst)
        == generation;
    if !cookie_refresh_pending {
        return Ok(());
    }
    let session = match app
        .state::<CloudAuthController>()
        .issue_webview_session(&desktop_version)
        .await
    {
        Ok(session) => session,
        Err(error)
            if error.retryable
                && app
                    .state::<CloudAuthController>()
                    .access_is_valid(workos_user_id) =>
        {
            return Err(error);
        }
        Err(error) => {
            let error = clear_rejected_cloud_credential(app, workos_user_id, error).await;
            enter_cloud_refresh_recovery(app, generation, &error);
            return Err(error);
        }
    };
    if !connection_generation_is_active(app, generation) {
        return Ok(());
    }
    if let Err(error) = validate_refreshed_cloud_identity(app, workos_user_id, &session.workspace) {
        let error = clear_rejected_cloud_credential(app, workos_user_id, error).await;
        enter_cloud_refresh_recovery(app, generation, &error);
        return Err(error);
    }
    if !connection_generation_is_active(app, generation) {
        return Ok(());
    }
    let renew_at_epoch_seconds = session.renew_at_epoch_seconds;
    if let Err(message) = install_cloud_webview_cookie(app, generation, session.cookie) {
        let error = cloud_local_error(message);
        enter_cloud_refresh_recovery(app, generation, &error);
        return Err(error);
    }
    app.state::<DesktopHostState>()
        .cloud_cookie_refresh_at
        .store(renew_at_epoch_seconds, Ordering::SeqCst);
    app.state::<DesktopHostState>()
        .cloud_cookie_refresh_pending
        .store(0, Ordering::SeqCst);
    Ok(())
}

fn cloud_refresh_operation_is_allowed(
    status: Option<&DesktopBootstrapStatus>,
    generation_active: bool,
) -> bool {
    generation_active && status.is_some_and(cloud_status_is_ready)
}

fn cloud_cookie_refresh_delay<R: Runtime>(app: &AppHandle<R>) -> Option<Duration> {
    let refresh_at = app
        .state::<DesktopHostState>()
        .cloud_cookie_refresh_at
        .load(Ordering::SeqCst);
    if refresh_at == 0 {
        return None;
    }
    let now = now_epoch_seconds().unwrap_or(refresh_at);
    Some(Duration::from_secs(refresh_at.saturating_sub(now)))
}

fn cloud_cookie_refresh_is_due<R: Runtime>(app: &AppHandle<R>) -> bool {
    cloud_cookie_refresh_delay(app).is_some_and(|delay| delay.is_zero())
}

fn cloud_workspace_should_hide_before_refresh(
    access_is_valid: bool,
    cookie_refresh_is_due: bool,
) -> bool {
    !access_is_valid || cookie_refresh_is_due
}

fn hide_cloud_workspace_before_refresh_if_needed<R: Runtime>(
    app: &AppHandle<R>,
    workos_user_id: &str,
) {
    if !cloud_workspace_should_hide_before_refresh(
        app.state::<CloudAuthController>()
            .access_is_valid(workos_user_id),
        cloud_cookie_refresh_is_due(app),
    ) {
        return;
    }
    let _ = show_trusted_shell_surface(app);
}

fn cloud_workspace_session_is_usable(
    refresh_succeeded: bool,
    access_is_valid: bool,
    cookie_refresh_pending: bool,
    trusted_shell_ready: bool,
) -> bool {
    trusted_shell_ready && (refresh_succeeded || (access_is_valid && !cookie_refresh_pending))
}

fn validate_refreshed_cloud_identity(
    app: &AppHandle,
    workos_user_id: &str,
    workspace: &cloud_auth::CloudWorkspace,
) -> Result<(), CloudAuthError> {
    match saved_cloud_profile(app).map_err(cloud_local_error)? {
        Some(DesktopConnectionProfile::Cloud {
            workos_user_id: expected_user_id,
            hosted_workspace_id,
            portable_workspace_id,
            ..
        }) if expected_user_id == workos_user_id
            && hosted_workspace_id == workspace.hosted_workspace_id
            && portable_workspace_id == workspace.portable_workspace_id =>
        {
            Ok(())
        }
        Some(DesktopConnectionProfile::Cloud { .. }) => Err(cloud_workspace_identity_conflict(
            "Worktable Cloud returned a different identity for this saved connection.",
        )),
        _ => Err(CloudAuthError {
            code: "CLOUD_PROFILE_UNAVAILABLE".into(),
            message: "The saved Worktable Cloud connection is unavailable.".into(),
            retryable: false,
            clears_credential: false,
            retry_after: None,
        }),
    }
}

fn enter_cloud_refresh_recovery(app: &AppHandle, generation: u64, error: &CloudAuthError) {
    if !connection_generation_is_active(app, generation) {
        return;
    }
    app.state::<DesktopHostState>()
        .cloud_cookie_refresh_pending
        .store(0, Ordering::SeqCst);
    app.state::<DesktopHostState>()
        .cloud_cookie_refresh_at
        .store(0, Ordering::SeqCst);
    let _ = show_trusted_shell_surface(app);
    let profile = saved_cloud_profile(app).ok().flatten();
    let (profile_id, workspace) = match cloud_profile_recovery_context(profile.as_ref()) {
        Some((profile_id, workspace)) => (Some(profile_id), Some(workspace)),
        None => (None, None),
    };
    set_status(
        app,
        DesktopBootstrapStatus::cloud_recovery(error, profile_id, workspace),
    );
    size_current_window(app);
}

fn install_cloud_webview_cookie(
    app: &AppHandle,
    generation: u64,
    cookie: Cookie<'static>,
) -> Result<(), String> {
    let state = app.state::<DesktopHostState>();
    let _cookie_operation = state
        .cloud_cookie_operation
        .lock()
        .map_err(|_| "Desktop Cloud cookie lock is poisoned".to_string())?;
    if !connection_generation_is_active(app, generation) {
        return Err("Worktable Cloud connection changed before session renewal".into());
    }
    let workspace = app
        .get_webview(WORKSPACE_WEBVIEW_LABEL)
        .ok_or_else(|| "Cloud workspace WebView is unavailable".to_string())?;
    let expected_value = cookie.value().to_string();
    let origin = WORKTABLE_CLOUD_ORIGIN
        .parse::<tauri::Url>()
        .map_err(|error| format!("invalid Cloud origin: {error}"))?;
    set_host_only_cookie(&workspace, &origin, cookie)
        .map_err(|error| format!("failed to renew the Cloud session cookie: {error}"))?;
    let installed = workspace
        .cookies_for_url(origin)
        .map_err(|error| format!("failed to verify the renewed Cloud session: {error}"))?
        .iter()
        .any(|cookie| cookie.name() == "wt_session" && cookie.value() == expected_value);
    if !installed {
        return Err("Desktop could not verify the renewed Cloud session cookie".into());
    }
    Ok(())
}

fn clear_cloud_webview_cookie(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<DesktopHostState>();
    let _cookie_operation = state
        .cloud_cookie_operation
        .lock()
        .map_err(|_| "Desktop Cloud cookie lock is poisoned".to_string())?;
    let Some(webview) = app
        .get_webview(WORKSPACE_WEBVIEW_LABEL)
        .or_else(|| app.get_webview(TRUSTED_WEBVIEW_LABEL))
    else {
        return Ok(());
    };
    let origin = WORKTABLE_CLOUD_ORIGIN
        .parse::<tauri::Url>()
        .map_err(|error| format!("invalid Cloud origin: {error}"))?;
    purge_persisted_host_only_cookie(&webview, &origin, "wt_session")?;
    for cookie in webview
        .cookies_for_url(origin.clone())
        .map_err(|error| format!("failed to read the Cloud session cookie: {error}"))?
    {
        if cookie.name() == "wt_session" {
            webview
                .delete_cookie(cookie)
                .map_err(|error| format!("failed to clear the Cloud session cookie: {error}"))?;
        }
    }
    if webview
        .cookies_for_url(origin)
        .map_err(|error| format!("failed to verify Cloud sign-out: {error}"))?
        .iter()
        .any(|cookie| cookie.name() == "wt_session")
    {
        return Err("Desktop could not clear the Cloud session cookie".into());
    }
    Ok(())
}

#[tauri::command]
async fn desktop_start_saved_connection(
    webview: Webview,
    app: AppHandle,
    profile_id: String,
) -> Result<(), String> {
    require_trusted_surface(&webview)?;
    let profile = app
        .state::<DesktopHostState>()
        .connections
        .lock()
        .map_err(|_| "desktop connections lock is poisoned".to_string())?
        .profiles
        .iter()
        .find(|profile| profile.id() == profile_id)
        .cloned()
        .ok_or_else(|| "saved Desktop connection does not exist".to_string())?;
    let DesktopConnectionProfile::SelfHosted {
        origin,
        workspace_id,
        allow_insecure_http,
        ..
    } = profile
    else {
        return Err("saved connection is not self-hosted".into());
    };
    validate_remote_origin(&origin, allow_insecure_http).map_err(|error| error.message)?;
    if workspace_id.is_none() {
        return Err("This saved server needs to finish setup before it can open.".into());
    }
    begin_remote_connection(
        &app,
        PendingRemoteConnection {
            origin,
            profile_id: Some(profile_id),
            expected_workspace_id: workspace_id,
            allow_insecure_http,
        },
    )?;
    Ok(())
}

#[tauri::command]
async fn desktop_choose_workspace_folder(
    webview: Webview,
    app: AppHandle,
) -> Result<Option<String>, String> {
    require_trusted_surface(&webview)?;
    let previous = app
        .state::<DesktopHostState>()
        .status
        .lock()
        .map_err(|_| "desktop status lock is poisoned".to_string())?
        .clone();
    let path = previous
        .selected_path
        .as_deref()
        .or(previous.default_path.as_deref())
        .unwrap_or("");
    let hint = app
        .state::<DesktopHostState>()
        .picker_directory_hint
        .lock()
        .map_err(|_| "desktop picker hint lock is poisoned".to_string())?
        .clone();
    let start_directory =
        picker_start_directory(hint.as_deref(), (!path.is_empty()).then(|| Path::new(path)));
    set_status(
        &app,
        DesktopBootstrapStatus::progress("configuringLocal", "Choose a folder…", path),
    );
    let mut picker = app.dialog().file();
    if let Some(directory) = start_directory {
        picker = picker.set_directory(directory);
    }
    let selected = picker
        .blocking_pick_folder()
        .map(|path| {
            path.into_path()
                .map(|path| path.to_string_lossy().into_owned())
                .map_err(|error| format!("selected folder is not a filesystem path: {error}"))
        })
        .transpose();
    if matches!(selected, Ok(Some(_))) {
        let state = app.state::<DesktopHostState>();
        let mut picker_hint = state
            .picker_directory_hint
            .lock()
            .map_err(|_| "desktop picker hint lock is poisoned".to_string())?;
        update_picker_hint_after_selection(&mut picker_hint, true);
    }
    set_status(&app, previous);
    selected
}

#[tauri::command]
async fn desktop_inspect_workspace(
    webview: Webview,
    app: AppHandle,
    path: String,
) -> Result<WorkspaceInspection, String> {
    require_trusted_surface(&webview)?;
    inspect_workspace(&app, Some(path)).await
}

#[tauri::command]
async fn desktop_start_local_connection(
    webview: Webview,
    app: AppHandle,
    intent: String,
    path: String,
) -> Result<(), String> {
    require_trusted_surface(&webview)?;
    if intent != "create" && intent != "open" {
        return Err("workspace intent must be create or open".into());
    }
    run_guarded_operation(&app, async {
        set_status(
            &app,
            DesktopBootstrapStatus::progress(
                "preparingWorkspace",
                if intent == "create" {
                    "Creating Worktable…"
                } else {
                    "Opening Worktable…"
                },
                &path,
            ),
        );
        let prepared = prepare_workspace(&app, &path, &intent).await?;
        let mut status = DesktopBootstrapStatus::progress(
            "preparingWorkspace",
            "Finishing setup…",
            &prepared.path,
        );
        status.workspace = Some(DesktopWorkspaceSummary {
            id: prepared.workspace.id.clone(),
            name: prepared.workspace.name.clone(),
            path: Some(prepared.path.clone()),
        });
        set_status(&app, status);
        app.state::<DesktopHostState>()
            .pending_local
            .lock()
            .map_err(|_| "pending workspace lock is poisoned".to_string())?
            .replace(prepared.clone());
        start_prepared_local(&app, prepared, true).await
    })
    .await
}

#[tauri::command]
async fn desktop_use_existing_installation(webview: Webview, app: AppHandle) -> Result<(), String> {
    require_trusted_surface(&webview)?;
    run_guarded_operation(&app, async {
        let existing = app
            .state::<DesktopHostState>()
            .status
            .lock()
            .map_err(|_| "desktop status lock is poisoned".to_string())?
            .existing_installation
            .clone()
            .ok_or_else(|| "no existing local Worktable installation is available".to_string())?;
        let path = existing
            .workspace
            .path
            .clone()
            .ok_or_else(|| "existing local workspace has no filesystem path".to_string())?;
        set_status(
            &app,
            DesktopBootstrapStatus::progress("configuringLocal", "Opening Worktable…", &path),
        );
        let prepared = prepare_workspace(&app, &path, "open").await?;
        start_prepared_local(&app, prepared, true).await
    })
    .await
}

#[tauri::command]
async fn desktop_retry_connection(webview: Webview, app: AppHandle) -> Result<(), String> {
    require_trusted_surface(&webview)?;
    let cloud_retry = app
        .state::<DesktopHostState>()
        .status
        .lock()
        .map_err(|_| "desktop status lock is poisoned".to_string())?
        .clone();
    if cloud_retry.provider == Some("cloud") {
        let has_profile = cloud_retry.connection_profile_id.is_some();
        let has_continuation = if has_profile {
            false
        } else {
            app.state::<CloudAuthController>()
                .stored_profileless_user_id()
                .map_err(|error| error.message)?
                .is_some()
        };
        let interactive = cloud_retry_requires_interactive(
            cloud_retry.error_code.as_deref(),
            cloud_retry.state,
            has_profile,
            has_continuation,
        );
        return run_cloud_connection_operation(&app, interactive).await;
    }
    let pending_remote = app
        .state::<DesktopHostState>()
        .pending_remote
        .lock()
        .map_err(|_| "pending remote connection lock is poisoned".to_string())?
        .clone();
    if let Some(pending) = pending_remote {
        return begin_remote_connection(&app, pending);
    }
    let active_remote = app
        .state::<DesktopHostState>()
        .connections
        .lock()
        .map_err(|_| "desktop connections lock is poisoned".to_string())?
        .active()
        .and_then(|profile| match profile {
            DesktopConnectionProfile::SelfHosted {
                id,
                origin,
                workspace_id,
                allow_insecure_http,
                ..
            } => Some(PendingRemoteConnection {
                origin: origin.clone(),
                profile_id: Some(id.clone()),
                expected_workspace_id: workspace_id.clone(),
                allow_insecure_http: *allow_insecure_http,
            }),
            _ => None,
        });
    if let Some(pending) = active_remote {
        return begin_remote_connection(&app, pending);
    }
    next_connection_generation(&app);
    run_guarded_operation(&app, retry_local_connection(&app)).await
}

fn cloud_retry_requires_interactive(
    error_code: Option<&str>,
    state: &str,
    has_profile: bool,
    has_continuation: bool,
) -> bool {
    matches!(
        error_code,
        Some(
            "AUTHENTICATION_REQUIRED"
                | "AUTH_REFRESH_FAILED"
                | "UNAUTHORIZED"
                | "AUTH_IDENTITY_MISMATCH"
                | "CREDENTIAL_STORE_FAILED"
        )
    ) || state == "needsSelection"
        || (!has_profile && !has_continuation)
}

async fn retry_local_connection(app: &AppHandle) -> Result<(), String> {
    let pending = app
        .state::<DesktopHostState>()
        .pending_local
        .lock()
        .map_err(|_| "pending workspace lock is poisoned".to_string())?
        .clone();
    let active = active_local_profile(app).ok();
    let (path, expected_id, created) = match pending {
        Some(pending) => (pending.path, pending.workspace.id, pending.created),
        None => match active {
            Some(DesktopConnectionProfile::Local {
                workspace_path,
                workspace_id,
                ..
            }) => (workspace_path, workspace_id, false),
            Some(_) => return Err("this connection type is not available in this build".into()),
            None => return Err("no local connection is available to retry".into()),
        },
    };
    let inspection = inspect_workspace(app, Some(path.clone())).await?;
    match resolve_saved_workspace(inspection, &expected_id) {
        SavedWorkspaceResolution::Ready(mut prepared) => {
            prepared.created = created;
            start_prepared_local(app, prepared, true).await
        }
        SavedWorkspaceResolution::IdentityMismatch(workspace) => Err(format!(
            "The saved folder now contains a different Worktable ({}). Open it instead.",
            workspace.name
        )),
        SavedWorkspaceResolution::Rejected(message) => Err(message),
        SavedWorkspaceResolution::Missing => {
            Err("The saved folder is missing. Find it or choose another Worktable.".into())
        }
    }
}

#[tauri::command]
async fn desktop_restart_local_host(webview: Webview, app: AppHandle) -> Result<(), String> {
    require_trusted_surface(&webview)?;
    run_guarded_operation(&app, async {
        let runtime = runtime_for(&app)?;
        let output = configured_sidecar(
            &app,
            &runtime,
            vec!["local-host".into(), "restart".into(), "--json".into()],
        )?
        .output()
        .await
        .map_err(|error| format!("failed to restart the local Worktable host: {error}"))?;
        let envelope: LocalRestartEnvelope =
            serde_json::from_slice(&output.stdout).map_err(|error| {
                format!(
                    "local Worktable restart returned invalid JSON: {error} ({})",
                    String::from_utf8_lossy(&output.stderr).trim()
                )
            })?;
        if envelope.schema_version != LOCAL_MACHINE_CONTRACT_SCHEMA_VERSION {
            return Err("local Worktable restart contract version is unsupported".into());
        }
        if !output.status.success() || !envelope.ok {
            return Err(envelope
                .error
                .map(|error| error.message)
                .unwrap_or_else(|| "local Worktable restart failed".into()));
        }
        match envelope.action.as_deref() {
            Some("restart-owned") => stop_local_host(&app),
            Some("attach") => {}
            Some(action) => return Err(format!("unsupported local restart action: {action}")),
            None => return Err("local Worktable restart omitted its action".into()),
        }
        retry_local_connection(&app).await
    })
    .await
}

#[tauri::command]
async fn desktop_repair_local_authority(webview: Webview, app: AppHandle) -> Result<(), String> {
    require_trusted_surface(&webview)?;
    run_guarded_operation(&app, async {
        stop_local_host(&app);
        let repairing_corrupt_config = app
            .state::<DesktopHostState>()
            .status
            .lock()
            .map(|status| status.error_code.as_deref() == Some("CONFIG_CORRUPT"))
            .unwrap_or(false);
        if repairing_corrupt_config {
            return repair_corrupt_local_config(&app).await;
        }
        let runtime = runtime_for(&app)?;
        let output = configured_sidecar(
            &app,
            &runtime,
            vec!["local-host".into(), "recover".into(), "--json".into()],
        )?
        .output()
        .await
        .map_err(|error| format!("failed to repair local Worktable setup: {error}"))?;
        let envelope: LocalRestartEnvelope =
            serde_json::from_slice(&output.stdout).map_err(|error| {
                format!(
                    "local Worktable repair returned invalid JSON: {error} ({})",
                    String::from_utf8_lossy(&output.stderr).trim()
                )
            })?;
        if envelope.schema_version != LOCAL_MACHINE_CONTRACT_SCHEMA_VERSION {
            return Err("local Worktable repair contract version is unsupported".into());
        }
        if !output.status.success() || !envelope.ok {
            return Err(envelope
                .error
                .map(|error| error.message)
                .unwrap_or_else(|| "local Worktable repair failed".into()));
        }
        match envelope.action.as_deref() {
            Some("rolled-back") | Some("repaired") | Some("none") => {
                initialize_desktop_inner(&app).await
            }
            Some(action) => Err(format!("unsupported local repair action: {action}")),
            None => Err("local Worktable repair omitted its action".into()),
        }
    })
    .await
}

async fn repair_corrupt_local_config(app: &AppHandle) -> Result<(), String> {
    let workspace = retry_workspace_summary(app).ok_or_else(|| {
        "Desktop has no saved workspace from which to recreate the local setup. Run `worktable setup`, then reopen Worktable Desktop."
            .to_string()
    })?;
    let runtime = runtime_for(app)?;
    let service_output = configured_sidecar(
        app,
        &runtime,
        vec!["service".into(), "status".into(), "--json".into()],
    )?
    .output()
    .await
    .map_err(|error| format!("failed to inspect the local Worktable service: {error}"))?;
    let service: LocalAuthorityService =
        serde_json::from_slice(&service_output.stdout).map_err(|error| {
            format!(
                "local Worktable service status returned invalid JSON: {error} ({})",
                String::from_utf8_lossy(&service_output.stderr).trim()
            )
        })?;
    if !service_output.status.success() {
        return Err("Worktable could not determine whether the local service is installed; the shared configuration was not changed.".into());
    }

    let mut args = vec![
        "setup".into(),
        "--yes".into(),
        "--skip-mcp".into(),
        "--no-launch".into(),
        "--workspace".into(),
        workspace
            .path
            .ok_or_else(|| "saved local workspace has no filesystem path".to_string())?,
    ];
    args.push(if service.installed {
        "--background".into()
    } else {
        "--foreground".into()
    });
    let output = configured_sidecar(app, &runtime, args)?
        .output()
        .await
        .map_err(|error| format!("failed to recreate local Worktable setup: {error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            "Worktable could not recreate the shared local configuration.".into()
        } else {
            detail
        });
    }
    initialize_desktop_inner(app).await
}

#[tauri::command]
async fn desktop_open_local_logs(webview: Webview, app: AppHandle) -> Result<(), String> {
    require_trusted_surface(&webview)?;
    let authority = inspect_local_authority(&app).await?;
    let path = local_authority_log_path(&authority)
        .ok_or_else(|| "local Worktable log path is unavailable".to_string())?;
    let log = Path::new(&path);
    if let Some(parent) = log.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create Worktable log directory: {error}"))?;
    }
    if !log.exists() {
        std::fs::write(log, b"")
            .map_err(|error| format!("failed to create Worktable log file: {error}"))?;
    }
    app.opener()
        .reveal_item_in_dir(log)
        .map_err(|error| format!("failed to reveal Worktable logs: {error}"))
}

fn local_authority_log_path(authority: &LocalAuthorityInspection) -> Option<String> {
    let runtime_is_service = authority
        .runtime
        .as_ref()
        .is_some_and(|runtime| runtime.owner == "service");
    let service_is_relevant = authority
        .service
        .as_ref()
        .is_some_and(|service| service.installed)
        || runtime_is_service;
    if service_is_relevant {
        authority
            .service
            .as_ref()
            .map(|service| service.logs.stdout.clone())
    } else {
        authority.logs.as_ref().map(|logs| logs.desktop.clone())
    }
}

#[tauri::command]
async fn desktop_change_connection(webview: Webview, app: AppHandle) -> Result<(), String> {
    require_trusted_surface(&webview)?;
    change_connection(&app).await
}

#[tauri::command]
async fn desktop_cloud_sign_out(webview: Webview, app: AppHandle) -> Result<(), String> {
    require_trusted_surface(&webview)?;
    cloud_sign_out(&app, false).await
}

#[tauri::command]
async fn desktop_cloud_end_session(webview: Webview, app: AppHandle) -> Result<(), String> {
    require_trusted_surface(&webview)?;
    cloud_sign_out(&app, true).await
}

fn cloud_profile_identity(app: &AppHandle) -> Result<(String, String), String> {
    let profile = saved_cloud_profile(app)?
        .ok_or_else(|| "no Worktable Cloud connection is saved".to_string())?;
    match profile {
        DesktopConnectionProfile::Cloud {
            id, workos_user_id, ..
        } => Ok((id, workos_user_id)),
        _ => Err("saved connection is not Worktable Cloud".into()),
    }
}

async fn cloud_sign_out(app: &AppHandle, end_session: bool) -> Result<(), String> {
    {
        let state = app.state::<DesktopHostState>();
        let mut running = state
            .operation_in_progress
            .lock()
            .map_err(|_| "desktop operation lock is poisoned".to_string())?;
        if *running {
            return Err("another desktop connection operation is already running".into());
        }
        *running = true;
    }
    let result: Result<(), CloudAuthError> = async {
        let (profile_id, workos_user_id) =
            cloud_profile_identity(app).map_err(cloud_local_error)?;
        if end_session {
            let desktop_version = app.package_info().version.to_string();
            let logout_url = app
                .state::<CloudAuthController>()
                .exact_session_logout_url(&workos_user_id, &desktop_version)
                .await?;
            app.opener()
                .open_url(logout_url, None::<&str>)
                .map_err(|_| {
                    cloud_local_error("Couldn’t open the browser sign-out page.".into())
                })?;
        }
        next_connection_generation(app);
        clear_cloud_webview_cookie(app).map_err(cloud_local_error)?;
        app.state::<CloudAuthController>()
            .clear_local(&workos_user_id)
            .await
            .map_err(cloud_local_error)?;
        close_workspace_webview(app);
        set_status(
            app,
            DesktopBootstrapStatus::cloud_selection(
                if end_session {
                    "You’ve been signed out. Sign in again to reopen this Worktable."
                } else {
                    "Signed out on this Mac. Sign in again to reopen this workspace."
                },
                Some(profile_id),
            ),
        );
        size_current_window(app);
        Ok(())
    }
    .await;
    if let Ok(mut running) = app.state::<DesktopHostState>().operation_in_progress.lock() {
        *running = false;
    }
    match result {
        Ok(()) => Ok(()),
        Err(error) => {
            // Recovery actions live in the trusted shell. Tear down the
            // unprivileged workspace surface even when logout failed before
            // local credentials could be cleared, so those actions cannot be
            // covered by the full-size workspace WebView.
            close_workspace_webview(app);
            let profile = saved_cloud_profile(app).ok().flatten();
            let (profile_id, workspace) = match cloud_profile_recovery_context(profile.as_ref()) {
                Some((profile_id, workspace)) => (Some(profile_id), Some(workspace)),
                None => (None, None),
            };
            set_status(
                app,
                DesktopBootstrapStatus::cloud_recovery(&error, profile_id, workspace),
            );
            size_current_window(app);
            Err(error.message)
        }
    }
}

fn clear_remote_session(app: &AppHandle, origin: &str) -> Result<(), String> {
    let origin_url = normalize_remote_origin(origin).map_err(|error| error.message)?;
    let webview = app
        .get_webview(WORKSPACE_WEBVIEW_LABEL)
        .or_else(|| app.get_webview(TRUSTED_WEBVIEW_LABEL))
        .ok_or_else(|| "Desktop webview cookie store is unavailable".to_string())?;
    let cookies = webview
        .cookies_for_url(origin_url.clone())
        .map_err(|error| format!("failed to read the Worktable session: {error}"))?;
    let session = cookies
        .iter()
        .find(|cookie| cookie.name() == "wt_session")
        .map(|cookie| cookie.value().to_string());
    for cookie in cookies {
        if cookie.name() == "wt_session" {
            webview
                .delete_cookie(cookie)
                .map_err(|error| format!("failed to delete the Worktable session: {error}"))?;
        }
    }
    let session_still_exists = webview
        .cookies_for_url(origin_url.clone())
        .map_err(|error| format!("failed to verify Worktable session deletion: {error}"))?
        .iter()
        .any(|cookie| cookie.name() == "wt_session");
    if session_still_exists {
        return Err("Desktop could not delete the Worktable session cookie. The saved server was kept so you can try again.".into());
    }
    if let Ok(client) = remote_http_client(app) {
        tauri::async_runtime::spawn(async move {
            client.logout(&origin_url, session.as_deref()).await;
        });
    }
    Ok(())
}

async fn change_connection(app: &AppHandle) -> Result<(), String> {
    let cloud_failure: Arc<RecordedCloudRecoveryFailure> = Arc::new(Mutex::new(None));
    let cloud_failure_for_operation = Arc::clone(&cloud_failure);
    let result = run_guarded_operation(app, async {
        let changing_from_cloud = app
            .state::<DesktopHostState>()
            .status
            .lock()
            .map(|status| status.provider == Some("cloud"))
            .unwrap_or(false);
        let cloud_recovery_context = if changing_from_cloud {
            cloud_profile_recovery_context(saved_cloud_profile(app)?.as_ref())
        } else {
            None
        };
        next_connection_generation(app);
        stop_local_host(app);
        if changing_from_cloud {
            if let Err(message) = clear_cloud_webview_cookie(app) {
                return Err(record_cloud_recovery_failure(
                    &cloud_failure_for_operation,
                    cloud_local_error(message),
                    cloud_recovery_context.clone(),
                ));
            }
            let controller = app.state::<CloudAuthController>();
            controller.cancel_auth_operation();
            if saved_cloud_profile(app)?.is_none() {
                if let Err(message) = controller.clear_all_local().await {
                    return Err(record_cloud_recovery_failure(
                        &cloud_failure_for_operation,
                        cloud_local_error(message),
                        cloud_recovery_context.clone(),
                    ));
                }
            }
        }
        close_workspace_webview(app);
        clear_pending_workspace(app);
        if let Ok(mut pending) = app.state::<DesktopHostState>().pending_remote.lock() {
            pending.take();
        }
        app.state::<DesktopHostState>()
            .remote_probe_in_progress
            .store(false, Ordering::SeqCst);
        let next = {
            let state = app.state::<DesktopHostState>();
            let current = state
                .connections
                .lock()
                .map_err(|_| "desktop connections lock is poisoned".to_string())?;
            let mut next = current.clone();
            next.active_profile_id = None;
            next
        };
        if let Err(message) = persist_desktop_connections(app, next) {
            if changing_from_cloud {
                return Err(record_cloud_recovery_failure(
                    &cloud_failure_for_operation,
                    cloud_local_error(message),
                    cloud_recovery_context,
                ));
            }
            return Err(message);
        }
        set_status(app, DesktopBootstrapStatus::provider_selection());
        size_current_window(app);
        Ok(())
    })
    .await;
    if result.is_err() {
        restore_recorded_cloud_recovery(app, &cloud_failure);
    }
    result
}

#[tauri::command]
async fn desktop_remove_connection(
    webview: Webview,
    app: AppHandle,
    profile_id: Option<String>,
) -> Result<(), String> {
    require_trusted_surface(&webview)?;
    let cloud_failure: Arc<RecordedCloudRecoveryFailure> = Arc::new(Mutex::new(None));
    let cloud_failure_for_operation = Arc::clone(&cloud_failure);
    let result = run_guarded_operation(&app, async {
        let (target_profile, target_is_active) = {
            let state = app.state::<DesktopHostState>();
            let connections = state
                .connections
                .lock()
                .map_err(|_| "desktop connections lock is poisoned".to_string())?;
            let target_id = profile_id
                .as_deref()
                .or(connections.active_profile_id.as_deref());
            let target_profile = target_id.and_then(|id| {
                connections
                    .profiles
                    .iter()
                    .find(|profile| profile.id() == id)
                    .cloned()
            });
            let target_is_active = target_profile.as_ref().is_some_and(|profile| {
                connections.active_profile_id.as_deref() == Some(profile.id())
            });
            (target_profile, target_is_active)
        };
        let pending_profile_id = {
            let state = app.state::<DesktopHostState>();
            state
                .pending_remote
                .lock()
                .ok()
                .and_then(|pending| pending.as_ref().and_then(|item| item.profile_id.clone()))
        };
        let target_is_pending = target_profile
            .as_ref()
            .is_some_and(|profile| pending_profile_id.as_deref() == Some(profile.id()));
        let target_is_presented = target_profile.as_ref().is_some_and(|profile| {
            app.state::<DesktopHostState>()
                .status
                .lock()
                .map(|status| status.connection_profile_id.as_deref() == Some(profile.id()))
                .unwrap_or(false)
        });
        let affects_current_connection = connection_removal_affects_current(
            target_is_active,
            target_is_pending,
            target_is_presented,
        );
        let cloud_recovery_context = cloud_profile_recovery_context(target_profile.as_ref());
        if let Some(DesktopConnectionProfile::SelfHosted { origin, .. }) = &target_profile {
            clear_remote_session(&app, origin)?;
        }
        let generation = next_connection_generation(&app);
        if matches!(
            &target_profile,
            Some(DesktopConnectionProfile::Cloud { .. })
        ) {
            if let Err(message) = clear_cloud_webview_cookie(&app) {
                return Err(record_cloud_recovery_failure(
                    &cloud_failure_for_operation,
                    cloud_local_error(message),
                    cloud_recovery_context.clone(),
                ));
            }
            if let Err(message) = app.state::<CloudAuthController>().clear_all_local().await {
                return Err(record_cloud_recovery_failure(
                    &cloud_failure_for_operation,
                    cloud_local_error(message),
                    cloud_recovery_context.clone(),
                ));
            }
        }
        if affects_current_connection {
            stop_local_host(&app);
            close_workspace_webview(&app);
            clear_pending_workspace(&app);
            if let Ok(mut pending) = app.state::<DesktopHostState>().pending_remote.lock() {
                pending.take();
            }
        }
        let runtime = runtime_for(&app)?;
        let path = connections_path(&runtime.shell_data_root);
        let corrupt = app
            .state::<DesktopHostState>()
            .status
            .lock()
            .map(|status| status.error_code.as_deref() == Some("CORRUPT_CONNECTIONS"))
            .unwrap_or(false);
        if corrupt {
            quarantine_connections(&path)?;
            *app.state::<DesktopHostState>()
                .connections
                .lock()
                .map_err(|_| "desktop connections lock is poisoned".to_string())? =
                DesktopConnections::default();
        } else {
            let next = {
                let state = app.state::<DesktopHostState>();
                let current = state
                    .connections
                    .lock()
                    .map_err(|_| "desktop connections lock is poisoned".to_string())?;
                let mut next = current.clone();
                if let Some(profile) = target_profile.as_ref() {
                    next.remove(profile.id());
                } else {
                    next.remove_active();
                }
                next
            };
            if let Err(message) = persist_desktop_connections(&app, next) {
                if cloud_recovery_context.is_some() {
                    return Err(record_cloud_recovery_failure(
                        &cloud_failure_for_operation,
                        cloud_local_error(message),
                        cloud_recovery_context,
                    ));
                }
                return Err(message);
            }
        }
        if affects_current_connection
            && matches!(
                &target_profile,
                Some(DesktopConnectionProfile::SelfHosted { .. })
            )
        {
            set_status(&app, DesktopBootstrapStatus::self_hosted_selection());
        } else if affects_current_connection
            && matches!(
                &target_profile,
                Some(DesktopConnectionProfile::Cloud { .. })
            )
        {
            set_status(
                &app,
                DesktopBootstrapStatus::cloud_selection("Sign in to Worktable Cloud", None),
            );
        } else if affects_current_connection || corrupt {
            set_status(&app, DesktopBootstrapStatus::provider_selection());
        } else {
            let current = app
                .state::<DesktopHostState>()
                .status
                .lock()
                .map_err(|_| "desktop status lock is poisoned".to_string())?
                .clone();
            let restart_remote_monitor =
                current.state == "ready" && current.provider == Some("selfHosted");
            set_status(&app, current);
            if restart_remote_monitor {
                start_remote_monitor(app.clone(), generation);
            }
        }
        size_current_window(&app);
        Ok(())
    })
    .await;
    if result.is_err() {
        restore_recorded_cloud_recovery(&app, &cloud_failure);
    }
    result
}

fn restore_recorded_cloud_recovery(
    app: &AppHandle,
    failure: &RecordedCloudRecoveryFailure,
) -> bool {
    let failure = failure.lock().ok().and_then(|mut failure| failure.take());
    let Some((error, profile_id, workspace)) = failure else {
        return false;
    };
    close_workspace_webview(app);
    set_status(
        app,
        DesktopBootstrapStatus::cloud_recovery(&error, profile_id, workspace),
    );
    size_current_window(app);
    true
}

fn record_cloud_recovery_failure(
    failure: &RecordedCloudRecoveryFailure,
    error: CloudAuthError,
    recovery_context: Option<(String, DesktopWorkspaceSummary)>,
) -> String {
    let message = error.message.clone();
    let (profile_id, workspace) = match recovery_context {
        Some((profile_id, workspace)) => (Some(profile_id), Some(workspace)),
        None => (None, None),
    };
    if let Ok(mut failure) = failure.lock() {
        *failure = Some((error, profile_id, workspace));
    }
    message
}

type RecordedCloudRecoveryFailure = Mutex<
    Option<(
        CloudAuthError,
        Option<String>,
        Option<DesktopWorkspaceSummary>,
    )>,
>;

fn connection_removal_affects_current(
    target_is_active: bool,
    target_is_pending: bool,
    target_is_presented: bool,
) -> bool {
    target_is_active || target_is_pending || target_is_presented
}

async fn run_guarded_operation<F>(app: &AppHandle, operation: F) -> Result<(), String>
where
    F: std::future::Future<Output = Result<(), String>>,
{
    {
        let state = app.state::<DesktopHostState>();
        let mut running = state
            .operation_in_progress
            .lock()
            .map_err(|_| "desktop operation lock is poisoned".to_string())?;
        if *running {
            return Err("another desktop connection operation is already running".into());
        }
        *running = true;
    }
    let result = operation.await;
    if let Ok(mut running) = app.state::<DesktopHostState>().operation_in_progress.lock() {
        *running = false;
    }
    if let Err(error) = &result {
        let workspace = current_workspace_summary(app);
        set_connection_error(app, error, None, workspace);
        size_current_window(app);
    }
    result
}

fn runtime_for<R: Runtime>(app: &AppHandle<R>) -> Result<DesktopRuntime, String> {
    app.state::<DesktopHostState>()
        .runtime
        .lock()
        .map_err(|_| "desktop runtime lock is poisoned".to_string())?
        .clone()
        .ok_or_else(|| "desktop runtime is unavailable".to_string())
}

fn clear_pending_workspace<R: Runtime>(app: &AppHandle<R>) {
    if let Ok(mut pending) = app.state::<DesktopHostState>().pending_local.lock() {
        *pending = None;
    }
}

fn inherited_sidecar_env_allowed(key: &std::ffi::OsStr) -> bool {
    let key = key.to_string_lossy();
    key != "HOST"
        && key != "PORT"
        && (!key.starts_with("WORKTABLE_") || key == "WORKTABLE_PUBLIC_URL")
}

fn inherited_sidecar_environment() -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    env::vars_os()
        .filter(|(key, _)| inherited_sidecar_env_allowed(key))
        .collect()
}

fn configured_sidecar<R: Runtime>(
    app: &AppHandle<R>,
    runtime: &DesktopRuntime,
    args: Vec<String>,
) -> Result<tauri_plugin_shell::process::Command, String> {
    let mut command = app
        .shell()
        .sidecar("worktable")
        .map_err(|error| format!("failed to resolve packaged Worktable sidecar: {error}"))?
        .env_clear()
        .envs(inherited_sidecar_environment())
        .args(args)
        .env("WORKTABLE_RELEASE_DIR", &runtime.packaged.release_root)
        .env("WORKTABLE_STATIC_DIR", &runtime.packaged.static_root)
        .env("WORKTABLE_VERSION", &runtime.packaged.version)
        .env("WORKTABLE_NO_UPDATE_CHECK", "1");
    if let Some(path) = &runtime.local_app_data_root {
        command = command.env("WORKTABLE_APP_DIR", path);
    }
    Ok(command)
}

fn desktop_agent_skill_args(
    operation: &str,
    target_id: &str,
    plan_id: Option<&str>,
) -> Result<Vec<String>, String> {
    if !DESKTOP_SKILL_OPERATIONS.contains(&operation) {
        return Err("unsupported Desktop agent skill operation".into());
    }
    if !DESKTOP_SKILL_TARGET_IDS.contains(&target_id) {
        return Err("unsupported Desktop agent skill target".into());
    }
    let mut args = vec!["skills".into(), operation.into(), target_id.into()];
    match plan_id {
        None => args.extend(["--preview".into(), "--json".into()]),
        Some(plan_id)
            if plan_id.len() == 64
                && plan_id
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) =>
        {
            args.extend([
                "--plan-id".into(),
                plan_id.into(),
                "--yes".into(),
                "--json".into(),
            ]);
        }
        Some(_) => return Err("invalid Desktop agent skill plan id".into()),
    }
    Ok(args)
}

fn desktop_agent_skill_status_args() -> Vec<String> {
    vec![
        "skills".into(),
        "status".into(),
        "all".into(),
        "--json".into(),
    ]
}

fn validate_desktop_agent_skill_status_envelope(
    envelope: serde_json::Value,
    command_succeeded: bool,
    stderr: &str,
) -> Result<serde_json::Value, String> {
    let statuses = envelope.get("statuses").and_then(|value| value.as_array());
    let valid_statuses = statuses.is_some_and(|statuses| {
        statuses.len() == DESKTOP_SKILL_TARGET_IDS.len()
            && DESKTOP_SKILL_TARGET_IDS.iter().all(|expected| {
                statuses
                    .iter()
                    .filter(|status| {
                        status.get("targetId").and_then(|value| value.as_str()) == Some(*expected)
                    })
                    .count()
                    == 1
            })
    });
    if command_succeeded
        && envelope
            .get("schemaVersion")
            .and_then(|value| value.as_u64())
            == Some(2)
        && valid_statuses
    {
        return Ok(envelope);
    }
    Err(if stderr.trim().is_empty() {
        "the packaged skill status contract failed".into()
    } else {
        stderr.trim().into()
    })
}

fn validate_desktop_agent_skill_envelope(
    envelope: serde_json::Value,
    command_succeeded: bool,
    preview_command: bool,
    stderr: &str,
) -> Result<serde_json::Value, String> {
    let valid_schema = envelope
        .get("schemaVersion")
        .and_then(|value| value.as_u64())
        == Some(2);
    let rejected_preview = preview_command
        && envelope
            .pointer("/preview/allowed")
            .and_then(|value| value.as_bool())
            == Some(false)
        && envelope
            .pointer("/preview/status/detail")
            .and_then(|value| value.as_str())
            .is_some_and(|detail| !detail.trim().is_empty());
    if valid_schema && (command_succeeded || rejected_preview) {
        return Ok(envelope);
    }
    Err(if stderr.trim().is_empty() {
        "the packaged skill installer contract failed".into()
    } else {
        stderr.trim().into()
    })
}

async fn run_desktop_agent_skill_command(
    app: &AppHandle,
    operation: &str,
    target_id: &str,
    plan_id: Option<&str>,
) -> Result<serde_json::Value, String> {
    let runtime = runtime_for(app)?;
    let args = desktop_agent_skill_args(operation, target_id, plan_id)?;
    let output = configured_sidecar(app, &runtime, args)?
        .output()
        .await
        .map_err(|error| format!("failed to run the packaged skill installer: {error}"))?;
    let envelope: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|error| {
        format!(
            "the packaged skill installer returned invalid JSON: {error} ({})",
            String::from_utf8_lossy(&output.stderr).trim()
        )
    })?;
    validate_desktop_agent_skill_envelope(
        envelope,
        output.status.success(),
        plan_id.is_none(),
        &String::from_utf8_lossy(&output.stderr),
    )
}

async fn run_desktop_agent_skill_status(app: &AppHandle) -> Result<serde_json::Value, String> {
    let runtime = runtime_for(app)?;
    let output = configured_sidecar(app, &runtime, desktop_agent_skill_status_args())?
        .output()
        .await
        .map_err(|error| format!("failed to read packaged agent skill status: {error}"))?;
    let envelope: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|error| {
        format!(
            "the packaged skill status returned invalid JSON: {error} ({})",
            String::from_utf8_lossy(&output.stderr).trim()
        )
    })?;
    validate_desktop_agent_skill_status_envelope(
        envelope,
        output.status.success(),
        &String::from_utf8_lossy(&output.stderr),
    )
}

#[tauri::command]
async fn desktop_agent_skills_status(
    webview: Webview,
    app: AppHandle,
    state: State<'_, DesktopHostState>,
) -> Result<serde_json::Value, String> {
    require_desktop_agent_skill_surface(&webview, &state)?;
    run_desktop_agent_skill_status(&app).await
}

#[tauri::command]
async fn desktop_agent_skills_preview(
    webview: Webview,
    app: AppHandle,
    state: State<'_, DesktopHostState>,
    target_id: String,
    operation: String,
) -> Result<serde_json::Value, String> {
    require_desktop_agent_skill_surface(&webview, &state)?;
    run_desktop_agent_skill_command(&app, &operation, &target_id, None).await
}

#[tauri::command]
async fn desktop_agent_skills_apply(
    webview: Webview,
    app: AppHandle,
    state: State<'_, DesktopHostState>,
    target_id: String,
    operation: String,
    plan_id: String,
) -> Result<serde_json::Value, String> {
    require_desktop_agent_skill_surface(&webview, &state)?;
    run_desktop_agent_skill_command(&app, &operation, &target_id, Some(&plan_id)).await
}

async fn inspect_workspace(
    app: &AppHandle,
    path: Option<String>,
) -> Result<WorkspaceInspection, String> {
    let runtime = runtime_for(app)?;
    let mut args = vec!["workspace".into(), "inspect".into(), "--json".into()];
    let path = match path {
        Some(path) => Some(path),
        None => desktop_default_workspace_override()?,
    };
    if let Some(path) = path {
        args.push(path);
    }
    let output = configured_sidecar(app, &runtime, args)?
        .output()
        .await
        .map_err(|error| format!("failed to inspect workspace: {error}"))?;
    let envelope: InspectionEnvelope = serde_json::from_slice(&output.stdout).map_err(|error| {
        format!(
            "workspace inspector returned invalid JSON: {error} ({})",
            String::from_utf8_lossy(&output.stderr).trim()
        )
    })?;
    if !output.status.success()
        || !envelope.ok
        || envelope.schema_version != LOCAL_MACHINE_CONTRACT_SCHEMA_VERSION
    {
        return Err("workspace inspector contract failed".into());
    }
    Ok(envelope.inspection)
}

#[cfg(debug_assertions)]
fn desktop_default_workspace_override() -> Result<Option<String>, String> {
    let Some(value) = env::var_os("WORKTABLE_DESKTOP_DEFAULT_WORKSPACE") else {
        return Ok(None);
    };
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err("WORKTABLE_DESKTOP_DEFAULT_WORKSPACE must be absolute".into());
    }
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[cfg(not(debug_assertions))]
fn desktop_default_workspace_override() -> Result<Option<String>, String> {
    Ok(None)
}

async fn prepare_workspace(
    app: &AppHandle,
    path: &str,
    intent: &str,
) -> Result<WorkspacePrepared, String> {
    let runtime = runtime_for(app)?;
    let args = vec![
        "workspace".into(),
        "prepare".into(),
        path.into(),
        "--intent".into(),
        intent.into(),
        "--json".into(),
    ];
    let output = configured_sidecar(app, &runtime, args)?
        .output()
        .await
        .map_err(|error| format!("failed to prepare workspace: {error}"))?;
    let envelope: PreparationEnvelope =
        serde_json::from_slice(&output.stdout).map_err(|error| {
            format!(
                "workspace preparer returned invalid JSON: {error} ({})",
                String::from_utf8_lossy(&output.stderr).trim()
            )
        })?;
    if envelope.schema_version != LOCAL_MACHINE_CONTRACT_SCHEMA_VERSION {
        return Err("workspace preparer contract version is unsupported".into());
    }
    if envelope.ok && output.status.success() {
        return envelope
            .prepared
            .ok_or_else(|| "workspace preparer omitted its result".to_string());
    }
    let error = envelope
        .error
        .map(|error| error.message)
        .unwrap_or_else(|| "workspace preparation failed".into());
    Err(error)
}

async fn activate_local_workspace(
    app: &AppHandle,
    prepared: &WorkspacePrepared,
    preferred_port: Option<u16>,
) -> Result<LocalActivationEnvelope, String> {
    let runtime = runtime_for(app)?;
    let mut args = vec![
        "local-host".into(),
        "activate".into(),
        prepared.path.clone(),
        "--json".into(),
    ];
    if prepared.created {
        args.push("--wait-for-welcome".into());
    }
    if let Some(port) = preferred_port.filter(|port| *port > 0) {
        args.push("--port".into());
        args.push(port.to_string());
    }
    let output = configured_sidecar(app, &runtime, args)?
        .output()
        .await
        .map_err(|error| format!("failed to activate local workspace: {error}"))?;
    let envelope: LocalActivationEnvelope =
        serde_json::from_slice(&output.stdout).map_err(|error| {
            format!(
                "local workspace authority returned invalid JSON: {error} ({})",
                String::from_utf8_lossy(&output.stderr).trim()
            )
        })?;
    if envelope.schema_version != LOCAL_MACHINE_CONTRACT_SCHEMA_VERSION {
        return Err("local workspace authority contract version is unsupported".into());
    }
    if !output.status.success() || !envelope.ok {
        return Err(envelope
            .error
            .map(|error| error.message)
            .unwrap_or_else(|| "local workspace activation failed".into()));
    }
    let workspace = envelope
        .workspace
        .as_ref()
        .ok_or_else(|| "local workspace authority omitted its workspace".to_string())?;
    if workspace.id != prepared.workspace.id || workspace.path != prepared.path {
        return Err("local workspace authority selected a different workspace".into());
    }
    if envelope.port.is_none()
        || envelope.origin.is_none()
        || envelope.action.is_none()
        || envelope.logs_path.is_none()
    {
        return Err("local workspace authority omitted its endpoint action".into());
    }
    Ok(envelope)
}

async fn inspect_local_authority(app: &AppHandle) -> Result<LocalAuthorityInspection, String> {
    inspect_local_authority_detailed(app)
        .await
        .map_err(|error| error.message)
}

async fn inspect_local_authority_detailed(
    app: &AppHandle,
) -> Result<LocalAuthorityInspection, LocalAuthorityCommandError> {
    let runtime = runtime_for(app).map_err(LocalAuthorityCommandError::untyped)?;
    let output = configured_sidecar(
        app,
        &runtime,
        vec!["local-host".into(), "inspect".into(), "--json".into()],
    )
    .map_err(LocalAuthorityCommandError::untyped)?
    .output()
    .await
    .map_err(|error| {
        LocalAuthorityCommandError::untyped(format!(
            "failed to inspect local Worktable authority: {error}"
        ))
    })?;
    let inspection: LocalAuthorityInspection =
        serde_json::from_slice(&output.stdout).map_err(|error| {
            LocalAuthorityCommandError::untyped(format!(
                "local Worktable authority returned invalid JSON: {error} ({})",
                String::from_utf8_lossy(&output.stderr).trim()
            ))
        })?;
    if inspection.schema_version != LOCAL_MACHINE_CONTRACT_SCHEMA_VERSION {
        return Err(LocalAuthorityCommandError::untyped(
            "local Worktable authority contract version is unsupported",
        ));
    }
    if !output.status.success() || !inspection.ok {
        let error = inspection.error.unwrap_or(LocalActivationError {
            code: None,
            message: "local Worktable authority is unavailable".into(),
        });
        return Err(LocalAuthorityCommandError {
            code: error.code,
            message: error.message,
        });
    }
    Ok(inspection)
}

async fn discover_existing_installation(
    app: &AppHandle,
) -> Result<Option<DesktopExistingInstallation>, String> {
    let authority = inspect_local_authority(app).await?;
    if authority.configured != Some(true) {
        return Ok(None);
    }
    let config = authority
        .config
        .ok_or_else(|| "configured local authority omitted its config".to_string())?;
    let Some(workspace) = adoptable_existing_workspace(
        inspect_workspace(app, Some(config.workspace.clone())).await?,
    )?
    else {
        return Ok(None);
    };
    let runtime = authority
        .runtime
        .filter(|runtime| runtime_matches_workspace(runtime, &workspace));
    let service = authority
        .service
        .ok_or_else(|| "local authority omitted service status".to_string())?;
    Ok(Some(DesktopExistingInstallation {
        workspace,
        origin: config.origin,
        running: runtime
            .as_ref()
            .is_some_and(|runtime| runtime.endpoint_verified),
        owner: runtime.map(|runtime| runtime.owner),
        service_installed: service.installed,
        service_state: service.state,
        logs_path: service.logs.stdout,
        requires_owner_login: config.requires_owner_login,
    }))
}

fn runtime_matches_workspace(
    runtime: &LocalAuthorityRuntime,
    workspace: &DesktopWorkspaceSummary,
) -> bool {
    runtime.workspace_id == workspace.id
        && workspace
            .path
            .as_deref()
            .is_some_and(|path| Path::new(&runtime.workspace_path) == Path::new(path))
}

fn authority_matches_workspace_endpoint(
    authority: &LocalAuthorityInspection,
    workspace: &DesktopWorkspaceSummary,
    host: &str,
    port: u16,
) -> bool {
    let config_matches = authority.config.as_ref().is_some_and(|config| {
        workspace
            .path
            .as_deref()
            .is_some_and(|path| Path::new(&config.workspace) == Path::new(path))
            && config.host == host
            && config.port == port
    });
    let runtime_matches = authority.runtime.as_ref().is_some_and(|runtime| {
        runtime.endpoint_verified
            && runtime_matches_workspace(runtime, workspace)
            && runtime.host == host
            && runtime.port == port
    });
    config_matches && runtime_matches
}

fn adoptable_existing_workspace(
    inspection: WorkspaceInspection,
) -> Result<Option<DesktopWorkspaceSummary>, String> {
    match inspection {
        WorkspaceInspection::Valid { path, workspace } => Ok(Some(DesktopWorkspaceSummary {
            id: workspace.id,
            name: workspace.name,
            path: Some(path),
        })),
        // A stale shared CLI config is not an adoptable installation. Let normal
        // Desktop workspace selection continue instead of turning first run into
        // a generic initialization failure.
        WorkspaceInspection::Missing { .. } | WorkspaceInspection::Empty { .. } => Ok(None),
        WorkspaceInspection::Reject { message, .. } => Err(message),
    }
}

fn write_active_port(app_data_root: &Path, port: u16) -> Result<(), String> {
    std::fs::create_dir_all(app_data_root).map_err(|error| {
        format!(
            "failed to create desktop app data {}: {error}",
            app_data_root.display()
        )
    })?;
    let port_path = app_data_root.join("desktop-port");
    let temporary_path = app_data_root.join(format!("desktop-port.{}.tmp", process::id()));
    std::fs::write(&temporary_path, format!("{port}\n"))
        .and_then(|_| std::fs::rename(&temporary_path, &port_path))
        .map_err(|error| format!("failed to persist desktop port: {error}"))
}

fn profile_preferred_port(app: &AppHandle, workspace_id: &str) -> Result<Option<u16>, String> {
    let state = app.state::<DesktopHostState>();
    let connections = state
        .connections
        .lock()
        .map_err(|_| "desktop connections lock is poisoned".to_string())?;
    let mut preferred = None;
    for profile in &connections.profiles {
        if let DesktopConnectionProfile::Local {
            workspace_id: id,
            port,
            ..
        } = profile
        {
            if id == workspace_id {
                preferred = Some(*port);
            }
        }
    }
    Ok(preferred)
}

fn persist_local_profile(
    app: &AppHandle,
    prepared: &WorkspacePrepared,
    port: u16,
) -> Result<DesktopConnectionProfile, String> {
    let profile = DesktopConnectionProfile::local(
        prepared.workspace.name.clone(),
        prepared.workspace.id.clone(),
        prepared.path.clone(),
        port,
    );
    let next = {
        let state = app.state::<DesktopHostState>();
        let current = state
            .connections
            .lock()
            .map_err(|_| "desktop connections lock is poisoned".to_string())?;
        let mut next = current.clone();
        next.activate(profile.clone());
        next
    };
    persist_desktop_connections(app, next)?;
    Ok(profile)
}

fn active_local_profile<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<DesktopConnectionProfile, String> {
    app.state::<DesktopHostState>()
        .connections
        .lock()
        .map_err(|_| "desktop connections lock is poisoned".to_string())?
        .active()
        .cloned()
        .ok_or_else(|| "no saved desktop connection is active".to_string())
}

fn workspace_has_saved_connection<R: Runtime>(
    app: &AppHandle<R>,
    workspace: Option<&DesktopWorkspaceSummary>,
) -> bool {
    let Some(workspace) = workspace else {
        return false;
    };
    matches!(
        active_local_profile(app),
        Ok(DesktopConnectionProfile::Local {
            workspace_id,
            workspace_path,
            ..
        }) if workspace_id == workspace.id && workspace.path.as_deref() == Some(workspace_path.as_str())
    )
}

fn initial_workspace_path(created: bool) -> &'static str {
    if created {
        "/spaces/welcome/widgets/welcome"
    } else {
        "/"
    }
}

async fn start_prepared_local(
    app: &AppHandle,
    prepared: WorkspacePrepared,
    persist: bool,
) -> Result<(), String> {
    if persist {
        app.state::<DesktopHostState>()
            .pending_local
            .lock()
            .map_err(|_| "pending workspace lock is poisoned".to_string())?
            .replace(prepared.clone());
    }
    let preferred = profile_preferred_port(app, &prepared.workspace.id)?;
    // A retry may still own its saved endpoint. Stop that child before asking
    // the shared authority to attach or activate the selected workspace.
    stop_local_host(app);
    close_workspace_webview(app);
    let activation = activate_local_workspace(app, &prepared, preferred).await?;
    let port = activation
        .port
        .ok_or_else(|| "local workspace authority omitted its port".to_string())?;
    write_active_port(&runtime_for(app)?.shell_data_root, port)?;
    match activation.action.as_deref() {
        Some("start-owned") => {
            let logs_path = activation
                .logs_path
                .clone()
                .ok_or_else(|| "local workspace authority omitted its log path".to_string())?;
            let host = activation
                .host
                .clone()
                .ok_or_else(|| "local workspace authority omitted its host".to_string())?;
            let origin = activation
                .origin
                .clone()
                .ok_or_else(|| "local workspace authority omitted its origin".to_string())?;
            start_local_host(app, prepared, host, port, origin, logs_path, persist)
        }
        Some("attach") => attach_local_host(app, prepared, activation, persist),
        Some(action) => Err(format!("unsupported local workspace action: {action}")),
        None => Err("local workspace authority omitted its action".into()),
    }
}

fn attach_local_host(
    app: &AppHandle,
    prepared: WorkspacePrepared,
    activation: LocalActivationEnvelope,
    persist: bool,
) -> Result<(), String> {
    let workspace = activation
        .workspace
        .ok_or_else(|| "local workspace authority omitted its workspace".to_string())?;
    let port = activation
        .port
        .ok_or_else(|| "local workspace authority omitted its port".to_string())?;
    let origin = activation
        .origin
        .ok_or_else(|| "local workspace authority omitted its origin".to_string())?;
    let host = activation
        .host
        .filter(|host| !host.is_empty())
        .ok_or_else(|| "local workspace authority omitted its host".to_string())?;
    let logs_path = activation
        .logs_path
        .ok_or_else(|| "local workspace authority omitted its log path".to_string())?;
    let summary = DesktopWorkspaceSummary {
        id: workspace.id,
        name: workspace.name,
        path: Some(workspace.path),
    };
    let monitor_token = desktop_instance_token()?;
    let initial_path = initial_workspace_path(prepared.created);
    create_workspace_webview(app, origin.clone(), initial_path, None)?;
    if persist {
        if let Err(error) = persist_local_profile(app, &prepared, port) {
            close_workspace_webview(app);
            return Err(format!(
                "The workspace is ready, but Desktop could not remember it: {error}"
            ));
        }
    }
    if let Err(error) = app
        .state::<DesktopHostState>()
        .active_instance_token
        .lock()
        .map_err(|_| "desktop instance lock is poisoned".to_string())
        .map(|mut active| active.replace(monitor_token.clone()))
    {
        close_workspace_webview(app);
        return Err(error);
    }
    clear_pending_workspace(app);
    set_status(
        app,
        DesktopBootstrapStatus::ready(origin.clone(), summary.clone()),
    );
    monitor_attached_local_host(
        app.clone(),
        monitor_token,
        host,
        port,
        origin,
        summary,
        logs_path,
    );
    Ok(())
}

fn monitor_attached_local_host(
    app: AppHandle,
    monitor_token: String,
    host: String,
    port: u16,
    origin: String,
    summary: DesktopWorkspaceSummary,
    logs_path: String,
) {
    tauri::async_runtime::spawn(async move {
        let mut consecutive_failures = 0_u8;
        loop {
            tokio::time::sleep(ATTACHED_HOST_MONITOR_INTERVAL).await;
            if !local_instance_is_active(&app, &monitor_token) {
                return;
            }
            if !attached_host_requires_recovery(
                &mut consecutive_failures,
                attached_local_authority_matches(&app, &summary, &host, port).await,
            ) {
                continue;
            }

            if !local_instance_is_active(&app, &monitor_token) {
                return;
            }
            let message = "The connected local Worktable host stopped responding.";
            append_desktop_host_log(&logs_path, message);
            let recovery_app = app.clone();
            let _ = app.run_on_main_thread(move || {
                if !clear_local_instance_if_active(&recovery_app, &monitor_token) {
                    return;
                }
                close_workspace_webview(&recovery_app);
                set_connection_error(&recovery_app, message, Some(origin), Some(summary));
                size_current_window(&recovery_app);
            });
            return;
        }
    });
}

async fn attached_local_authority_matches(
    app: &AppHandle,
    workspace: &DesktopWorkspaceSummary,
    host: &str,
    port: u16,
) -> bool {
    inspect_local_authority(app).await.is_ok_and(|authority| {
        authority_matches_workspace_endpoint(&authority, workspace, host, port)
    })
}

fn desktop_instance_token() -> Result<String, String> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("system clock cannot create a desktop instance token: {error}"))?
        .as_nanos();
    Ok(format!("desktop-{}-{nanos}", process::id()))
}

fn desktop_verification_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|error| format!("failed to create desktop verification token: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[derive(Debug, Deserialize)]
struct WorktableHealth {
    service: String,
}

#[derive(Debug, Deserialize)]
struct WorkspaceResponse {
    id: String,
    name: String,
}

enum HttpResponseProgress {
    Incomplete,
    Complete(String, String),
    Invalid,
}

fn parse_http_response(response: &[u8], eof: bool) -> HttpResponseProgress {
    let Some(header_end) = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 4)
    else {
        return if eof {
            HttpResponseProgress::Invalid
        } else {
            HttpResponseProgress::Incomplete
        };
    };
    let Ok(headers) = std::str::from_utf8(&response[..header_end - 4]) else {
        return HttpResponseProgress::Invalid;
    };
    if headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        != Some("200")
    {
        return HttpResponseProgress::Invalid;
    }

    let mut content_length = None;
    for line in headers.lines().skip(1) {
        let Some((name, value)) = line.split_once(':') else {
            return HttpResponseProgress::Invalid;
        };
        if name.eq_ignore_ascii_case("content-length") {
            let Ok(parsed) = value.trim().parse::<usize>() else {
                return HttpResponseProgress::Invalid;
            };
            if content_length.is_some_and(|existing| existing != parsed) {
                return HttpResponseProgress::Invalid;
            }
            content_length = Some(parsed);
        }
        if name.eq_ignore_ascii_case("transfer-encoding")
            && !value.trim().eq_ignore_ascii_case("identity")
        {
            return HttpResponseProgress::Invalid;
        }
    }

    let body = &response[header_end..];
    let body_length = match content_length {
        Some(expected) if body.len() < expected => return HttpResponseProgress::Incomplete,
        Some(expected) => expected,
        None if !eof => return HttpResponseProgress::Incomplete,
        None => body.len(),
    };
    let Ok(body) = std::str::from_utf8(&body[..body_length]) else {
        return HttpResponseProgress::Invalid;
    };
    HttpResponseProgress::Complete(headers.to_string(), body.to_string())
}

fn connectable_host(host: &str) -> &str {
    let trimmed = host.trim();
    match trimmed.to_ascii_lowercase().as_str() {
        "0.0.0.0" | "::" | "[::]" => "127.0.0.1",
        _ => trimmed
            .strip_prefix('[')
            .and_then(|value| value.strip_suffix(']'))
            .unwrap_or(trimmed),
    }
}

fn http_get_with_read_timeout(
    host: &str,
    port: u16,
    path: &str,
    verification_token: Option<&str>,
    read_timeout: Duration,
) -> Option<(String, String)> {
    let connect_host = connectable_host(host);
    let mut stream = (connect_host, port)
        .to_socket_addrs()
        .ok()?
        .find_map(|address| {
            TcpStream::connect_timeout(&address, Duration::from_millis(350)).ok()
        })?;
    let _ = stream.set_read_timeout(Some(read_timeout));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    let request_host = if connect_host.contains(':') {
        format!("[{connect_host}]")
    } else {
        connect_host.to_string()
    };
    let verification_header = verification_token
        .map(|token| format!("X-Worktable-Host-Verification: {token}\r\n"))
        .unwrap_or_default();
    stream
        .write_all(
            format!(
                "GET {path} HTTP/1.1\r\nHost: {request_host}:{port}\r\nAccept-Encoding: identity\r\n{verification_header}Connection: close\r\n\r\n"
            )
            .as_bytes(),
        )
        .ok()?;
    let mut response = Vec::new();
    let mut chunk = [0_u8; 8192];
    loop {
        match parse_http_response(&response, false) {
            HttpResponseProgress::Complete(headers, body) => return Some((headers, body)),
            HttpResponseProgress::Invalid => return None,
            HttpResponseProgress::Incomplete => {}
        }
        match stream.read(&mut chunk) {
            Ok(0) => {
                return match parse_http_response(&response, true) {
                    HttpResponseProgress::Complete(headers, body) => Some((headers, body)),
                    HttpResponseProgress::Incomplete | HttpResponseProgress::Invalid => None,
                };
            }
            Ok(read) if response.len() + read <= MAX_HTTP_RESPONSE_BYTES => {
                response.extend_from_slice(&chunk[..read]);
            }
            Ok(_) => return None,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return None,
        }
    }
}

fn http_get(
    host: &str,
    port: u16,
    path: &str,
    verification_token: Option<&str>,
) -> Option<(String, String)> {
    http_get_with_read_timeout(host, port, path, verification_token, HTTP_READ_TIMEOUT)
}

fn worktable_health_matches(headers: &str, body: &str, expected_instance_token: &str) -> bool {
    let instance_header_matches = headers.lines().any(|line| {
        line.split_once(':').is_some_and(|(name, value)| {
            name.eq_ignore_ascii_case("x-worktable-host-instance")
                && value.trim() == expected_instance_token
        })
    });
    instance_header_matches && worktable_health_body_matches(body)
}

fn worktable_health_body_matches(body: &str) -> bool {
    serde_json::from_str::<WorktableHealth>(body).is_ok_and(|health| health.service == "worktable")
}

fn attached_host_requires_recovery(consecutive_failures: &mut u8, available: bool) -> bool {
    if available {
        *consecutive_failures = 0;
        return false;
    }
    *consecutive_failures = consecutive_failures.saturating_add(1);
    *consecutive_failures >= ATTACHED_HOST_FAILURE_LIMIT
}

fn verified_workspace(
    host: &str,
    port: u16,
    expected_instance_token: &str,
    verification_token: &str,
    expected_workspace_id: &str,
) -> Option<WorkspaceResponse> {
    let (headers, health_body) = http_get(host, port, "/health", None)?;
    if !worktable_health_matches(&headers, &health_body, expected_instance_token) {
        return None;
    }
    let (_, workspace_body) = http_get(host, port, "/api/workspace", Some(verification_token))?;
    let workspace: WorkspaceResponse = serde_json::from_str(&workspace_body).ok()?;
    (workspace.id == expected_workspace_id).then_some(workspace)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FirstRunDestination {
    Welcome,
    Root,
}

fn first_run_destination(
    host: &str,
    port: u16,
    verification_token: &str,
    read_timeout: Duration,
) -> Option<FirstRunDestination> {
    let (_, body) = http_get_with_read_timeout(
        host,
        port,
        "/api/spaces",
        Some(verification_token),
        read_timeout,
    )?;
    first_run_destination_from_spaces(&body)
}

fn first_run_destination_from_spaces(body: &str) -> Option<FirstRunDestination> {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("spaces")
                .and_then(|spaces| spaces.as_array())
                .cloned()
        })
        .and_then(|spaces| {
            for space in spaces {
                let is_welcome = space.get("id").and_then(|id| id.as_str()) == Some("welcome");
                if !is_welcome {
                    return Some(FirstRunDestination::Root);
                }
                let settings = space.get("settings");
                let is_worktable_seed = settings
                    .and_then(|settings| settings.get("starterSeedVersion"))
                    .is_some();
                if !is_worktable_seed {
                    return Some(FirstRunDestination::Root);
                }
                let complete = settings
                    .and_then(|settings| settings.get("starterSeedVersion"))
                    .and_then(|version| version.as_u64())
                    == Some(1)
                    && settings
                        .and_then(|settings| settings.get("starterSeedStatus"))
                        .and_then(|status| status.as_str())
                        == Some("complete")
                    && space
                        .get("widgets")
                        .and_then(|widgets| widgets.as_array())
                        .is_some_and(|widgets| {
                            widgets.iter().any(|widget| {
                                widget.get("id").and_then(|id| id.as_str()) == Some("welcome")
                            })
                        });
                if complete {
                    return Some(FirstRunDestination::Welcome);
                }
            }
            None
        })
}

#[cfg(test)]
fn welcome_seed_response_ready(body: &str) -> bool {
    first_run_destination_from_spaces(body).is_some()
}

#[cfg(test)]
fn welcome_seed_ready(
    host: &str,
    port: u16,
    verification_token: &str,
    read_timeout: Duration,
) -> bool {
    first_run_destination(host, port, verification_token, read_timeout).is_some()
}

fn append_desktop_host_log(path: &str, message: &str) {
    let path = Path::new(path);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or_default();
        let _ = writeln!(file, "[{timestamp}] {message}");
    }
}

fn next_connection_generation<R: Runtime>(app: &AppHandle<R>) -> u64 {
    let state = app.state::<DesktopHostState>();
    let generation = state
        .connection_generation
        .fetch_add(1, Ordering::SeqCst)
        .wrapping_add(1);
    state
        .cloud_cookie_refresh_pending
        .store(0, Ordering::SeqCst);
    state.cloud_cookie_refresh_at.store(0, Ordering::SeqCst);
    state.connection_changed.notify_waiters();
    generation
}

fn connection_generation_is_active<R: Runtime>(app: &AppHandle<R>, generation: u64) -> bool {
    captured_generation_is_active(
        app.state::<DesktopHostState>()
            .connection_generation
            .load(Ordering::SeqCst),
        generation,
        app.state::<DesktopHostState>()
            .shutdown_started
            .load(Ordering::SeqCst),
    )
}

fn captured_generation_is_active(current: u64, captured: u64, shutting_down: bool) -> bool {
    current == captured && !shutting_down
}

fn remote_http_client<R: Runtime>(app: &AppHandle<R>) -> Result<RemoteHttpClient, String> {
    let state = app.state::<DesktopHostState>();
    let mut current = state
        .remote_http
        .lock()
        .map_err(|_| "remote HTTP client lock is poisoned".to_string())?;
    if current.is_none() {
        *current = Some(RemoteHttpClient::new()?);
    }
    current
        .clone()
        .ok_or_else(|| "remote HTTP client is unavailable".to_string())
}

fn begin_remote_connection(
    app: &AppHandle,
    pending: PendingRemoteConnection,
) -> Result<(), String> {
    stop_local_host(app);
    close_workspace_webview(app);
    clear_pending_workspace(app);
    let generation = next_connection_generation(app);
    app.state::<DesktopHostState>()
        .remote_probe_in_progress
        .store(false, Ordering::SeqCst);
    *app.state::<DesktopHostState>()
        .pending_remote
        .lock()
        .map_err(|_| "pending remote connection lock is poisoned".to_string())? =
        Some(pending.clone());
    set_status(
        app,
        DesktopBootstrapStatus::remote_progress(
            "checkingRemote",
            "Checking the self-hosted Worktable…",
            pending.origin.clone(),
            pending.profile_id.clone(),
        ),
    );
    let probe_app = app.clone();
    tauri::async_runtime::spawn(async move {
        run_remote_probe(probe_app, generation, true).await;
    });
    Ok(())
}

fn session_cookie_for_origin<R: Runtime>(
    app: &AppHandle<R>,
    origin: &tauri::Url,
) -> Result<Option<String>, String> {
    let webview = app
        .get_webview(WORKSPACE_WEBVIEW_LABEL)
        .or_else(|| app.get_webview(TRUSTED_WEBVIEW_LABEL))
        .ok_or_else(|| "Desktop webview cookie store is unavailable".to_string())?;
    let cookies = webview
        .cookies_for_url(origin.clone())
        .map_err(|error| format!("failed to read the Worktable session: {error}"))?;
    Ok(cookies
        .into_iter()
        .find(|cookie| cookie.name() == "wt_session")
        .map(|cookie| cookie.value().to_string()))
}

async fn run_remote_probe(app: AppHandle, generation: u64, verify_service: bool) {
    if !connection_generation_is_active(&app, generation)
        || app
            .state::<DesktopHostState>()
            .remote_probe_in_progress
            .swap(true, Ordering::SeqCst)
    {
        return;
    }
    let result = perform_remote_probe(&app, generation, verify_service).await;
    app.state::<DesktopHostState>()
        .remote_probe_in_progress
        .store(false, Ordering::SeqCst);
    if !connection_generation_is_active(&app, generation) {
        return;
    }
    if let Err(error) = result {
        set_remote_connection_error(&app, error);
    }
}

async fn perform_remote_probe(
    app: &AppHandle,
    generation: u64,
    verify_service: bool,
) -> Result<(), RemoteConnectionError> {
    let pending = app
        .state::<DesktopHostState>()
        .pending_remote
        .lock()
        .map_err(|_| RemoteConnectionError {
            code: "REMOTE_STATE_UNAVAILABLE",
            message: "Desktop could not read the pending remote connection.".into(),
            transient: false,
        })?
        .clone()
        .ok_or_else(|| RemoteConnectionError {
            code: "REMOTE_STATE_UNAVAILABLE",
            message: "No self-hosted connection is pending.".into(),
            transient: false,
        })?;
    let origin = normalize_remote_origin(&pending.origin)?;
    let client = remote_http_client(app).map_err(|message| RemoteConnectionError {
        code: "REMOTE_CLIENT_UNAVAILABLE",
        message,
        transient: false,
    })?;
    if verify_service {
        client.verify_service(&origin).await?;
    }
    if !connection_generation_is_active(app, generation) {
        return Ok(());
    }
    let session_cookie =
        session_cookie_for_origin(app, &origin).map_err(|message| RemoteConnectionError {
            code: "REMOTE_SESSION_READ_FAILED",
            message,
            transient: false,
        })?;
    match client
        .probe_workspace(&origin, session_cookie.as_deref())
        .await?
    {
        WorkspaceProbe::AuthenticationRequired => {
            if !connection_generation_is_active(app, generation) {
                return Ok(());
            }
            set_status(
                app,
                DesktopBootstrapStatus::remote_progress(
                    "authenticatingRemote",
                    "Sign in to the self-hosted Worktable to continue.",
                    pending.origin.clone(),
                    pending.profile_id.clone(),
                ),
            );
            if app.get_webview(WORKSPACE_WEBVIEW_LABEL).is_none() {
                create_workspace_webview(app, pending.origin, "/login?next=/", None).map_err(
                    |message| RemoteConnectionError {
                        code: "REMOTE_WEBVIEW_FAILED",
                        message,
                        transient: false,
                    },
                )?;
            }
            Ok(())
        }
        WorkspaceProbe::Ready(workspace) => {
            if pending
                .expected_workspace_id
                .as_ref()
                .is_some_and(|expected| expected != &workspace.id)
            {
                return Err(RemoteConnectionError {
                    code: "REMOTE_WORKSPACE_ID_MISMATCH",
                    message: "That server now exposes a different workspace. Desktop will not silently retarget the saved connection.".into(),
                    transient: false,
                });
            }
            finish_remote_connection(app, generation, pending, workspace)
        }
    }
}

fn finish_remote_connection(
    app: &AppHandle,
    generation: u64,
    pending: PendingRemoteConnection,
    workspace: RemoteWorkspace,
) -> Result<(), RemoteConnectionError> {
    if !connection_generation_is_active(app, generation) {
        return Ok(());
    }
    set_status(
        app,
        DesktopBootstrapStatus::remote_progress(
            "verifyingConnection",
            "Verifying the remote workspace identity…",
            pending.origin.clone(),
            pending.profile_id.clone(),
        ),
    );
    if app.get_webview(WORKSPACE_WEBVIEW_LABEL).is_none() {
        create_workspace_webview(app, pending.origin.clone(), "/", None).map_err(|message| {
            RemoteConnectionError {
                code: "REMOTE_WEBVIEW_FAILED",
                message,
                transient: false,
            }
        })?;
    }
    let profile_id = persist_remote_profile(app, &pending, &workspace).map_err(|message| {
        close_workspace_webview(app);
        RemoteConnectionError {
            code: "REMOTE_PROFILE_WRITE_FAILED",
            message: format!("The server is ready, but Desktop could not remember it: {message}"),
            transient: false,
        }
    })?;
    let summary = DesktopWorkspaceSummary {
        id: workspace.id.clone(),
        name: workspace.name,
        path: None,
    };
    let ready_origin = pending.origin.clone();
    if let Ok(mut current) = app.state::<DesktopHostState>().pending_remote.lock() {
        current.replace(PendingRemoteConnection {
            profile_id: Some(profile_id.clone()),
            expected_workspace_id: Some(workspace.id),
            ..pending
        });
    }
    set_status(
        app,
        DesktopBootstrapStatus::remote_ready(ready_origin, profile_id.clone(), summary),
    );
    start_remote_monitor(app.clone(), generation);
    Ok(())
}

fn persist_remote_profile(
    app: &AppHandle,
    pending: &PendingRemoteConnection,
    workspace: &RemoteWorkspace,
) -> Result<String, String> {
    let profile_id = match &pending.profile_id {
        Some(id) => id.clone(),
        None => desktop_remote_profile_id()?,
    };
    let next = {
        let state = app.state::<DesktopHostState>();
        let current = state
            .connections
            .lock()
            .map_err(|_| "desktop connections lock is poisoned".to_string())?;
        let mut next = current.clone();
        next.activate(DesktopConnectionProfile::self_hosted(
            profile_id.clone(),
            workspace.name.clone(),
            pending.origin.clone(),
            workspace.id.clone(),
            pending.allow_insecure_http,
        ));
        next
    };
    persist_desktop_connections(app, next)?;
    Ok(profile_id)
}

fn desktop_remote_profile_id() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::getrandom(&mut bytes)
        .map_err(|error| format!("failed to create a remote profile id: {error}"))?;
    Ok(format!(
        "self-hosted:{}",
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

fn set_remote_connection_error(app: &AppHandle, error: RemoteConnectionError) {
    let pending = app
        .state::<DesktopHostState>()
        .pending_remote
        .lock()
        .ok()
        .and_then(|pending| pending.clone());
    let Some(pending) = pending else {
        return;
    };
    close_workspace_webview(app);
    let workspace = pending
        .expected_workspace_id
        .as_ref()
        .map(|id| DesktopWorkspaceSummary {
            id: id.clone(),
            name: saved_remote_display_name(app, pending.profile_id.as_deref())
                .unwrap_or_else(|| "Self-hosted Worktable".into()),
            path: None,
        });
    set_status(
        app,
        DesktopBootstrapStatus::remote_recovery(
            error.message,
            error.code,
            pending.origin,
            pending.profile_id,
            workspace,
            true,
        ),
    );
    size_current_window(app);
}

fn saved_remote_display_name(app: &AppHandle, profile_id: Option<&str>) -> Option<String> {
    let profile_id = profile_id?;
    app.state::<DesktopHostState>()
        .connections
        .lock()
        .ok()?
        .profiles
        .iter()
        .find_map(|profile| match profile {
            DesktopConnectionProfile::SelfHosted {
                id, display_name, ..
            } if id == profile_id => Some(display_name.clone()),
            _ => None,
        })
}

fn start_remote_monitor(app: AppHandle, generation: u64) {
    tauri::async_runtime::spawn(async move {
        let mut consecutive_failures = 0_u8;
        loop {
            tokio::time::sleep(REMOTE_MONITOR_INTERVAL).await;
            if !connection_generation_is_active(&app, generation) {
                return;
            }
            if app
                .state::<DesktopHostState>()
                .remote_probe_in_progress
                .swap(true, Ordering::SeqCst)
            {
                continue;
            }
            let result = perform_remote_monitor_probe(&app).await;
            app.state::<DesktopHostState>()
                .remote_probe_in_progress
                .store(false, Ordering::SeqCst);
            if !connection_generation_is_active(&app, generation) {
                return;
            }
            match result {
                Ok(MonitorOutcome::Ready) => {
                    remote_monitor_requires_recovery(&mut consecutive_failures, true);
                }
                Ok(MonitorOutcome::AuthenticationRequired) => {
                    navigate_remote_to_login(&app);
                    return;
                }
                Err(error) if error.transient => {
                    if !remote_monitor_requires_recovery(&mut consecutive_failures, false) {
                        continue;
                    }
                    set_remote_connection_error(&app, error);
                    return;
                }
                Err(error) => {
                    set_remote_connection_error(&app, error);
                    return;
                }
            }
        }
    });
}

fn remote_monitor_requires_recovery(consecutive_failures: &mut u8, available: bool) -> bool {
    if available {
        *consecutive_failures = 0;
        return false;
    }
    *consecutive_failures = consecutive_failures.saturating_add(1);
    *consecutive_failures >= REMOTE_FAILURE_LIMIT
}

enum MonitorOutcome {
    Ready,
    AuthenticationRequired,
}

async fn perform_remote_monitor_probe(
    app: &AppHandle,
) -> Result<MonitorOutcome, RemoteConnectionError> {
    let pending = app
        .state::<DesktopHostState>()
        .pending_remote
        .lock()
        .map_err(|_| RemoteConnectionError {
            code: "REMOTE_STATE_UNAVAILABLE",
            message: "Desktop could not read the active remote connection.".into(),
            transient: false,
        })?
        .clone()
        .ok_or_else(|| RemoteConnectionError {
            code: "REMOTE_STATE_UNAVAILABLE",
            message: "The active remote connection is missing.".into(),
            transient: false,
        })?;
    let origin = normalize_remote_origin(&pending.origin)?;
    let client = remote_http_client(app).map_err(|message| RemoteConnectionError {
        code: "REMOTE_CLIENT_UNAVAILABLE",
        message,
        transient: false,
    })?;
    client.verify_service(&origin).await?;
    let cookie =
        session_cookie_for_origin(app, &origin).map_err(|message| RemoteConnectionError {
            code: "REMOTE_SESSION_READ_FAILED",
            message,
            transient: false,
        })?;
    match client.probe_workspace(&origin, cookie.as_deref()).await? {
        WorkspaceProbe::AuthenticationRequired => Ok(MonitorOutcome::AuthenticationRequired),
        WorkspaceProbe::Ready(workspace) => {
            if pending
                .expected_workspace_id
                .as_ref()
                .is_some_and(|expected| expected != &workspace.id)
            {
                Err(RemoteConnectionError {
                    code: "REMOTE_WORKSPACE_ID_MISMATCH",
                    message: "That server now exposes a different workspace. Desktop closed it instead of silently retargeting the connection.".into(),
                    transient: false,
                })
            } else {
                Ok(MonitorOutcome::Ready)
            }
        }
    }
}

fn navigate_remote_to_login(app: &AppHandle) {
    let Some(webview) = app.get_webview(WORKSPACE_WEBVIEW_LABEL) else {
        return;
    };
    let pending = app
        .state::<DesktopHostState>()
        .pending_remote
        .lock()
        .ok()
        .and_then(|pending| pending.clone());
    let Some(pending) = pending else {
        return;
    };
    let Ok(expected_origin) = normalize_remote_origin(&pending.origin) else {
        return;
    };
    let next = webview
        .url()
        .ok()
        .filter(|url| same_workspace_origin(url, &expected_origin))
        .map(|url| {
            let mut path = url.path().to_string();
            if let Some(query) = url.query() {
                path.push('?');
                path.push_str(query);
            }
            path
        })
        .unwrap_or_else(|| "/".into());
    let Ok(mut login) = expected_origin
        .join("/login")
        .map_err(|error| RemoteConnectionError {
            code: "REMOTE_ORIGIN_INVALID",
            message: error.to_string(),
            transient: false,
        })
    else {
        return;
    };
    login.query_pairs_mut().append_pair("next", &next);
    set_status(
        app,
        DesktopBootstrapStatus::remote_progress(
            "authenticatingRemote",
            "Your session expired. Sign in again to continue.",
            pending.origin,
            pending.profile_id,
        ),
    );
    let _ = webview.navigate(login);
}

fn start_local_host(
    app: &AppHandle,
    prepared: WorkspacePrepared,
    host: String,
    port: u16,
    origin: String,
    logs_path: String,
    persist_on_ready: bool,
) -> Result<(), String> {
    if app
        .state::<DesktopHostState>()
        .shutdown_started
        .load(Ordering::SeqCst)
    {
        return Err("Worktable Desktop is shutting down; the local host was not started".into());
    }
    stop_local_host(app);
    close_workspace_webview(app);
    let runtime = runtime_for(app)?;
    let instance_token = desktop_instance_token()?;
    let verification_token = desktop_verification_token()?;
    let config = LocalHostConfig {
        instance_token: instance_token.clone(),
        verification_token: verification_token.clone(),
        runtime,
    };
    let summary = DesktopWorkspaceSummary {
        id: prepared.workspace.id.clone(),
        name: prepared.workspace.name.clone(),
        path: Some(prepared.path.clone()),
    };
    let mut starting = DesktopBootstrapStatus::progress(
        "startingHost",
        "Starting the local Worktable host…",
        &prepared.path,
    );
    starting.workspace = Some(summary.clone());
    set_status(app, starting);

    // Pin the child to the activation result. If another surface changes the
    // shared config after activation returns but before this child acquires the
    // authority lock, these explicit values make the final lock holder's intent
    // authoritative instead of silently starting whichever config won the race.
    let command = configured_sidecar(
        app,
        &config.runtime,
        config.sidecar_args(&prepared.path, &host, port),
    )?
    .env("WORKTABLE_LOCAL_OWNER", "desktop")
    .env("WORKTABLE_HOST_INSTANCE_TOKEN", &config.instance_token)
    .env(
        "WORKTABLE_HOST_VERIFICATION_TOKEN",
        &config.verification_token,
    );
    let (mut events, child) = command
        .spawn()
        .map_err(|error| format!("failed to start packaged Worktable sidecar: {error}"))?;
    app.state::<DesktopHostState>()
        .child
        .lock()
        .map_err(|_| "local host child lock is poisoned".to_string())?
        .replace(child);
    // ExitRequested can race an awaited workspace preparation: it may run before
    // the child exists. Re-check after storing the child so a host that appeared
    // during shutdown is still killed before Desktop exits.
    if app
        .state::<DesktopHostState>()
        .shutdown_started
        .load(Ordering::SeqCst)
    {
        stop_local_host(app);
        return Err("Worktable Desktop shut down while the local host was starting".into());
    }
    *app.state::<DesktopHostState>()
        .active_instance_token
        .lock()
        .map_err(|_| "desktop instance lock is poisoned".to_string())? =
        Some(instance_token.clone());

    let event_app = app.clone();
    let event_origin = origin.clone();
    let event_summary = summary.clone();
    let event_token = instance_token.clone();
    let event_logs_path = logs_path.clone();
    append_desktop_host_log(&logs_path, "Desktop started its owned Worktable host.");
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    let message = String::from_utf8_lossy(&bytes);
                    println!("[worktable-sidecar] {message}");
                    append_desktop_host_log(&event_logs_path, message.trim_end());
                }
                CommandEvent::Stderr(bytes) => {
                    let message = String::from_utf8_lossy(&bytes);
                    eprintln!("[worktable-sidecar] {message}");
                    append_desktop_host_log(&event_logs_path, message.trim_end());
                }
                CommandEvent::Error(error) => {
                    eprintln!("[worktable-sidecar] {error}");
                    append_desktop_host_log(&event_logs_path, &error);
                }
                CommandEvent::Terminated(payload)
                    if local_instance_is_active(&event_app, &event_token) =>
                {
                    let recovery_app = event_app.clone();
                    let recovery_origin = event_origin.clone();
                    let recovery_summary = event_summary.clone();
                    let recovery_token = event_token.clone();
                    let message = format!("Local host exited ({:?})", payload.code);
                    append_desktop_host_log(&event_logs_path, &message);
                    let _ = event_app.run_on_main_thread(move || {
                        if !clear_local_instance_if_active(&recovery_app, &recovery_token) {
                            return;
                        }
                        close_workspace_webview(&recovery_app);
                        set_connection_error(
                            &recovery_app,
                            message,
                            Some(recovery_origin),
                            Some(recovery_summary),
                        );
                        size_current_window(&recovery_app);
                    });
                }
                _ => {}
            }
        }
    });

    let health_app = app.clone();
    let health_host = host.clone();
    let expected_id = prepared.workspace.id.clone();
    thread::spawn(move || {
        let started = Instant::now();
        while started.elapsed() < HEALTH_TIMEOUT {
            if !local_instance_is_active(&health_app, &instance_token) {
                return;
            }
            if let Some(workspace) = verified_workspace(
                &health_host,
                port,
                &instance_token,
                &verification_token,
                &expected_id,
            ) {
                set_status(
                    &health_app,
                    DesktopBootstrapStatus::progress(
                        "verifyingConnection",
                        if prepared.created {
                            "Preparing your Welcome space…"
                        } else {
                            "Verifying workspace identity…"
                        },
                        summary.path.as_deref().unwrap_or(&prepared.path),
                    ),
                );
                let mut first_run_target = None;
                if prepared.created {
                    let seed_started = Instant::now();
                    first_run_target = loop {
                        if !local_instance_is_active(&health_app, &instance_token) {
                            return;
                        }
                        let remaining = SEED_TIMEOUT.saturating_sub(seed_started.elapsed());
                        if remaining.is_zero() {
                            break None;
                        }
                        if let Some(destination) = first_run_destination(
                            &health_host,
                            port,
                            &verification_token,
                            remaining.min(SEED_HTTP_READ_TIMEOUT),
                        ) {
                            break Some(destination);
                        }
                        thread::sleep(Duration::from_millis(100));
                    };
                    if first_run_target.is_none() {
                        set_connection_error(
                            &health_app,
                            "The workspace was created, but Welcome took longer than expected to finish.",
                            Some(origin.clone()),
                            Some(summary.clone()),
                        );
                        return;
                    }
                }
                let workspace_app = health_app.clone();
                let workspace_origin = origin.clone();
                let profile_prepared = prepared.clone();
                let initial_path = match first_run_target {
                    Some(FirstRunDestination::Root) => "/",
                    _ => initial_workspace_path(prepared.created),
                };
                let verified_summary = DesktopWorkspaceSummary {
                    id: workspace.id,
                    name: workspace.name,
                    path: summary.path.clone(),
                };
                if !local_instance_is_active(&health_app, &instance_token) {
                    return;
                }
                let ready_token = instance_token.clone();
                let _ = health_app.run_on_main_thread(move || {
                    if !local_instance_is_active(&workspace_app, &ready_token) {
                        return;
                    }
                    match create_workspace_webview(
                        &workspace_app,
                        workspace_origin.clone(),
                        initial_path,
                        None,
                    ) {
                        Ok(()) => {
                            if persist_on_ready {
                                if let Err(error) = persist_local_profile(
                                    &workspace_app,
                                    &profile_prepared,
                                    port,
                                ) {
                                    close_workspace_webview(&workspace_app);
                                    set_connection_error(
                                        &workspace_app,
                                        format!(
                                            "The workspace is ready, but Desktop could not remember it: {error}"
                                        ),
                                        Some(workspace_origin),
                                        Some(verified_summary),
                                    );
                                    size_current_window(&workspace_app);
                                    return;
                                }
                            }
                            clear_pending_workspace(&workspace_app);
                            set_status(
                                &workspace_app,
                                DesktopBootstrapStatus::ready(workspace_origin, verified_summary),
                            );
                        }
                        Err(error) => {
                            close_workspace_webview(&workspace_app);
                            set_connection_error(
                                &workspace_app,
                                error,
                                Some(workspace_origin),
                                Some(verified_summary),
                            );
                            size_current_window(&workspace_app);
                        }
                    }
                });
                return;
            }
            thread::sleep(Duration::from_millis(150));
        }
        if !local_instance_is_active(&health_app, &instance_token) {
            return;
        }
        set_connection_error(
            &health_app,
            "Local host did not verify its process and workspace identity within 25 seconds",
            Some(origin),
            Some(summary),
        );
    });
    Ok(())
}

fn local_instance_is_active<R: Runtime>(app: &AppHandle<R>, token: &str) -> bool {
    app.state::<DesktopHostState>()
        .active_instance_token
        .lock()
        .map(|active| active.as_deref() == Some(token))
        .unwrap_or(false)
}

fn clear_local_instance_if_active<R: Runtime>(app: &AppHandle<R>, token: &str) -> bool {
    app.state::<DesktopHostState>()
        .active_instance_token
        .lock()
        .map(|mut active| {
            if active.as_deref() != Some(token) {
                return false;
            }
            *active = None;
            true
        })
        .unwrap_or(false)
}

fn set_status<R: Runtime>(app: &AppHandle<R>, mut status: DesktopBootstrapStatus) {
    status.saved_connections = saved_connection_summaries(app);
    let change_available = status.provider.is_some()
        && (status.state != "needsSelection" || status.connection_profile_id.is_some());
    let reveal_available = status.state == "ready"
        && status.provider == Some("local")
        && status
            .workspace
            .as_ref()
            .and_then(|workspace| workspace.path.as_ref())
            .is_some();
    let cloud_actions_available = status.state == "ready" && status.provider == Some("cloud");
    if let Ok(mut current) = app.state::<DesktopHostState>().status.lock() {
        *current = status;
    }
    sync_workspace_menu(
        app,
        change_available,
        reveal_available,
        cloud_actions_available,
    );
    if let Err(error) = complete_healthy_desktop_boot(app) {
        eprintln!("[Worktable Desktop] failed to finish the healthy boot transition: {error}");
    }
}

fn updater_surface_active<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.state::<DesktopUpdaterState>()
        .snapshot()
        .map(|status| status.surface_visible)
        .unwrap_or(false)
}

fn cloud_status_is_ready(status: &DesktopBootstrapStatus) -> bool {
    status.provider == Some("cloud") && status.state == "ready"
}

fn cloud_shell_is_ready<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.state::<DesktopHostState>()
        .status
        .lock()
        .map(|status| cloud_status_is_ready(&status))
        .unwrap_or(false)
}

fn workspace_surface_restore_allowed(status: &DesktopBootstrapStatus) -> bool {
    status.state == "ready"
}

fn workspace_surface_should_fill_window(status: &DesktopBootstrapStatus) -> bool {
    status.provider != Some("cloud") || cloud_status_is_ready(status)
}

fn reveal_cloud_workspace_if_ready<R: Runtime>(app: &AppHandle<R>) {
    if !cloud_shell_is_ready(app) || updater_surface_active(app) {
        return;
    }
    let _ = show_workspace_surface(app);
}

fn show_updater_surface<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if let Some(shell) = app.get_webview(TRUSTED_WEBVIEW_LABEL) {
        shell
            .show()
            .map_err(|error| format!("failed to show Desktop update surface: {error}"))?;
        let _ = shell.set_focus();
    }
    hide_workspace_for_update(app)?;
    show_main_window(app)
}

fn hide_workspace_for_update<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let updater_state = app.state::<DesktopUpdaterState>();
    let _transition = updater_state.lock_workspace_visibility_transition()?;
    if !updater_state.snapshot()?.surface_visible {
        return Ok(());
    }
    if app.get_webview(WORKSPACE_WEBVIEW_LABEL).is_none() {
        return Ok(());
    }
    show_trusted_shell_surface(app)
        .map_err(|error| format!("failed to show Desktop update surface: {error}"))?;
    updater_state.mark_workspace_hidden_by_update();
    Ok(())
}

fn restore_workspace_surface<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let updater_state = app.state::<DesktopUpdaterState>();
    let _transition = updater_state.lock_workspace_visibility_transition()?;
    if updater_state.snapshot()?.surface_visible {
        return Ok(());
    }
    if !updater_state.take_workspace_hidden_by_update() {
        return Ok(());
    }
    let restoration_allowed = app
        .state::<DesktopHostState>()
        .status
        .lock()
        .map(|status| workspace_surface_restore_allowed(&status))
        .unwrap_or(false);
    if !restoration_allowed {
        return Ok(());
    }
    if let Err(error) = show_workspace_surface(app) {
        updater_state.mark_workspace_hidden_by_update();
        return Err(format!("failed to restore workspace after update: {error}"));
    }
    if let Some(workspace) = app.get_webview(WORKSPACE_WEBVIEW_LABEL) {
        let _ = workspace.set_focus();
    }
    Ok(())
}

fn show_updater_surface_for_check<R: Runtime>(
    app: &AppHandle<R>,
    updater_state: &DesktopUpdaterState,
    checked_at: u64,
) -> Result<(), String> {
    if let Err(error) = show_updater_surface(app) {
        updater_state.record_check_surface_failure(checked_at, error.clone())?;
        return Err(error);
    }
    Ok(())
}

async fn run_updater_check(app: AppHandle, manual: bool) -> Result<(), String> {
    let updater_state = app.state::<DesktopUpdaterState>();
    // Resolve the only fallible bookkeeping input before entering the
    // operation state. Every later early return records a terminal status.
    let checked_at = now_epoch_seconds()?;
    let Some(_operation) = updater_state.begin_check_operation(manual)? else {
        show_updater_surface_for_check(&app, &updater_state, checked_at)?;
        return Ok(());
    };
    if manual {
        show_updater_surface_for_check(&app, &updater_state, checked_at)?;
    }

    #[cfg(any(not(target_os = "macos"), feature = "staging"))]
    {
        let message = if cfg!(feature = "staging") {
            "Updates are available in the production Worktable app.".to_string()
        } else {
            "Updates are available in the macOS app.".to_string()
        };
        updater_state.apply_check_result_if_current(|| {
            updater_state.record_check_failure(manual, checked_at, message)
        })?;
        Ok(())
    }

    #[cfg(all(target_os = "macos", not(feature = "staging")))]
    {
        let result = async {
            let updater = app
                .updater()
                .map_err(|error| format!("Desktop updater is unavailable: {error}"))?;
            updater
                .check()
                .await
                .map_err(|error| format!("Could not check for a signed Worktable update: {error}"))
        }
        .await;
        let visible = updater_state.apply_check_result_if_current(|| match result {
            Ok(Some(update)) => updater_state.record_available(
                update.version,
                update.body,
                update.date.map(|date| date.to_string()),
                checked_at,
                manual,
            ),
            Ok(None) => {
                updater_state.record_no_update(manual, checked_at)?;
                Ok(false)
            }
            Err(message) => {
                eprintln!("[Worktable Desktop] update check failed: {message}");
                updater_state.record_check_failure(
                    manual,
                    checked_at,
                    "Could not check for updates. Check your connection and try again.".into(),
                )?;
                Ok(false)
            }
        })?;
        let Some(visible) = visible else {
            return Ok(());
        };
        if visible {
            show_updater_surface_for_check(&app, &updater_state, checked_at)?;
        }
        Ok(())
    }
}

async fn install_available_update(app: AppHandle) -> Result<(), String> {
    let updater_state = app.state::<DesktopUpdaterState>();
    let _operation = updater_state.begin_operation()?;
    #[cfg(any(not(target_os = "macos"), feature = "staging"))]
    {
        let message = if cfg!(feature = "staging") {
            "Updates are available in the production Worktable app."
        } else {
            "Updates are available in the macOS app."
        };
        updater_state.record_install_failure(message.into())?;
        Ok(())
    }

    #[cfg(all(target_os = "macos", not(feature = "staging")))]
    {
        let expected_version = updater_state
            .available_version()?
            .ok_or_else(|| "there is no confirmed Desktop update to install".to_string())?;
        let updater = match app.updater() {
            Ok(updater) => updater,
            Err(error) => {
                eprintln!("[Worktable Desktop] updater unavailable: {error}");
                updater_state
                    .record_install_failure("Could not start the update. Try again.".into())?;
                return Ok(());
            }
        };
        let checked_update = match updater.check().await {
            Ok(update) => update,
            Err(error) => {
                eprintln!("[Worktable Desktop] could not confirm update: {error}");
                updater_state.record_install_failure(
                    "Could not prepare the update. Check your connection and try again.".into(),
                )?;
                return Ok(());
            }
        };
        let Some(update) = checked_update else {
            updater_state.record_install_failure(
                "The confirmed update is no longer available. Check again before retrying.".into(),
            )?;
            return Ok(());
        };
        if update.version != expected_version {
            updater_state.record_available(
                update.version,
                update.body,
                update.date.map(|date| date.to_string()),
                now_epoch_seconds()?,
                true,
            )?;
            return Ok(());
        }

        updater_state.begin_download(&expected_version)?;
        let progress_state = app.clone();
        let bytes = match update
            .download(
                move |chunk, total| {
                    let _ = progress_state
                        .state::<DesktopUpdaterState>()
                        .record_download_progress(chunk, total);
                },
                || {},
            )
            .await
        {
            Ok(bytes) => bytes,
            Err(error) => {
                eprintln!("[Worktable Desktop] update download failed: {error}");
                updater_state.record_install_failure(
                    "Could not download and verify the update. Check your connection and try again."
                        .into(),
                )?;
                return Ok(());
            }
        };

        let attempted_at = match now_rfc3339() {
            Ok(attempted_at) => attempted_at,
            Err(error) => {
                eprintln!("[Worktable Desktop] could not prepare update recovery: {error}");
                updater_state.record_install_failure(
                    "Could not finish preparing the update. Try again.".into(),
                )?;
                return Ok(());
            }
        };
        updater_state.begin_install(&expected_version, attempted_at)?;
        if let Err(error) = update.install(bytes) {
            eprintln!("[Worktable Desktop] update installation failed: {error}");
            updater_state
                .record_install_failure("Could not install the update. Try again.".into())?;
            return Ok(());
        }

        stop_local_host_once(&app);
        app.request_restart();
        Ok(())
    }
}

fn schedule_automatic_update_check(app: AppHandle) {
    #[cfg(all(target_os = "macos", not(feature = "staging")))]
    if !app
        .state::<DesktopUpdaterState>()
        .schedule_automatic_check_once()
    {
        return;
    }

    #[cfg(all(target_os = "macos", not(feature = "staging")))]
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(AUTOMATIC_UPDATE_CHECK_DELAY).await;
        let now = match now_epoch_seconds() {
            Ok(now) => now,
            Err(error) => {
                eprintln!("[Worktable Desktop] automatic update check skipped: {error}");
                return;
            }
        };
        let should_check = app
            .state::<DesktopUpdaterState>()
            .should_automatically_check(now)
            .unwrap_or(false);
        if should_check {
            if let Err(error) = run_updater_check(app, false).await {
                eprintln!("[Worktable Desktop] automatic update check failed: {error}");
            }
        }
    });

    #[cfg(any(not(target_os = "macos"), feature = "staging"))]
    let _ = app;
}

fn saved_connection_summaries<R: Runtime>(
    app: &AppHandle<R>,
) -> Vec<DesktopSavedConnectionSummary> {
    let mut summaries = app
        .state::<DesktopHostState>()
        .connections
        .lock()
        .map(|connections| {
            connections
                .profiles
                .iter()
                .filter_map(|profile| match profile {
                    DesktopConnectionProfile::SelfHosted {
                        id,
                        display_name,
                        origin,
                        workspace_id,
                        allow_insecure_http,
                    } => Some(DesktopSavedConnectionSummary {
                        id: id.clone(),
                        provider: "selfHosted",
                        display_name: display_name.clone(),
                        origin: origin.clone(),
                        verified: workspace_id.is_some()
                            && (!origin.starts_with("http://") || *allow_insecure_http),
                        requires_insecure_http_confirmation: origin.starts_with("http://")
                            && !*allow_insecure_http,
                    }),
                    _ => None,
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    summaries.sort_by(|left, right| {
        left.display_name
            .to_lowercase()
            .cmp(&right.display_name.to_lowercase())
            .then_with(|| left.origin.cmp(&right.origin))
    });
    summaries
}

fn sync_workspace_menu<R: Runtime>(
    app: &AppHandle<R>,
    change_available: bool,
    reveal_available: bool,
    cloud_actions_available: bool,
) {
    let Some(workspace_menu) = app
        .menu()
        .and_then(|menu| menu.get(WORKSPACE_MENU_ID))
        .and_then(|item| item.as_submenu().cloned())
    else {
        return;
    };
    if let Some(item) = workspace_menu
        .get(SWITCH_WORKSPACE_MENU_ID)
        .and_then(|item| item.as_menuitem().cloned())
    {
        let _ = item.set_enabled(change_available);
    }
    if let Some(item) = workspace_menu
        .get(REVEAL_WORKSPACE_MENU_ID)
        .and_then(|item| item.as_menuitem().cloned())
    {
        let _ = item.set_enabled(reveal_available);
    }
    for id in [CLOUD_SIGN_OUT_MENU_ID, CLOUD_END_SESSION_MENU_ID] {
        if let Some(item) = workspace_menu
            .get(id)
            .and_then(|item| item.as_menuitem().cloned())
        {
            let _ = item.set_enabled(cloud_actions_available);
        }
    }
}

fn current_workspace_summary(app: &AppHandle) -> Option<DesktopWorkspaceSummary> {
    app.state::<DesktopHostState>()
        .status
        .lock()
        .ok()?
        .workspace
        .clone()
}

fn retry_workspace_summary<R: Runtime>(app: &AppHandle<R>) -> Option<DesktopWorkspaceSummary> {
    let state = app.state::<DesktopHostState>();
    if let Ok(connections) = state.connections.lock() {
        if let Some(DesktopConnectionProfile::Local {
            workspace_id,
            workspace_path,
            display_name,
            ..
        }) = connections.active()
        {
            return Some(DesktopWorkspaceSummary {
                id: workspace_id.clone(),
                name: display_name.clone(),
                path: Some(workspace_path.clone()),
            });
        }
    }
    let pending =
        state
            .pending_local
            .lock()
            .ok()?
            .as_ref()
            .map(|pending| DesktopWorkspaceSummary {
                id: pending.workspace.id.clone(),
                name: pending.workspace.name.clone(),
                path: Some(pending.path.clone()),
            });
    pending
}

fn set_connection_error<R: Runtime>(
    app: &AppHandle<R>,
    message: impl Into<String>,
    origin: Option<String>,
    workspace: Option<DesktopWorkspaceSummary>,
) {
    let retry_workspace = retry_workspace_summary(app);
    let workspace = workspace.or_else(|| retry_workspace.clone());
    let has_saved_connection = workspace_has_saved_connection(app, workspace.as_ref());
    let mut status =
        DesktopBootstrapStatus::error(message, origin, workspace, retry_workspace.is_some());
    status.can_locate_workspace = has_saved_connection;
    status.can_remove_connection = has_saved_connection;
    set_status(app, status);
}

fn corrupt_local_config_status(
    workspace: Option<DesktopWorkspaceSummary>,
) -> DesktopBootstrapStatus {
    let can_repair = workspace.is_some();
    let message = if can_repair {
        "Worktable's shared local configuration is unreadable. Repair local setup to preserve this workspace and recreate the host configuration."
    } else {
        "Worktable's shared local configuration is unreadable, and Desktop has no saved workspace to restore. Run `worktable setup` to recreate the local setup, then reopen Worktable Desktop."
    };
    let mut status = DesktopBootstrapStatus::recovery(message, "CONFIG_CORRUPT", workspace, false);
    status.can_repair = can_repair;
    status
}

fn stop_local_host<R: Runtime>(app: &AppHandle<R>) {
    if let Ok(mut token) = app.state::<DesktopHostState>().active_instance_token.lock() {
        *token = None;
    }
    let child = app
        .state::<DesktopHostState>()
        .child
        .lock()
        .ok()
        .and_then(|mut child| child.take());
    if let Some(child) = child {
        terminate_local_child(child);
    }
}

#[cfg(unix)]
fn terminate_local_child(child: CommandChild) {
    let pid = child.pid() as i32;
    // The CLI handles SIGTERM by removing only its own nonce-bound runtime
    // lease before exiting. CommandChild::kill is an abrupt fallback and does
    // not give that handler a chance to run.
    if unsafe { libc::kill(pid, libc::SIGTERM) } == 0 {
        for _ in 0..40 {
            if unsafe { libc::kill(pid, 0) } != 0 {
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
    }
    let _ = child.kill();
}

#[cfg(not(unix))]
fn terminate_local_child(child: CommandChild) {
    let _ = child.kill();
}

fn stop_local_host_once<R: Runtime>(app: &AppHandle<R>) {
    app.state::<DesktopHostState>()
        .shutdown_started
        .store(true, Ordering::SeqCst);
    next_connection_generation(app);
    // Keep every exit pass effective. child.take() is idempotent, while an async
    // start may have installed a child after an earlier ExitRequested callback.
    stop_local_host(app);
}

fn same_workspace_origin(url: &tauri::Url, expected_origin: &tauri::Url) -> bool {
    url.scheme() == expected_origin.scheme()
        && url.host_str() == expected_origin.host_str()
        && url.port_or_known_default() == expected_origin.port_or_known_default()
}

fn trusted_workspace_download(url: &tauri::Url, expected_origin: &tauri::Url) -> bool {
    if same_workspace_origin(url, expected_origin) {
        return true;
    }
    url.scheme() == "blob"
        && url
            .as_str()
            .strip_prefix("blob:")
            .and_then(|inner| inner.parse::<tauri::Url>().ok())
            .is_some_and(|inner| same_workspace_origin(&inner, expected_origin))
}

fn can_open_external_url(url: &tauri::Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "mailto" | "tel")
}

fn open_external_url<R: Runtime>(app: &AppHandle<R>, url: &tauri::Url) {
    if can_open_external_url(url) {
        if let Err(error) = app.opener().open_url(url.as_str(), None::<&str>) {
            eprintln!("[Worktable Desktop] failed to open external URL: {error}");
        }
    }
}

fn workspace_boundary_from_title(title: &str) -> Option<&'static str> {
    match title.strip_prefix(WORKSPACE_BOUNDARY_TITLE_PREFIX)? {
        "command-denied" => Some("denied"),
        "bridge-unavailable" => Some("unavailable"),
        "unsafe-command-allowed" => Some("unsafe"),
        _ => None,
    }
}

fn record_workspace_boundary<R: Runtime>(app: &AppHandle<R>, title: &str) {
    let Some(outcome) = workspace_boundary_from_title(title) else {
        return;
    };
    if let Ok(mut current) = app
        .state::<DesktopHostState>()
        .workspace_native_commands
        .lock()
    {
        *current = outcome;
    }
    println!("[Worktable Desktop] workspace native command boundary: {outcome}");
}

fn cleanup_new_workspace_on_error<T>(
    result: Result<T, String>,
    cleanup: impl FnOnce(),
) -> Result<T, String> {
    match result {
        Ok(value) => Ok(value),
        Err(error) => {
            cleanup();
            Err(error)
        }
    }
}

fn create_workspace_webview(
    app: &AppHandle,
    origin: String,
    initial_path: &str,
    session_cookie: Option<(Cookie<'static>, u64)>,
) -> Result<(), String> {
    if app.get_webview(WORKSPACE_WEBVIEW_LABEL).is_some() {
        return Ok(());
    }
    let window = app
        .get_window(WINDOW_LABEL)
        .ok_or_else(|| "desktop window is unavailable".to_string())?;
    let expected_origin = origin
        .parse::<tauri::Url>()
        .map_err(|error| format!("invalid Worktable connection origin: {error}"))?;
    let start_url = expected_origin
        .join(initial_path)
        .map_err(|error| format!("invalid Worktable initial route: {error}"))?;
    let cloud_session = session_cookie.is_some();
    let initial_url = if cloud_session {
        "about:blank"
            .parse::<tauri::Url>()
            .map_err(|error| format!("failed to create the Desktop session surface: {error}"))?
    } else {
        start_url.clone()
    };
    let navigation_origin = expected_origin.clone();
    let download_origin = expected_origin.clone();
    let navigation_app = app.clone();
    let new_window_app = app.clone();
    let page_load_app = app.clone();
    let page_load_origin = expected_origin.clone();
    let expected_origin_literal = serde_json::to_string(&origin)
        .map_err(|error| format!("failed to serialize Worktable origin: {error}"))?;
    let probe_script = r#"
      if (window.location.origin !== __EXPECTED_ORIGIN__) {
        console.warn('[Worktable Desktop] skipped native chrome outside the expected origin');
      } else {
      window.addEventListener('DOMContentLoaded', () => {
        const titlebarHeight = '48px';
        const trafficLightsInset = '80px';
        document.documentElement.dataset.worktableDesktop = '';
        const chromeStyle = document.createElement('style');
        chromeStyle.dataset.worktableDesktopChrome = '';
        chromeStyle.textContent = `
          html[data-worktable-desktop] {
            --worktable-desktop-titlebar-height: ${titlebarHeight};
            --worktable-desktop-traffic-lights-inset: ${trafficLightsInset};
          }
          html[data-worktable-desktop] [data-worktable-sidebar-root],
          html[data-worktable-desktop] .desktop-sidebar-surface > .glass > [style*="safe-area-inset-top"] {
            padding-top: 0 !important;
          }
          html[data-worktable-desktop] [data-worktable-sidebar-header],
          html[data-worktable-desktop] .desktop-sidebar-surface > .glass > [style*="safe-area-inset-top"] > :first-child {
            height: var(--worktable-desktop-titlebar-height) !important;
            justify-content: center !important;
            padding-left: 0 !important;
            padding-right: 0 !important;
          }
          html[data-worktable-desktop] [data-worktable-app-header],
          html[data-worktable-desktop] header[style*="safe-area-inset-top"] {
            padding-top: 0 !important;
            height: var(--worktable-desktop-titlebar-height) !important;
            min-height: var(--worktable-desktop-titlebar-height) !important;
          }
          html[data-worktable-desktop] [data-worktable-app-shell][data-worktable-sidebar-open="false"] [data-worktable-app-header],
          html[data-worktable-desktop] .desktop-sidebar-surface[style*="width: 0px"] ~ div > header[style*="safe-area-inset-top"] {
            padding-left: var(--worktable-desktop-traffic-lights-inset) !important;
          }
          html[data-worktable-desktop] [data-worktable-app-header] nav button,
          html[data-worktable-desktop] header[style*="safe-area-inset-top"] nav button {
            align-items: center !important;
          }
          html[data-worktable-desktop] [data-worktable-sidebar-header] a[href="/"],
          html[data-worktable-desktop] .desktop-sidebar-surface > .glass > [style*="safe-area-inset-top"] > :first-child a[href="/"] {
            display: none;
          }
        `;
        document.head.append(chromeStyle);

        // Current workspace builds expose stable chrome hooks. The fallbacks
        // keep older self-hosted surfaces draggable after their headers move
        // into the native titlebar.
        const markDragRegions = () => {
          const sidebarRoot = document.querySelector(
            '[data-worktable-sidebar-root], .desktop-sidebar-surface > .glass > [style*="safe-area-inset-top"]'
          );
          const sidebarHeader = document.querySelector('[data-worktable-sidebar-header]')
            || sidebarRoot?.firstElementChild;
          const appHeader = document.querySelector(
            '[data-worktable-app-header], header[style*="safe-area-inset-top"]'
          );
          for (const region of [sidebarHeader, appHeader]) {
            region?.setAttribute('data-tauri-drag-region', 'deep');
          }
        };
        markDragRegions();
        window.requestAnimationFrame(markDragRegions);
        window.setTimeout(markDragRegions, 250);
        window.setTimeout(markDragRegions, 1_000);

        window.setTimeout(async () => {
          const previousTitle = document.title;
          let outcome = 'bridge-unavailable';
          const invoke = window.__TAURI__?.core?.invoke;
          if (typeof invoke === 'function') {
            try {
              await invoke('desktop_shell_identity');
              outcome = 'unsafe-command-allowed';
            } catch (_error) {
              outcome = 'command-denied';
            }
          }
          window.__WORKTABLE_DESKTOP_BOUNDARY__ = { nativeCommandOutcome: outcome };
          document.title = `__WORKTABLE_DESKTOP_BOUNDARY__:${outcome}`;
          window.setTimeout(() => {
            if (document.title === `__WORKTABLE_DESKTOP_BOUNDARY__:${outcome}`) {
              document.title = previousTitle;
            }
          }, __BOUNDARY_REPORT_MS__);
          console.info(`[Worktable Desktop] native command boundary: ${outcome}`);
        }, 0);
      });
      }
    "#;
    let probe_script = probe_script
        .replace("__EXPECTED_ORIGIN__", &expected_origin_literal)
        .replace(
            "__BOUNDARY_REPORT_MS__",
            &WORKSPACE_BOUNDARY_REPORT_MS.to_string(),
        );
    let workspace_builder =
        WebviewBuilder::new(WORKSPACE_WEBVIEW_LABEL, WebviewUrl::External(initial_url))
            .initialization_script(&probe_script)
            .devtools(cfg!(debug_assertions))
            .on_navigation(move |url| {
                if url.as_str() == "about:blank" || same_workspace_origin(url, &navigation_origin) {
                    true
                } else {
                    open_external_url(&navigation_app, url);
                    false
                }
            })
            .on_download(move |_webview, event| match event {
                DownloadEvent::Requested { url, .. } => {
                    trusted_workspace_download(&url, &download_origin)
                }
                DownloadEvent::Finished { url, path, success } => {
                    if success {
                        println!(
                            "[Worktable Desktop] trusted download completed from {} to {:?}",
                            url, path
                        );
                    } else {
                        eprintln!("[Worktable Desktop] trusted download failed from {}", url);
                    }
                    true
                }
                _ => true,
            })
            .on_document_title_changed(|webview, title| {
                record_workspace_boundary(webview.app_handle(), &title);
            })
            .on_page_load(move |_webview, payload| {
                if payload.event() != PageLoadEvent::Finished
                    || !same_workspace_origin(payload.url(), &page_load_origin)
                {
                    return;
                }
                let should_probe = page_load_app
                    .state::<DesktopHostState>()
                    .status
                    .lock()
                    .map(|status| status.state == "authenticatingRemote")
                    .unwrap_or(false);
                if !should_probe {
                    return;
                }
                let generation = page_load_app
                    .state::<DesktopHostState>()
                    .connection_generation
                    .load(Ordering::SeqCst);
                let probe_app = page_load_app.clone();
                tauri::async_runtime::spawn(async move {
                    run_remote_probe(probe_app, generation, false).await;
                });
            })
            .on_new_window(move |url, _| {
                open_external_url(&new_window_app, &url);
                NewWindowResponse::Deny
            });

    let size = window
        .inner_size()
        .map_err(|error| format!("failed to read desktop window size: {error}"))?;
    let initial_size = if cloud_session {
        tauri::PhysicalSize::new(0, 0)
    } else {
        tauri::PhysicalSize::new(size.width, size.height)
    };
    window
        .add_child(
            workspace_builder,
            tauri::PhysicalPosition::new(0, 0),
            initial_size,
        )
        .map_err(|error| format!("failed to create unprivileged workspace webview: {error}"))?;
    if cloud_session {
        let _workspace = cleanup_new_workspace_on_error(
            app.get_webview(WORKSPACE_WEBVIEW_LABEL)
                .ok_or_else(|| "Desktop session WebView is unavailable".to_string()),
            || close_workspace_webview(app),
        )?;
        cleanup_new_workspace_on_error(show_trusted_shell_surface(app), || {
            close_workspace_webview(app)
        })?;
    }
    if let Some((cookie, generation)) = session_cookie {
        let state = app.state::<DesktopHostState>();
        let _cookie_operation = cleanup_new_workspace_on_error(
            state
                .cloud_cookie_operation
                .lock()
                .map_err(|_| "Desktop Cloud cookie lock is poisoned".to_string()),
            || close_workspace_webview(app),
        )?;
        if !connection_generation_is_active(app, generation) {
            close_workspace_webview(app);
            return Err("Worktable Cloud connection was cancelled".into());
        }
        let expected_cookie_value = cookie.value().to_string();
        let workspace = cleanup_new_workspace_on_error(
            app.get_webview(WORKSPACE_WEBVIEW_LABEL)
                .ok_or_else(|| "Desktop session WebView is unavailable".to_string()),
            || close_workspace_webview(app),
        )?;
        cleanup_new_workspace_on_error(
            set_host_only_cookie(&workspace, &expected_origin, cookie)
                .map_err(|error| format!("failed to install the Desktop session cookie: {error}")),
            || close_workspace_webview(app),
        )?;
        let installed = cleanup_new_workspace_on_error(
            workspace
                .cookies_for_url(expected_origin)
                .map_err(|error| format!("failed to verify the Desktop session cookie: {error}")),
            || close_workspace_webview(app),
        )?
        .iter()
        .any(|cookie| cookie.name() == "wt_session" && cookie.value() == expected_cookie_value);
        if !installed {
            close_workspace_webview(app);
            return Err("Desktop could not verify the Cloud session cookie".into());
        }
        cleanup_new_workspace_on_error(
            workspace
                .navigate(start_url)
                .map_err(|error| format!("failed to open the Cloud workspace: {error}")),
            || close_workspace_webview(app),
        )?;
    }
    if !cloud_session {
        cleanup_new_workspace_on_error(show_workspace_surface(app), || {
            close_workspace_webview(app)
        })?;
    }
    if let Err(error) = hide_workspace_for_update(app) {
        eprintln!("[Worktable Desktop] {error}");
    }
    size_webviews(app, size.width, size.height);
    Ok(())
}

fn reset_workspace_boundary<R: Runtime>(app: &AppHandle<R>) {
    if let Ok(mut boundary) = app
        .state::<DesktopHostState>()
        .workspace_native_commands
        .lock()
    {
        *boundary = "pending";
    }
}

fn close_workspace_webview<R: Runtime>(app: &AppHandle<R>) {
    reset_workspace_boundary(app);
    let _ = show_trusted_shell_surface(app);
    if let Some(workspace) = app.get_webview(WORKSPACE_WEBVIEW_LABEL) {
        let _ = workspace.close();
    }
}

fn show_trusted_shell_surface<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if let Some(shell) = app.get_webview(TRUSTED_WEBVIEW_LABEL) {
        shell
            .show()
            .map_err(|error| format!("failed to show the trusted Desktop surface: {error}"))?;
    }
    if let Some(workspace) = app.get_webview(WORKSPACE_WEBVIEW_LABEL) {
        workspace
            .hide()
            .map_err(|error| format!("failed to hide the workspace surface: {error}"))?;
    }
    Ok(())
}

fn show_workspace_surface<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let Some(workspace) = app.get_webview(WORKSPACE_WEBVIEW_LABEL) else {
        return Ok(());
    };
    workspace
        .show()
        .map_err(|error| format!("failed to show the workspace surface: {error}"))?;
    if let Some(shell) = app.get_webview(TRUSTED_WEBVIEW_LABEL) {
        if let Err(error) = shell.hide() {
            let _ = workspace.hide();
            return Err(format!(
                "failed to hide the trusted Desktop surface: {error}"
            ));
        }
    }
    Ok(())
}

fn size_webviews<R: Runtime>(app: &AppHandle<R>, width: u32, height: u32) {
    if let Some(shell) = app.get_webview(TRUSTED_WEBVIEW_LABEL) {
        let _ = shell.set_bounds(tauri::Rect {
            position: tauri::PhysicalPosition::new(0, 0).into(),
            size: tauri::PhysicalSize::new(width, height).into(),
        });
    }
    if let Some(workspace) = app.get_webview(WORKSPACE_WEBVIEW_LABEL) {
        let workspace_size = app
            .state::<DesktopHostState>()
            .status
            .lock()
            .map(|status| {
                if workspace_surface_should_fill_window(&status) {
                    tauri::PhysicalSize::new(width, height)
                } else {
                    tauri::PhysicalSize::new(0, 0)
                }
            })
            .unwrap_or_else(|_| tauri::PhysicalSize::new(0, 0));
        let _ = workspace.set_bounds(tauri::Rect {
            position: tauri::PhysicalPosition::new(0, 0).into(),
            size: workspace_size.into(),
        });
    }
}

fn size_current_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_window(WINDOW_LABEL) else {
        return;
    };
    if let Ok(size) = window.inner_size() {
        size_webviews(app, size.width, size.height);
    }
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    app.show()
        .map_err(|error| format!("failed to show Worktable application: {error}"))?;
    let window = app
        .get_window(WINDOW_LABEL)
        .ok_or_else(|| "desktop window is unavailable".to_string())?;
    window
        .show()
        .map_err(|error| format!("failed to show Worktable: {error}"))?;
    window
        .unminimize()
        .map_err(|error| format!("failed to restore Worktable: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("failed to focus Worktable: {error}"))?;
    size_current_window(app);
    Ok(())
}

#[cfg(target_os = "macos")]
fn align_macos_traffic_lights(window: &tauri::Window) -> Result<(), String> {
    use objc2_app_kit::{NSWindow, NSWindowButton};

    let ns_window = window
        .ns_window()
        .map_err(|error| format!("failed to resolve the native Desktop window: {error}"))?;
    // SAFETY: Tauri returns the retained NSWindow backing this live window,
    // and setup executes on the main thread.
    let ns_window: &NSWindow = unsafe { &*ns_window.cast() };
    for (index, kind) in [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ]
    .into_iter()
    .enumerate()
    {
        if let Some(button) = ns_window.standardWindowButton(kind) {
            let mut frame = button.frame();
            frame.origin.x = 12.0 + (index as f64 * 20.0);
            frame.origin.y -= 10.0;
            button.setFrameOrigin(frame.origin);
        }
    }
    Ok(())
}

fn build_window(app: &mut tauri::App) -> Result<(), String> {
    let window_builder = WebviewWindowBuilder::new(
        app,
        TRUSTED_WEBVIEW_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .devtools(cfg!(debug_assertions))
    .title("Worktable")
    .inner_size(1280.0, 820.0)
    .min_inner_size(820.0, 600.0);
    #[cfg(target_os = "macos")]
    let window_builder = window_builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    window_builder
        .build()
        .map_err(|error| format!("failed to build desktop window: {error}"))?;
    let window = app
        .get_window(WINDOW_LABEL)
        .ok_or_else(|| "failed to resolve the desktop window".to_string())?;
    #[cfg(target_os = "macos")]
    align_macos_traffic_lights(&window)?;

    let resize_app = app.handle().clone();
    window.on_window_event(move |event| match event {
        #[cfg(target_os = "macos")]
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            if let Some(window) = resize_app.get_window(WINDOW_LABEL) {
                let _ = window.hide();
            }
        }
        WindowEvent::Resized(size) => {
            size_webviews(&resize_app, size.width, size.height);
        }
        WindowEvent::ScaleFactorChanged { new_inner_size, .. } => {
            size_webviews(&resize_app, new_inner_size.width, new_inner_size.height)
        }
        WindowEvent::Focused(true) => {
            if !cloud_shell_is_ready(&resize_app) {
                return;
            }
            let active_cloud = resize_app
                .state::<DesktopHostState>()
                .connections
                .lock()
                .ok()
                .and_then(|connections| match connections.active() {
                    Some(DesktopConnectionProfile::Cloud { workos_user_id, .. }) => {
                        Some(workos_user_id.clone())
                    }
                    _ => None,
                });
            let Some(workos_user_id) = active_cloud else {
                return;
            };
            let generation = resize_app
                .state::<DesktopHostState>()
                .connection_generation
                .load(Ordering::SeqCst);
            hide_cloud_workspace_before_refresh_if_needed(&resize_app, &workos_user_id);
            let focus_app = resize_app.clone();
            tauri::async_runtime::spawn(async move {
                let refreshed =
                    refresh_cloud_session(&focus_app, generation, &workos_user_id).await;
                let cookie_refresh_pending = focus_app
                    .state::<DesktopHostState>()
                    .cloud_cookie_refresh_pending
                    .load(Ordering::SeqCst)
                    == generation;
                let session_usable = cloud_workspace_session_is_usable(
                    refreshed.is_ok(),
                    focus_app
                        .state::<CloudAuthController>()
                        .access_is_valid(&workos_user_id),
                    cookie_refresh_pending,
                    cloud_shell_is_ready(&focus_app),
                );
                if session_usable {
                    reveal_cloud_workspace_if_ready(&focus_app);
                }
            });
        }
        _ => {}
    });
    Ok(())
}

async fn initialize_desktop(app: AppHandle) {
    if let Err(error) = initialize_desktop_inner(&app).await {
        let workspace = retry_workspace_summary(&app);
        let has_saved_connection = workspace_has_saved_connection(&app, workspace.as_ref());
        let mut status = DesktopBootstrapStatus::recovery(
            error,
            "INITIALIZATION_FAILED",
            workspace.clone(),
            workspace.is_some(),
        );
        status.can_locate_workspace = has_saved_connection;
        status.can_remove_connection = has_saved_connection;
        set_status(&app, status);
    }
}

async fn initialize_desktop_inner(app: &AppHandle) -> Result<(), String> {
    let development_workspace_override = env::var_os("WORKTABLE_DESKTOP_WORKSPACE");
    let runtime = runtime_for(app)?;
    // Older Desktop builds injected the short-lived Cloud session as a
    // persistent WebKit cookie. Remove any legacy copy before considering a
    // saved profile or Keychain credential; a fresh process-local session is
    // issued only after the trusted host has renewed authentication.
    clear_cloud_webview_cookie(app)?;
    // Load Desktop's own connection profile before inspecting the shared local
    // authority. If config.json is corrupt, that profile is the only trusted
    // source from which Desktop can offer a terminal-free recreation path.
    let file = connections_path(&runtime.shell_data_root);
    let (connections, migration_pending) = match read_connections_for_boot(&file) {
        Ok(loaded) => loaded,
        Err(error) => {
            set_status(
                app,
                DesktopBootstrapStatus::recovery(
                    format!("{error}. Reset Desktop setup to preserve the unreadable file and start again."),
                    "CORRUPT_CONNECTIONS",
                    None,
                    false,
                )
                .with_remove_connection(),
            );
            return Ok(());
        }
    };
    {
        let state = app.state::<DesktopHostState>();
        *state
            .connections
            .lock()
            .map_err(|_| "desktop connections lock is poisoned".to_string())? = connections.clone();
        state
            .connections_migration_pending
            .store(migration_pending, Ordering::SeqCst);
        state.connections_loaded.store(true, Ordering::SeqCst);
    }
    if let Err(error) = complete_healthy_desktop_boot(app) {
        eprintln!("[Worktable Desktop] failed to finish the healthy boot transition: {error}");
    }

    match connections.active().cloned() {
        Some(DesktopConnectionProfile::SelfHosted {
            id,
            origin,
            workspace_id,
            allow_insecure_http,
            ..
        }) => {
            if workspace_id.is_none() || (origin.starts_with("http://") && !allow_insecure_http) {
                let mut status = DesktopBootstrapStatus::self_hosted_selection();
                status.message = "Finish setup to verify this server and workspace.".into();
                status.connection_profile_id = Some(id);
                set_status(app, status);
                return Ok(());
            }
            return begin_remote_connection(
                app,
                PendingRemoteConnection {
                    origin,
                    profile_id: Some(id),
                    expected_workspace_id: workspace_id,
                    allow_insecure_http,
                },
            );
        }
        Some(DesktopConnectionProfile::Cloud {
            id,
            display_name,
            workos_user_id,
            hosted_workspace_id,
            ..
        }) => {
            match app
                .state::<CloudAuthController>()
                .has_stored_credential(&workos_user_id)
            {
                Ok(true) => return run_cloud_connection_operation(app, false).await,
                Ok(false) => {
                    set_status(
                        app,
                        DesktopBootstrapStatus::cloud_selection(
                            "Sign in again to reopen this workspace.",
                            Some(id),
                        ),
                    );
                    return Ok(());
                }
                Err(error) => {
                    set_status(
                        app,
                        DesktopBootstrapStatus::cloud_recovery(
                            &error,
                            Some(id),
                            Some(DesktopWorkspaceSummary {
                                id: hosted_workspace_id,
                                name: display_name,
                                path: None,
                            }),
                        ),
                    );
                    return Ok(());
                }
            }
        }
        Some(DesktopConnectionProfile::Local { .. }) => {}
        None if development_workspace_override.is_none() => {
            if has_saved_cloud_profile(&connections) {
                set_status(app, DesktopBootstrapStatus::provider_selection());
                return Ok(());
            }
            match app
                .state::<CloudAuthController>()
                .stored_profileless_user_id()
            {
                Ok(Some(_)) => return run_cloud_connection_operation(app, false).await,
                Ok(None) => {
                    set_status(app, DesktopBootstrapStatus::provider_selection());
                    return Ok(());
                }
                Err(error) => {
                    set_status(
                        app,
                        DesktopBootstrapStatus::cloud_recovery(&error, None, None),
                    );
                    return Ok(());
                }
            }
        }
        None => {}
    }

    if let Some(override_path) = development_workspace_override {
        let path = PathBuf::from(override_path).to_string_lossy().into_owned();
        let prepared = prepare_workspace(app, &path, "create-or-open").await?;
        return start_prepared_local(app, prepared, false).await;
    }

    let authority = match inspect_local_authority_detailed(app).await {
        Ok(authority) => authority,
        Err(error) if error.code.as_deref() == Some("CONFIG_CORRUPT") => {
            set_status(
                app,
                corrupt_local_config_status(retry_workspace_summary(app)),
            );
            return Ok(());
        }
        Err(error) => return Err(error.message),
    };
    if authority
        .activation
        .as_ref()
        .is_some_and(|activation| activation.pending)
    {
        if let Some(logs_path) = authority.logs.as_ref().map(|logs| logs.desktop.as_str()) {
            append_desktop_host_log(
                logs_path,
                "A previous local workspace activation did not finish.",
            );
        }
        let mut status = DesktopBootstrapStatus::recovery(
            "A previous workspace switch did not finish. Repair the local setup to restore the last working workspace and service state.",
            "LOCAL_ACTIVATION_INTERRUPTED",
            retry_workspace_summary(app),
            false,
        );
        status.can_repair = true;
        status.can_open_logs = true;
        set_status(app, status);
        return Ok(());
    }
    if authority.runtime_error_code.as_deref() == Some("LOCAL_RUNTIME_SCHEMA_UNSUPPORTED") {
        if let Some(logs_path) = authority.logs.as_ref().map(|logs| logs.desktop.as_str()) {
            append_desktop_host_log(
                logs_path,
                &format!(
                    "Unsupported local runtime record: {}",
                    authority.runtime_error.as_deref().unwrap_or("newer schema")
                ),
            );
        }
        let mut status = DesktopBootstrapStatus::recovery(
            "This Worktable Desktop version is older than the local Worktable runtime data. Update Worktable Desktop to continue.",
            "LOCAL_RUNTIME_SCHEMA_UNSUPPORTED",
            retry_workspace_summary(app),
            false,
        );
        status.can_open_logs = true;
        set_status(app, status);
        return Ok(());
    }
    if authority.registry_error_code.as_deref() == Some("LOCAL_REGISTRY_SCHEMA_UNSUPPORTED") {
        if let Some(logs_path) = authority.logs.as_ref().map(|logs| logs.desktop.as_str()) {
            append_desktop_host_log(
                logs_path,
                &format!(
                    "Unsupported local workspace registry: {}",
                    authority
                        .registry_error
                        .as_deref()
                        .unwrap_or("newer schema")
                ),
            );
        }
        let mut status = DesktopBootstrapStatus::recovery(
            "This Worktable Desktop version is older than the local workspace data. Update Worktable Desktop to continue.",
            "LOCAL_REGISTRY_SCHEMA_UNSUPPORTED",
            retry_workspace_summary(app),
            false,
        );
        status.can_open_logs = true;
        set_status(app, status);
        return Ok(());
    }
    if let Some(error) = authority.runtime_error.as_deref() {
        if let Some(logs_path) = authority.logs.as_ref().map(|logs| logs.desktop.as_str()) {
            append_desktop_host_log(logs_path, &format!("Invalid local runtime record: {error}"));
        }
        let mut status = DesktopBootstrapStatus::recovery(
            "Worktable could not read its local runtime record. Repairing the local setup will preserve it for inspection and restore startup.",
            "LOCAL_RUNTIME_INVALID",
            retry_workspace_summary(app),
            false,
        );
        status.can_repair = true;
        status.can_open_logs = true;
        set_status(app, status);
        return Ok(());
    }
    if let Some(error) = authority.registry_error.as_deref() {
        if let Some(logs_path) = authority.logs.as_ref().map(|logs| logs.desktop.as_str()) {
            append_desktop_host_log(
                logs_path,
                &format!("Invalid local workspace registry: {error}"),
            );
        }
        let mut status = DesktopBootstrapStatus::recovery(
            "Worktable could not read its local workspace registry. Repairing the local setup will preserve it and rebuild the active workspace registration.",
            "LOCAL_REGISTRY_INVALID",
            retry_workspace_summary(app),
            false,
        );
        status.can_repair = true;
        status.can_open_logs = true;
        set_status(app, status);
        return Ok(());
    }
    if let Some(profile) = connections.active().cloned() {
        return match profile {
            DesktopConnectionProfile::Local {
                workspace_id,
                workspace_path,
                display_name,
                ..
            } => {
                let inspection = inspect_workspace(app, Some(workspace_path.clone())).await?;
                match resolve_saved_workspace(inspection, &workspace_id) {
                    SavedWorkspaceResolution::Ready(prepared) => {
                        start_prepared_local(app, prepared, true).await
                    }
                    SavedWorkspaceResolution::IdentityMismatch(workspace) => {
                        set_status(
                            app,
                            DesktopBootstrapStatus::recovery(
                                format!(
                                    "The saved folder for {display_name} now contains a different workspace ({}).",
                                    workspace.name
                                ),
                                "WORKSPACE_ID_MISMATCH",
                                Some(DesktopWorkspaceSummary {
                                    id: workspace_id,
                                    name: display_name,
                                    path: Some(workspace_path),
                                }),
                                false,
                            )
                            .with_saved_connection_recovery(),
                        );
                        Ok(())
                    }
                    SavedWorkspaceResolution::Rejected(message) => {
                        set_status(
                            app,
                            DesktopBootstrapStatus::recovery(
                                message,
                                "WORKSPACE_REJECTED",
                                Some(DesktopWorkspaceSummary {
                                    id: workspace_id,
                                    name: display_name,
                                    path: Some(workspace_path),
                                }),
                                false,
                            )
                            .with_saved_connection_recovery(),
                        );
                        Ok(())
                    }
                    SavedWorkspaceResolution::Missing => {
                        set_status(
                            app,
                            DesktopBootstrapStatus::recovery(
                                "The saved workspace folder is missing. Locate it or choose another workspace.",
                                "WORKSPACE_MISSING",
                                Some(DesktopWorkspaceSummary {
                                    id: workspace_id,
                                    name: display_name,
                                    path: Some(workspace_path),
                                }),
                                false,
                            )
                            .with_saved_connection_recovery(),
                        );
                        Ok(())
                    }
                }
            }
            DesktopConnectionProfile::SelfHosted { .. }
            | DesktopConnectionProfile::Cloud { .. } => {
                unreachable!("remote profiles return before local authority inspection")
            }
        };
    }

    let existing = discover_existing_installation(app).await?;
    let inspection = inspect_workspace(app, None).await?;
    let mut status = DesktopBootstrapStatus::selection(inspection);
    status.existing_installation = existing;
    set_status(app, status);
    Ok(())
}

fn build_desktop_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    let show_worktable = MenuItemBuilder::with_id(SHOW_WORKTABLE_MENU_ID, "Worktable")
        .accelerator("CmdOrCtrl+0")
        .build(app)?;
    let window_separator = PredefinedMenuItem::separator(app)?;
    if let Some(window_menu) = menu
        .get(WINDOW_SUBMENU_ID)
        .and_then(|item| item.as_submenu().cloned())
    {
        window_menu.prepend_items(&[&show_worktable, &window_separator])?;
    }
    let switch_workspace = MenuItemBuilder::with_id(SWITCH_WORKSPACE_MENU_ID, "Change Connection…")
        .accelerator("CmdOrCtrl+Shift+O")
        .enabled(false)
        .build(app)?;
    let reveal_workspace =
        MenuItemBuilder::with_id(REVEAL_WORKSPACE_MENU_ID, "Reveal Workspace in Finder")
            .enabled(false)
            .build(app)?;
    let cloud_sign_out =
        MenuItemBuilder::with_id(CLOUD_SIGN_OUT_MENU_ID, "Sign Out of Worktable Cloud")
            .enabled(false)
            .build(app)?;
    let cloud_end_session = MenuItemBuilder::with_id(CLOUD_END_SESSION_MENU_ID, "Sign Out")
        .enabled(false)
        .build(app)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let cloud_separator = PredefinedMenuItem::separator(app)?;
    let workspace = Submenu::with_id_and_items(
        app,
        WORKSPACE_MENU_ID,
        "Workspace",
        true,
        &[
            &switch_workspace,
            &separator,
            &reveal_workspace,
            &cloud_separator,
            &cloud_sign_out,
            &cloud_end_session,
        ],
    )?;
    menu.insert(&workspace, 2)?;
    let check_updates =
        MenuItemBuilder::with_id(CHECK_UPDATES_MENU_ID, "Check for Updates…").build(app)?;
    let update_separator = PredefinedMenuItem::separator(app)?;
    if let Some(help_menu) = menu
        .get(HELP_SUBMENU_ID)
        .and_then(|item| item.as_submenu().cloned())
    {
        help_menu.prepend_items(&[&check_updates, &update_separator])?;
    }
    Ok(menu)
}

fn handle_desktop_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    match event.id().as_ref() {
        SHOW_WORKTABLE_MENU_ID => {
            if let Err(error) = show_main_window(app) {
                eprintln!("[Worktable Desktop] failed to show window: {error}");
            }
        }
        SWITCH_WORKSPACE_MENU_ID => {
            if let Err(error) = show_main_window(app) {
                eprintln!("[Worktable Desktop] failed to show workspace picker: {error}");
                return;
            }
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = change_connection(&app).await {
                    eprintln!("[Worktable Desktop] failed to switch workspace: {error}");
                }
            });
        }
        REVEAL_WORKSPACE_MENU_ID => {
            let Some(workspace) = current_workspace_summary(app) else {
                return;
            };
            let Some(path) = workspace.path else {
                return;
            };
            if let Err(error) = app.opener().reveal_item_in_dir(path) {
                eprintln!("[Worktable Desktop] failed to reveal workspace: {error}");
            }
        }
        CLOUD_SIGN_OUT_MENU_ID | CLOUD_END_SESSION_MENU_ID => {
            let end_session = event.id().as_ref() == CLOUD_END_SESSION_MENU_ID;
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = cloud_sign_out(&app, end_session).await {
                    eprintln!("[Worktable Desktop] Cloud sign-out failed: {error}");
                }
            });
        }
        CHECK_UPDATES_MENU_ID => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = run_updater_check(app, true).await {
                    eprintln!("[Worktable Desktop] manual update check failed: {error}");
                }
            });
        }
        _ => {}
    }
}

fn main() {
    let mut builder = tauri::Builder::default();
    if env::var("WORKTABLE_DESKTOP_ALLOW_MULTIPLE_INSTANCES").as_deref() != Ok("1") {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Err(error) = show_main_window(app) {
                eprintln!("[Worktable Desktop] failed to focus existing instance: {error}");
            }
        }));
    }
    #[cfg(all(target_os = "macos", not(feature = "staging")))]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    let app = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(
            CloudAuthController::new(system_credential_store())
                .expect("failed to initialize the Worktable Cloud client"),
        )
        .manage(DesktopHostState::default())
        .manage(DesktopUpdaterState::default())
        .menu(build_desktop_menu)
        .on_menu_event(handle_desktop_menu_event)
        .invoke_handler(tauri::generate_handler![
            desktop_shell_identity,
            desktop_agent_skills_status,
            desktop_agent_skills_preview,
            desktop_agent_skills_apply,
            desktop_bootstrap_state,
            desktop_updater_state,
            desktop_mark_shell_ready,
            desktop_check_for_updates,
            desktop_install_update,
            desktop_dismiss_update,
            desktop_open_update_download,
            desktop_select_connection_provider,
            desktop_start_cloud_connection,
            desktop_cancel_cloud_connection,
            desktop_start_self_hosted_connection,
            desktop_start_saved_connection,
            desktop_choose_workspace_folder,
            desktop_inspect_workspace,
            desktop_start_local_connection,
            desktop_use_existing_installation,
            desktop_retry_connection,
            desktop_restart_local_host,
            desktop_repair_local_authority,
            desktop_open_local_logs,
            desktop_change_connection,
            desktop_cloud_sign_out,
            desktop_cloud_end_session,
            desktop_remove_connection
        ])
        .setup(|app| {
            let runtime = DesktopRuntime::resolve(app)
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            app.state::<DesktopUpdaterState>()
                .initialize(
                    &runtime.shell_data_root,
                    app.package_info().version.to_string().as_str(),
                )
                .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            *app.state::<DesktopHostState>()
                .runtime
                .lock()
                .map_err(|_| "desktop runtime lock is poisoned")? = Some(runtime);
            build_window(app).map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            if updater_surface_active(app.handle()) {
                show_updater_surface(app.handle())
                    .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
            }
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move { initialize_desktop(handle).await });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Worktable Desktop");

    app.run(|app, event| match event {
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            if let Err(error) = show_main_window(app) {
                eprintln!("[Worktable Desktop] failed to reopen window: {error}");
            }
        }
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
            stop_local_host_once(app);
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_agent_skill_commands_are_fixed_and_allowlisted() {
        assert_eq!(
            desktop_agent_skill_args("install", "agents", None).unwrap(),
            vec!["skills", "install", "agents", "--preview", "--json"]
        );
        let plan = "a".repeat(64);
        assert_eq!(
            desktop_agent_skill_args("repair", "claude", Some(&plan)).unwrap(),
            vec![
                "skills",
                "repair",
                "claude",
                "--plan-id",
                plan.as_str(),
                "--yes",
                "--json"
            ]
        );
        assert!(desktop_agent_skill_args("install", "codex", None).is_err());
        assert!(desktop_agent_skill_args("exec", "agents", None).is_err());
        assert!(desktop_agent_skill_args("install", "agents", Some("../plan")).is_err());

        assert_eq!(
            desktop_agent_skill_status_args(),
            vec!["skills", "status", "all", "--json"]
        );
    }

    #[test]
    fn desktop_agent_skill_status_contract_requires_every_allowlisted_target_once() {
        let statuses = DESKTOP_SKILL_TARGET_IDS
            .iter()
            .map(|target_id| serde_json::json!({ "targetId": target_id, "state": "current" }))
            .collect::<Vec<_>>();
        let valid = serde_json::json!({ "schemaVersion": 2, "statuses": statuses });
        assert!(validate_desktop_agent_skill_status_envelope(valid, true, "").is_ok());

        let missing = serde_json::json!({
            "schemaVersion": 2,
            "statuses": [{ "targetId": "agents", "state": "current" }]
        });
        assert!(validate_desktop_agent_skill_status_envelope(missing, true, "").is_err());
    }

    #[test]
    fn desktop_agent_skill_workspace_caller_is_exact_local_ready_and_loopback_only() {
        let expected = "http://127.0.0.1:17480".parse::<tauri::Url>().unwrap();
        let current = "http://127.0.0.1:17480/settings"
            .parse::<tauri::Url>()
            .unwrap();
        assert!(desktop_agent_skill_workspace_allowed(
            WORKSPACE_WEBVIEW_LABEL,
            "ready",
            Some("local"),
            &current,
            &expected
        ));
        for (label, status, provider, url) in [
            (
                TRUSTED_WEBVIEW_LABEL,
                "ready",
                Some("local"),
                current.clone(),
            ),
            (
                WORKSPACE_WEBVIEW_LABEL,
                "recovery",
                Some("local"),
                current.clone(),
            ),
            (
                WORKSPACE_WEBVIEW_LABEL,
                "ready",
                Some("selfHosted"),
                current.clone(),
            ),
            (
                WORKSPACE_WEBVIEW_LABEL,
                "ready",
                Some("local"),
                "http://127.0.0.1:17481/settings".parse().unwrap(),
            ),
        ] {
            assert!(!desktop_agent_skill_workspace_allowed(
                label, status, provider, &url, &expected
            ));
        }
        let remote = "https://worktable.example.test".parse().unwrap();
        assert!(!desktop_agent_skill_workspace_allowed(
            WORKSPACE_WEBVIEW_LABEL,
            "ready",
            Some("local"),
            &remote,
            &remote
        ));
    }

    #[test]
    fn desktop_preserves_actionable_rejected_skill_previews() {
        let envelope = serde_json::json!({
            "schemaVersion": 2,
            "preview": {
                "allowed": false,
                "status": {
                    "state": "conflict",
                    "detail": "Worktable will not overwrite skill folders it does not manage."
                }
            }
        });
        assert_eq!(
            validate_desktop_agent_skill_envelope(envelope.clone(), false, true, "").unwrap(),
            envelope
        );
        assert_eq!(
            validate_desktop_agent_skill_envelope(envelope, false, false, "").unwrap_err(),
            "the packaged skill installer contract failed"
        );
    }

    #[test]
    fn navigation_accepts_only_the_selected_workspace_origin() {
        let expected = "http://127.0.0.1:17480".parse::<tauri::Url>().unwrap();
        assert!(same_workspace_origin(
            &"http://127.0.0.1:17480/spaces/test".parse().unwrap(),
            &expected
        ));
        assert!(!same_workspace_origin(
            &"http://localhost:17480".parse().unwrap(),
            &expected
        ));
        assert!(!same_workspace_origin(
            &"https://app.worktable.cloud".parse().unwrap(),
            &expected
        ));
        assert!(!same_workspace_origin(
            &"http://127.0.0.1:17481".parse().unwrap(),
            &expected
        ));
    }

    #[test]
    fn downloads_accept_same_origin_http_and_blob_urls_only() {
        let expected = "http://127.0.0.1:17480".parse::<tauri::Url>().unwrap();
        assert!(trusted_workspace_download(
            &"http://127.0.0.1:17480/api/attachments/report"
                .parse()
                .unwrap(),
            &expected
        ));
        assert!(trusted_workspace_download(
            &"blob:http://127.0.0.1:17480/1df98fd8-5474-4e42-9524-780a37525ef9"
                .parse()
                .unwrap(),
            &expected
        ));
        assert!(!trusted_workspace_download(
            &"https://attacker.example/download".parse().unwrap(),
            &expected
        ));
        assert!(!trusted_workspace_download(
            &"blob:https://attacker.example/1df98fd8-5474-4e42-9524-780a37525ef9"
                .parse()
                .unwrap(),
            &expected
        ));
        assert!(!trusted_workspace_download(
            &"file:///Users/home/.ssh/config".parse().unwrap(),
            &expected
        ));
    }

    #[test]
    fn external_navigation_allows_only_system_url_schemes() {
        assert!(can_open_external_url(
            &"https://worktable.dev/docs".parse().unwrap()
        ));
        assert!(can_open_external_url(
            &"mailto:hello@worktable.dev".parse().unwrap()
        ));
        assert!(!can_open_external_url(
            &"file:///Users/home/.ssh/config".parse().unwrap()
        ));
        assert!(!can_open_external_url(
            &"javascript:alert(1)".parse().unwrap()
        ));
    }

    #[test]
    fn bootstrap_status_shapes_are_stable_for_the_shell() {
        let ready = DesktopBootstrapStatus::ready(
            "http://127.0.0.1:17480".into(),
            DesktopWorkspaceSummary {
                id: "ws_test".into(),
                name: "Test".into(),
                path: Some("/tmp/Worktable".into()),
            },
        );
        let json = serde_json::to_value(ready).unwrap();
        assert_eq!(json["state"], "ready");
        assert_eq!(json["provider"], "local");
        assert_eq!(json["workspace"]["id"], "ws_test");
        assert_eq!(json["workspaceNativeCommands"], "pending");

        let error = DesktopBootstrapStatus::error("Unavailable", None, None, false);
        assert!(!error.can_retry);
        assert!(!error.can_locate_workspace);
        assert!(!error.can_remove_connection);

        let mut interrupted = DesktopBootstrapStatus::recovery(
            "Interrupted",
            "LOCAL_ACTIVATION_INTERRUPTED",
            None,
            false,
        );
        interrupted.can_repair = true;
        let interrupted_json = serde_json::to_value(interrupted).unwrap();
        assert_eq!(interrupted_json["canRepair"], true);
        assert_eq!(interrupted_json["canRetry"], false);

        let newer_schema = DesktopBootstrapStatus::recovery(
            "Update Worktable Desktop to continue.",
            "LOCAL_RUNTIME_SCHEMA_UNSUPPORTED",
            None,
            false,
        );
        assert!(!newer_schema.can_repair);
        assert!(!newer_schema.can_retry);
        assert_eq!(
            serde_json::to_value(newer_schema).unwrap()["errorCode"],
            "LOCAL_RUNTIME_SCHEMA_UNSUPPORTED"
        );

        let reset = DesktopBootstrapStatus::recovery(
            "Connections are unreadable",
            "CORRUPT_CONNECTIONS",
            None,
            false,
        )
        .with_remove_connection();
        assert!(reset.can_remove_connection);

        let moved = DesktopBootstrapStatus::recovery(
            "The saved workspace folder is missing.",
            "WORKSPACE_MISSING",
            Some(DesktopWorkspaceSummary {
                id: "ws_moved".into(),
                name: "Moved".into(),
                path: Some("/tmp/Moved".into()),
            }),
            false,
        )
        .with_saved_connection_recovery();
        assert!(moved.can_locate_workspace);
        assert!(moved.can_remove_connection);

        let rejected_refresh = DesktopBootstrapStatus::cloud_recovery(
            &CloudAuthError {
                code: "AUTH_REFRESH_FAILED".into(),
                message: "Sign in again.".into(),
                retryable: false,
                clears_credential: true,
                retry_after: None,
            },
            Some("cloud:user_owner".into()),
            None,
        );
        assert!(rejected_refresh.can_retry);
        assert!(rejected_refresh.can_remove_connection);
        assert_eq!(rejected_refresh.provider, Some("cloud"));

        let rejected_session = DesktopBootstrapStatus::cloud_recovery(
            &CloudAuthError {
                code: "UNAUTHORIZED".into(),
                message: "Sign in again.".into(),
                retryable: false,
                clears_credential: true,
                retry_after: None,
            },
            Some("cloud:user_owner".into()),
            None,
        );
        assert!(rejected_session.can_retry);
        assert!(rejected_session.can_remove_connection);
    }

    #[test]
    fn recovery_logs_follow_managed_service_ownership_without_endpoint_proof() {
        let inspection = |installed: bool, owner: Option<&str>| LocalAuthorityInspection {
            schema_version: LOCAL_MACHINE_CONTRACT_SCHEMA_VERSION,
            ok: true,
            configured: Some(true),
            config: None,
            registry_error: None,
            registry_error_code: None,
            runtime: owner.map(|owner| LocalAuthorityRuntime {
                owner: owner.into(),
                workspace_id: "ws_logs".into(),
                workspace_path: "/tmp/Logs".into(),
                host: "127.0.0.1".into(),
                port: 43110,
                endpoint_verified: false,
            }),
            runtime_error: None,
            runtime_error_code: None,
            service: Some(LocalAuthorityService {
                installed,
                state: "stopped".into(),
                logs: LocalAuthorityLogs {
                    stdout: "/tmp/service.log".into(),
                },
            }),
            activation: None,
            logs: Some(LocalAuthorityHostLogs {
                desktop: "/tmp/desktop.log".into(),
            }),
            error: None,
        };

        assert_eq!(
            local_authority_log_path(&inspection(true, None)).as_deref(),
            Some("/tmp/service.log")
        );
        assert_eq!(
            local_authority_log_path(&inspection(false, Some("service"))).as_deref(),
            Some("/tmp/service.log")
        );
        assert_eq!(
            local_authority_log_path(&inspection(false, Some("desktop"))).as_deref(),
            Some("/tmp/desktop.log")
        );
    }

    #[test]
    fn existing_installation_runtime_requires_identity_and_path() {
        let workspace = DesktopWorkspaceSummary {
            id: "ws_original".into(),
            name: "Original".into(),
            path: Some("/tmp/original".into()),
        };
        let mut runtime = LocalAuthorityRuntime {
            owner: "cli".into(),
            workspace_id: "ws_original".into(),
            workspace_path: "/tmp/original".into(),
            host: "127.0.0.1".into(),
            port: 43110,
            endpoint_verified: true,
        };
        assert!(runtime_matches_workspace(&runtime, &workspace));
        runtime.workspace_path = "/tmp/copied-identity".into();
        assert!(!runtime_matches_workspace(&runtime, &workspace));
    }

    #[test]
    fn attached_authority_requires_the_exact_verified_workspace_endpoint() {
        let workspace = DesktopWorkspaceSummary {
            id: "ws_attached".into(),
            name: "Attached".into(),
            path: Some("/tmp/Attached".into()),
        };
        let mut authority = LocalAuthorityInspection {
            schema_version: LOCAL_MACHINE_CONTRACT_SCHEMA_VERSION,
            ok: true,
            configured: Some(true),
            config: Some(LocalAuthorityConfig {
                workspace: workspace.path.clone().unwrap(),
                host: "127.0.0.1".into(),
                port: 43110,
                origin: "http://127.0.0.1:43110".into(),
                requires_owner_login: false,
            }),
            registry_error: None,
            registry_error_code: None,
            runtime: Some(LocalAuthorityRuntime {
                owner: "cli".into(),
                workspace_id: workspace.id.clone(),
                workspace_path: workspace.path.clone().unwrap(),
                host: "127.0.0.1".into(),
                port: 43110,
                endpoint_verified: true,
            }),
            runtime_error: None,
            runtime_error_code: None,
            service: None,
            activation: None,
            logs: None,
            error: None,
        };

        assert!(authority_matches_workspace_endpoint(
            &authority,
            &workspace,
            "127.0.0.1",
            43110
        ));
        authority.runtime.as_mut().unwrap().port = 43111;
        assert!(!authority_matches_workspace_endpoint(
            &authority,
            &workspace,
            "127.0.0.1",
            43110
        ));
        authority.runtime.as_mut().unwrap().port = 43110;
        authority.runtime.as_mut().unwrap().endpoint_verified = false;
        assert!(!authority_matches_workspace_endpoint(
            &authority,
            &workspace,
            "127.0.0.1",
            43110
        ));
    }

    #[test]
    fn corrupt_config_recovery_repairs_only_from_a_saved_workspace() {
        let without_workspace = corrupt_local_config_status(None);
        assert_eq!(
            without_workspace.error_code.as_deref(),
            Some("CONFIG_CORRUPT")
        );
        assert!(!without_workspace.can_repair);
        assert!(without_workspace.message.contains("worktable setup"));

        let with_workspace = corrupt_local_config_status(Some(DesktopWorkspaceSummary {
            id: "ws_saved".into(),
            name: "Saved".into(),
            path: Some("/tmp/Saved".into()),
        }));
        assert!(with_workspace.can_repair);
        assert!(!with_workspace.can_retry);
    }

    #[test]
    fn attached_host_monitor_tolerates_transient_failures_and_resets() {
        let mut failures = 0;
        assert!(!attached_host_requires_recovery(&mut failures, false));
        assert!(!attached_host_requires_recovery(&mut failures, false));
        assert_eq!(failures, 2);

        assert!(!attached_host_requires_recovery(&mut failures, true));
        assert_eq!(failures, 0);

        assert!(!attached_host_requires_recovery(&mut failures, false));
        assert!(!attached_host_requires_recovery(&mut failures, false));
        assert!(attached_host_requires_recovery(&mut failures, false));
    }

    #[test]
    fn remote_monitor_recovers_after_three_transient_failures_and_resets() {
        let mut failures = 0;
        assert!(!remote_monitor_requires_recovery(&mut failures, false));
        assert!(!remote_monitor_requires_recovery(&mut failures, false));
        assert!(remote_monitor_requires_recovery(&mut failures, false));
        assert!(!remote_monitor_requires_recovery(&mut failures, true));
        assert_eq!(failures, 0);
    }

    #[test]
    fn stale_configured_workspace_does_not_block_desktop_selection() {
        let missing = WorkspaceInspection::Missing {
            path: "/tmp/Missing".into(),
        };
        assert!(adoptable_existing_workspace(missing).unwrap().is_none());

        let empty = WorkspaceInspection::Empty {
            path: "/tmp/Empty".into(),
        };
        assert!(adoptable_existing_workspace(empty).unwrap().is_none());

        let valid = WorkspaceInspection::Valid {
            path: "/tmp/Worktable".into(),
            workspace: connections::WorkspaceIdentity {
                id: "ws_existing".into(),
                name: "Existing".into(),
                created_at: "2026-07-18T00:00:00.000Z".into(),
            },
        };
        assert_eq!(
            adoptable_existing_workspace(valid).unwrap().unwrap().id,
            "ws_existing"
        );
    }

    #[test]
    fn workspace_boundary_title_reports_only_known_outcomes() {
        assert_eq!(
            workspace_boundary_from_title("__WORKTABLE_DESKTOP_BOUNDARY__:command-denied"),
            Some("denied")
        );
        assert_eq!(
            workspace_boundary_from_title("__WORKTABLE_DESKTOP_BOUNDARY__:bridge-unavailable"),
            Some("unavailable")
        );
        assert_eq!(
            workspace_boundary_from_title("__WORKTABLE_DESKTOP_BOUNDARY__:unsafe-command-allowed"),
            Some("unsafe")
        );
        assert_eq!(workspace_boundary_from_title("Worktable"), None);
    }

    #[test]
    fn health_requires_the_supervised_instance_token() {
        assert!(worktable_health_matches(
            "HTTP/1.1 200 OK\r\nX-Worktable-Host-Instance: desktop-test-instance",
            r#"{"ok":true,"service":"worktable"}"#,
            "desktop-test-instance"
        ));
        assert!(!worktable_health_matches(
            "HTTP/1.1 200 OK",
            r#"{"ok":true,"service":"worktable"}"#,
            "desktop-test-instance"
        ));
    }

    #[test]
    fn owned_host_verification_uses_the_authority_host() {
        assert_eq!(connectable_host("192.168.1.20"), "192.168.1.20");
        assert_eq!(connectable_host("::1"), "::1");
        assert_eq!(connectable_host("[::1]"), "::1");
        assert_eq!(connectable_host("0.0.0.0"), "127.0.0.1");
        assert_eq!(connectable_host("::"), "127.0.0.1");
    }

    #[test]
    fn owned_host_launch_is_pinned_to_the_activation_result() {
        let runtime = DesktopRuntime {
            shell_data_root: PathBuf::from("/tmp/desktop-shell"),
            local_app_data_root: Some(PathBuf::from("/tmp/local-app")),
            packaged: PackagedRuntimeLayout {
                release_root: PathBuf::from("/tmp/release"),
                static_root: PathBuf::from("/tmp/release/web"),
                version: "test".into(),
            },
        };
        let config = LocalHostConfig {
            instance_token: "instance".into(),
            verification_token: "verification".into(),
            runtime,
        };
        assert_eq!(
            config.sidecar_args("/tmp/Workspace", "::1", 17480),
            vec![
                "launch",
                "--foreground",
                "--no-browser",
                "--workspace",
                "/tmp/Workspace",
                "--host",
                "::1",
                "--port",
                "17480",
            ]
        );
    }

    #[test]
    fn http_get_finishes_at_content_length_without_waiting_for_eof() {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let read = stream.read(&mut request).unwrap();
            assert!(String::from_utf8_lossy(&request[..read]).contains("GET /api/spaces"));
            let body = r#"{"spaces":[{"id":"welcome","settings":{"starterSeedVersion":1,"starterSeedStatus":"complete"},"widgets":[{"id":"welcome"}]}]}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
            stream.flush().unwrap();
            release_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        });

        let response = http_get("127.0.0.1", port, "/api/spaces", None);
        release_tx.send(()).unwrap();
        server.join().unwrap();

        let (_, body) = response.expect("a complete framed response should not require EOF");
        assert!(welcome_seed_response_ready(&body));
    }

    #[test]
    fn welcome_readiness_tolerates_a_slow_cold_start_response() {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let read = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..read]);
            assert!(request.contains("GET /api/spaces"));
            assert!(request.contains("X-Worktable-Host-Verification: seed-proof"));
            thread::sleep(Duration::from_millis(900));
            let body = r#"{"spaces":[{"id":"welcome","settings":{"starterSeedVersion":1,"starterSeedStatus":"complete"},"widgets":[{"id":"welcome"}]}]}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
            stream.flush().unwrap();
        });

        assert!(welcome_seed_ready(
            "127.0.0.1",
            port,
            "seed-proof",
            Duration::from_secs(2)
        ));
        server.join().unwrap();
    }

    #[test]
    fn welcome_readiness_uses_the_spaces_response_contract() {
        let complete_welcome = r#"{"spaces":[{"id":"welcome","settings":{"starterSeedVersion":1,"starterSeedStatus":"complete"},"widgets":[{"id":"welcome"}]}]}"#;
        assert_eq!(
            first_run_destination_from_spaces(complete_welcome),
            Some(FirstRunDestination::Welcome)
        );
        assert!(welcome_seed_response_ready(complete_welcome));
        assert!(!welcome_seed_response_ready(
            r#"{"spaces":[{"id":"welcome","settings":{"starterSeedVersion":1,"starterSeedStatus":"complete"},"widgets":[]}]}"#
        ));
        assert!(welcome_seed_response_ready(
            r#"{"spaces":[{"id":"welcome"}]}"#
        ));
        let synced_space = r#"{"spaces":[{"id":"synced-notes","settings":{},"widgets":[]}]}"#;
        assert_eq!(
            first_run_destination_from_spaces(synced_space),
            Some(FirstRunDestination::Root)
        );
        assert!(welcome_seed_response_ready(synced_space));
        assert!(!welcome_seed_response_ready(
            r#"{"spaces":[{"id":"welcome","settings":{"starterSeedVersion":1,"starterSeedStatus":"provisioning"},"widgets":[{"id":"welcome"}]}]}"#
        ));
        assert!(!welcome_seed_response_ready(r#"[{"id":"welcome"}]"#));
        assert!(!welcome_seed_response_ready(r#"{"spaces":[]}"#));
    }

    #[test]
    fn attached_and_owned_first_runs_open_the_same_welcome_destination() {
        assert_eq!(
            initial_workspace_path(true),
            "/spaces/welcome/widgets/welcome"
        );
        assert_eq!(initial_workspace_path(false), "/");
    }

    #[test]
    fn verification_tokens_are_random_lowercase_hex() {
        let first = desktop_verification_token().unwrap();
        let second = desktop_verification_token().unwrap();
        assert_eq!(first.len(), 64);
        assert!(first
            .chars()
            .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase()));
        assert_ne!(first, second);
    }

    #[test]
    fn remote_profile_ids_are_random_lowercase_hex() {
        let first = desktop_remote_profile_id().unwrap();
        let second = desktop_remote_profile_id().unwrap();
        for id in [&first, &second] {
            let value = id.strip_prefix("self-hosted:").unwrap();
            assert_eq!(value.len(), 32);
            assert!(value
                .chars()
                .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase()));
        }
        assert_ne!(first, second);
    }

    #[test]
    fn connection_generation_rejects_stale_and_shutdown_completions() {
        assert!(captured_generation_is_active(8, 8, false));
        assert!(!captured_generation_is_active(9, 8, false));
        assert!(!captured_generation_is_active(8, 8, true));
    }

    #[test]
    fn cancellation_preserves_only_a_cloud_profile_that_predated_the_operation() {
        let profile = DesktopConnectionProfile::cloud(
            "Owner workspace".into(),
            "user_owner".into(),
            "hosted_owner".into(),
            "portable_owner".into(),
        );
        assert!(cloud_cancellation_profile_identity(Some(&profile), false).is_none());
        assert_eq!(
            cloud_cancellation_profile_identity(Some(&profile), true),
            Some(("cloud:user_owner".into(), "user_owner".into()))
        );
    }

    #[tokio::test]
    async fn connection_change_cancels_an_in_flight_cloud_session_request() {
        let (changed_sender, changed_receiver) = tokio::sync::oneshot::channel::<()>();
        let request = std::future::pending::<Result<CloudWebViewSession, CloudAuthError>>();
        let changed = async move {
            let _ = changed_receiver.await;
        };
        let operation = tokio::spawn(await_connection_operation(request, changed));
        changed_sender.send(()).unwrap();
        let result = tokio::time::timeout(Duration::from_secs(1), operation)
            .await
            .expect("connection cancellation should not wait for the HTTP timeout")
            .expect("connection cancellation task should not panic");
        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("connection cancellation should interrupt the session request"),
        };
        assert_eq!(error.code, "AUTH_CANCELLED");
    }

    #[test]
    fn removing_the_profile_shown_in_recovery_affects_the_current_connection() {
        assert!(connection_removal_affects_current(false, false, true));
        assert!(connection_removal_affects_current(true, false, false));
        assert!(connection_removal_affects_current(false, true, false));
        assert!(!connection_removal_affects_current(false, false, false));
    }

    #[test]
    fn cloud_removal_failures_keep_structured_cloud_recovery_context() {
        let profile = DesktopConnectionProfile::cloud(
            "Owner workspace".into(),
            "user_owner".into(),
            "hosted_owner".into(),
            "portable_owner".into(),
        );
        let failure = Mutex::new(None);
        let message = record_cloud_recovery_failure(
            &failure,
            cloud_local_error("Keychain removal failed".into()),
            cloud_profile_recovery_context(Some(&profile)),
        );
        assert_eq!(message, "Keychain removal failed");
        let (error, profile_id, workspace) = failure.lock().unwrap().take().unwrap();
        assert_eq!(error.code, "CLOUD_DESKTOP_STATE_FAILED");
        assert!(error.retryable);
        assert_eq!(profile_id.as_deref(), Some("cloud:user_owner"));
        assert_eq!(
            workspace.as_ref().map(|workspace| workspace.id.as_str()),
            Some("hosted_owner")
        );

        let profileless_failure = Mutex::new(None);
        record_cloud_recovery_failure(
            &profileless_failure,
            cloud_local_error("Profileless cleanup failed".into()),
            None,
        );
        let (_, profile_id, workspace) = profileless_failure.lock().unwrap().take().unwrap();
        assert!(profile_id.is_none());
        assert!(workspace.is_none());
    }

    #[test]
    fn every_failed_post_creation_workspace_step_runs_cleanup() {
        let cleaned = std::cell::Cell::new(false);
        let error = cleanup_new_workspace_on_error::<()>(Err("cookie setup failed".into()), || {
            cleaned.set(true)
        })
        .unwrap_err();
        assert_eq!(error, "cookie setup failed");
        assert!(cleaned.get());

        cleaned.set(false);
        assert_eq!(
            cleanup_new_workspace_on_error(Ok("ready"), || cleaned.set(true)).unwrap(),
            "ready"
        );
        assert!(!cleaned.get());
    }

    #[test]
    fn provisioning_poll_delay_never_crosses_the_overall_deadline() {
        assert_eq!(
            cloud_session_poll_delay(Some(Duration::from_secs(30)), Duration::from_secs(2)),
            Some(Duration::from_secs(2))
        );
        assert_eq!(
            cloud_session_poll_delay(Some(Duration::from_secs(60)), Duration::from_secs(90)),
            Some(Duration::from_secs(30))
        );
        assert_eq!(
            cloud_session_poll_delay(None, Duration::from_secs(10)),
            Some(Duration::from_secs(5))
        );
        assert_eq!(cloud_session_poll_delay(None, Duration::ZERO), None);
    }

    #[test]
    fn workspace_reveal_requires_the_corresponding_ready_shell_state() {
        let ready = DesktopBootstrapStatus::cloud_ready(
            "cloud:user_owner".into(),
            DesktopWorkspaceSummary {
                id: "hosted_owner".into(),
                name: "Owner workspace".into(),
                path: None,
            },
        );
        assert!(cloud_status_is_ready(&ready));
        assert!(workspace_surface_restore_allowed(&ready));
        assert!(workspace_surface_should_fill_window(&ready));

        let selection = DesktopBootstrapStatus::cloud_selection(
            "Sign in to reopen this workspace.",
            Some("cloud:user_owner".into()),
        );
        assert!(!cloud_status_is_ready(&selection));
        assert!(!workspace_surface_restore_allowed(&selection));
        assert!(!workspace_surface_should_fill_window(&selection));

        let recovery = DesktopBootstrapStatus::cloud_recovery(
            &cloud_local_error("Session renewal failed".into()),
            Some("cloud:user_owner".into()),
            ready.workspace.clone(),
        );
        assert!(!cloud_status_is_ready(&recovery));
        assert!(!workspace_surface_restore_allowed(&recovery));
        assert!(!workspace_surface_should_fill_window(&recovery));

        let provisioning = DesktopBootstrapStatus::cloud_progress(
            "provisioningCloud",
            "Opening your hosted workspace…",
            Some("cloud:user_owner".into()),
        );
        assert!(!workspace_surface_should_fill_window(&provisioning));

        let local = DesktopBootstrapStatus::progress(
            "startingHost",
            "Starting the local host…",
            "/tmp/Worktable",
        );
        assert!(workspace_surface_should_fill_window(&local));
    }

    #[test]
    fn workspace_identity_conflicts_always_clear_the_incompatible_credential() {
        let error = cloud_workspace_identity_conflict(
            "Worktable Cloud returned a different workspace identity.",
        );
        assert_eq!(error.code, "WORKSPACE_IDENTITY_CONFLICT");
        assert!(!error.retryable);
        assert!(error.clears_credential);
    }

    #[test]
    fn rejected_credential_cleanup_failures_preserve_the_remembered_profile_identity() {
        let error = rejected_cloud_credential_error();
        assert_eq!(error.code, "CREDENTIAL_STORE_FAILED");
        assert!(!error.retryable);
        assert!(
            !error.clears_credential,
            "the outer recovery path must not clear a different remembered user"
        );
    }

    #[test]
    fn healthy_boot_requires_trusted_shell_loaded_state_and_connection_health() {
        assert!(!healthy_desktop_boot_ready(false, false, false));
        assert!(!healthy_desktop_boot_ready(true, false, true));
        assert!(!healthy_desktop_boot_ready(false, true, true));
        assert!(!healthy_desktop_boot_ready(true, true, false));
        assert!(healthy_desktop_boot_ready(true, true, true));
    }

    #[test]
    fn healthy_boot_accepts_only_ready_connections_or_stable_provider_selection() {
        let ready = DesktopBootstrapStatus::cloud_ready(
            "cloud:user_owner".into(),
            DesktopWorkspaceSummary {
                id: "hosted_owner".into(),
                name: "Owner workspace".into(),
                path: None,
            },
        );
        assert!(desktop_connection_status_ready_for_healthy_boot(
            &ready, true
        ));

        let selection = DesktopBootstrapStatus::provider_selection();
        assert!(desktop_connection_status_ready_for_healthy_boot(
            &selection, false
        ));
        assert!(!desktop_connection_status_ready_for_healthy_boot(
            &selection, true
        ));

        let profile_selection = DesktopBootstrapStatus::cloud_selection(
            "Sign in to reopen this workspace.",
            Some("cloud:user_owner".into()),
        );
        assert!(!desktop_connection_status_ready_for_healthy_boot(
            &profile_selection,
            true
        ));

        let recovery = DesktopBootstrapStatus::cloud_recovery(
            &cloud_local_error("Session renewal failed".into()),
            Some("cloud:user_owner".into()),
            ready.workspace.clone(),
        );
        assert!(!desktop_connection_status_ready_for_healthy_boot(
            &recovery, true
        ));

        let progress = DesktopBootstrapStatus::cloud_progress(
            "provisioningCloud",
            "Opening your hosted workspace…",
            Some("cloud:user_owner".into()),
        );
        assert!(!desktop_connection_status_ready_for_healthy_boot(
            &progress, true
        ));
    }

    #[test]
    fn workspace_stays_hidden_while_an_expired_cookie_is_being_reissued() {
        assert!(cloud_workspace_session_is_usable(true, true, false, true));
        assert!(cloud_workspace_session_is_usable(false, true, false, true));
        assert!(!cloud_workspace_session_is_usable(false, true, true, true));
        assert!(!cloud_workspace_session_is_usable(
            false, false, false, true
        ));
        assert!(!cloud_workspace_session_is_usable(true, true, false, false));
    }

    #[test]
    fn profileless_cloud_retry_reopens_auth_only_without_a_continuation() {
        assert!(cloud_retry_requires_interactive(
            Some("CLOUD_UNAVAILABLE"),
            "recovery",
            false,
            false
        ));
        assert!(!cloud_retry_requires_interactive(
            Some("CLOUD_UNAVAILABLE"),
            "recovery",
            false,
            true
        ));
        assert!(cloud_retry_requires_interactive(
            Some("AUTHENTICATION_REQUIRED"),
            "recovery",
            true,
            false
        ));
        assert!(!cloud_retry_requires_interactive(
            Some("CLOUD_UNAVAILABLE"),
            "recovery",
            true,
            false
        ));
    }

    #[test]
    fn an_inactive_saved_cloud_profile_blocks_profileless_credential_resume() {
        let mut connections = DesktopConnections::default();
        connections.profiles.push(DesktopConnectionProfile::cloud(
            "Owner workspace".into(),
            "user_owner".into(),
            "hosted_owner".into(),
            "portable_owner".into(),
        ));
        assert!(connections.active_profile_id.is_none());
        assert!(has_saved_cloud_profile(&connections));
    }

    #[test]
    fn cloud_session_polling_covers_every_retryable_provisioning_state() {
        for code in [
            "PROVISIONING",
            "CONFIRMING_PAYMENT",
            "PROVISIONING_UNAVAILABLE",
            "CLOUD_UNAVAILABLE",
            "INSTANCE_MIGRATING",
            "CONTROL_PLANE_DOWN",
            "AUTH_VERIFICATION_UNAVAILABLE",
        ] {
            assert!(cloud_session_polling_retryable(code), "{code}");
        }
        for code in ["PROVISIONING_FAILED", "UNAUTHORIZED", "OPERATOR_ATTENTION"] {
            assert!(!cloud_session_polling_retryable(code), "{code}");
        }

        let retryable_refresh = CloudAuthError {
            code: "AUTH_REFRESH_UNAVAILABLE".into(),
            message: "try later".into(),
            retryable: true,
            clears_credential: false,
            retry_after: Some(Duration::from_secs(30)),
        };
        assert!(cloud_session_operation_retryable(
            &retryable_refresh,
            CloudSessionRetryPhase::Renewal
        ));
        assert!(!cloud_session_operation_retryable(
            &retryable_refresh,
            CloudSessionRetryPhase::Provisioning
        ));
        let terminal_refresh = CloudAuthError {
            retryable: false,
            ..retryable_refresh
        };
        assert!(!cloud_session_operation_retryable(
            &terminal_refresh,
            CloudSessionRetryPhase::Renewal
        ));
        let rejected_refresh = CloudAuthError {
            code: "UNAUTHORIZED".into(),
            message: "sign in again".into(),
            retryable: true,
            clears_credential: true,
            retry_after: None,
        };
        assert!(!cloud_session_operation_retryable(
            &rejected_refresh,
            CloudSessionRetryPhase::Renewal
        ));
        assert!(!cloud_session_operation_retryable(
            &cloud_cancelled_error(),
            CloudSessionRetryPhase::Renewal
        ));
    }

    #[test]
    fn cloud_refresh_operation_requires_the_current_ready_generation() {
        let ready = DesktopBootstrapStatus::cloud_ready(
            "cloud:user_owner".into(),
            DesktopWorkspaceSummary {
                id: "hosted_owner".into(),
                name: "Owner workspace".into(),
                path: None,
            },
        );
        let recovery = DesktopBootstrapStatus::cloud_recovery(
            &cloud_local_error("Session renewal failed".into()),
            Some("cloud:user_owner".into()),
            ready.workspace.clone(),
        );
        assert!(cloud_refresh_operation_is_allowed(Some(&ready), true));
        assert!(!cloud_refresh_operation_is_allowed(Some(&ready), false));
        assert!(!cloud_refresh_operation_is_allowed(Some(&recovery), true));
        assert!(!cloud_refresh_operation_is_allowed(None, true));
    }

    #[test]
    fn cloud_refresh_retries_use_backoff_even_when_the_access_deadline_is_due() {
        let one_second = Duration::from_secs(1);
        assert!(cloud_refresh_should_retry(true, true, true));
        assert!(!cloud_refresh_should_retry(false, true, true));
        assert!(!cloud_refresh_should_retry(true, false, true));
        assert!(!cloud_refresh_should_retry(true, true, false));
        assert_eq!(
            cloud_refresh_scheduler_delay(
                true,
                one_second,
                Some(Duration::ZERO),
                Some(Duration::from_secs(20))
            ),
            Some(one_second)
        );
        assert_eq!(
            cloud_refresh_scheduler_delay(
                false,
                one_second,
                Some(Duration::from_secs(10)),
                Some(Duration::from_secs(5))
            ),
            Some(Duration::from_secs(5))
        );
        assert_eq!(
            next_cloud_refresh_retry_delay(one_second, None),
            Duration::from_secs(2)
        );
        assert_eq!(
            next_cloud_refresh_retry_delay(Duration::from_secs(30), None),
            Duration::from_secs(30)
        );
        assert_eq!(
            next_cloud_refresh_retry_delay(one_second, Some(Duration::from_secs(45))),
            Duration::from_secs(45)
        );
        assert_eq!(
            next_cloud_refresh_retry_delay(Duration::from_secs(10), Some(Duration::from_secs(2))),
            Duration::from_secs(20)
        );
    }

    #[test]
    fn overdue_access_or_cookie_hides_the_cloud_workspace_before_refresh() {
        assert!(!cloud_workspace_should_hide_before_refresh(true, false));
        assert!(cloud_workspace_should_hide_before_refresh(false, false));
        assert!(cloud_workspace_should_hide_before_refresh(true, true));
        assert!(cloud_workspace_should_hide_before_refresh(false, true));
    }

    #[test]
    fn selection_exposes_a_valid_default_workspace_to_the_shell() {
        let status = DesktopBootstrapStatus::selection(WorkspaceInspection::Valid {
            path: "/tmp/Worktable".into(),
            workspace: connections::WorkspaceIdentity {
                id: "ws_default".into(),
                name: "Default workspace".into(),
                created_at: "2026-01-01T00:00:00.000Z".into(),
            },
        });
        assert_eq!(status.state, "needsSelection");
        assert_eq!(status.provider, Some("local"));
        assert_eq!(status.default_path.as_deref(), Some("/tmp/Worktable"));
        assert_eq!(
            status.workspace.as_ref().map(|item| item.id.as_str()),
            Some("ws_default")
        );
        let json = serde_json::to_value(status).unwrap();
        assert!(json.get("previewProviders").is_none());
    }

    #[test]
    fn sidecar_preserves_public_exposure_but_drops_other_worktable_overrides() {
        assert!(!inherited_sidecar_env_allowed(
            "WORKTABLE_WORKSPACE".as_ref()
        ));
        // The public URL is an authentication-posture input, not a path
        // authority. An env-only tunnel may keep forwarding the workspace's
        // stable port when Desktop replaces a foreground CLI host, so dropping
        // this one value could restart that surface without its owner-login gate.
        assert!(inherited_sidecar_env_allowed(
            "WORKTABLE_PUBLIC_URL".as_ref()
        ));
        assert!(!inherited_sidecar_env_allowed(
            "WORKTABLE_OWNER_PASSWORD".as_ref()
        ));
        assert!(!inherited_sidecar_env_allowed(
            "WORKTABLE_HOST_VERIFICATION_TOKEN".as_ref()
        ));
        assert!(!inherited_sidecar_env_allowed("HOST".as_ref()));
        assert!(!inherited_sidecar_env_allowed("PORT".as_ref()));
        assert!(inherited_sidecar_env_allowed("PATH".as_ref()));
        assert!(inherited_sidecar_env_allowed("HOME".as_ref()));
    }

    #[test]
    fn picker_prefers_a_valid_hint_and_rejects_symlinks() {
        let root = env::temp_dir().join(format!(
            "worktable-desktop-picker-{}-{}",
            process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let hint = root.join("fixtures");
        let fallback = root.join("home");
        std::fs::create_dir_all(&hint).unwrap();
        std::fs::create_dir_all(&fallback).unwrap();
        let linked = root.join("linked-fixtures");
        std::os::unix::fs::symlink(&hint, &linked).unwrap();

        assert_eq!(
            picker_start_directory(Some(&hint), Some(&fallback)),
            Some(hint.canonicalize().unwrap())
        );
        assert_eq!(
            picker_start_directory(Some(&linked), Some(&fallback)),
            Some(fallback.canonicalize().unwrap())
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn picker_falls_back_to_the_nearest_existing_parent() {
        let root = env::temp_dir().join(format!(
            "worktable-desktop-picker-parent-{}-{}",
            process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let missing = root.join("future").join("Worktable");
        assert_eq!(
            picker_start_directory(None, Some(&missing)),
            Some(root.canonicalize().unwrap())
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn picker_hint_survives_cancel_and_is_consumed_after_selection() {
        let path = PathBuf::from("/tmp/worktable-picker");
        let mut hint = Some(path.clone());
        update_picker_hint_after_selection(&mut hint, false);
        assert_eq!(hint, Some(path));
        update_picker_hint_after_selection(&mut hint, true);
        assert_eq!(hint, None);
    }
}
