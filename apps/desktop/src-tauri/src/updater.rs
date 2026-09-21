#![cfg_attr(any(not(target_os = "macos"), feature = "staging"), allow(dead_code))]

use semver::Version;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

const UPDATE_STATE_SCHEMA_VERSION: u8 = 1;
const AUTOMATIC_CHECK_INTERVAL_SECS: u64 = 24 * 60 * 60;
const UPDATE_STATE_FILE: &str = "desktop-updater-state.json";
const UPDATE_RECOVERY_FILE: &str = "desktop-update-recovery.json";
const RELEASE_BASE_URL: &str = "https://worktable.dev/releases";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAttempt {
    pub from_version: String,
    pub to_version: String,
    pub previous_dmg_url: String,
    pub attempted_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PersistedUpdaterState {
    schema_version: u8,
    last_checked_at: Option<u64>,
    dismissed_version: Option<String>,
    dismissed_at: Option<u64>,
}

impl Default for PersistedUpdaterState {
    fn default() -> Self {
        Self {
            schema_version: UPDATE_STATE_SCHEMA_VERSION,
            last_checked_at: None,
            dismissed_version: None,
            dismissed_at: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdaterStatus {
    pub state: &'static str,
    pub surface_visible: bool,
    pub current_version: String,
    pub available_version: Option<String>,
    pub notes: Option<String>,
    pub published_at: Option<String>,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub message: String,
    pub manual_download_url: String,
    pub can_check: bool,
    pub can_install: bool,
    pub can_dismiss: bool,
    pub recovery: Option<UpdateAttempt>,
}

impl DesktopUpdaterStatus {
    fn idle(current_version: impl Into<String>) -> Self {
        let current_version = current_version.into();
        Self {
            state: "idle",
            surface_visible: false,
            manual_download_url: versioned_dmg_url(&current_version),
            current_version,
            available_version: None,
            notes: None,
            published_at: None,
            downloaded_bytes: 0,
            total_bytes: None,
            message: String::new(),
            can_check: true,
            can_install: false,
            can_dismiss: false,
            recovery: None,
        }
    }
}

pub struct DesktopUpdaterState {
    status: Mutex<DesktopUpdaterStatus>,
    persisted: Mutex<PersistedUpdaterState>,
    state_path: Mutex<Option<PathBuf>>,
    recovery_path: Mutex<Option<PathBuf>>,
    operation_in_progress: AtomicBool,
    automatic_check_scheduled: AtomicBool,
    workspace_hidden_by_update: AtomicBool,
    workspace_visibility_transition: Mutex<()>,
    check_result_invalidated: AtomicBool,
    check_completion_transition: Mutex<()>,
}

impl Default for DesktopUpdaterState {
    fn default() -> Self {
        Self {
            status: Mutex::new(DesktopUpdaterStatus::idle(env!("CARGO_PKG_VERSION"))),
            persisted: Mutex::new(PersistedUpdaterState::default()),
            state_path: Mutex::new(None),
            recovery_path: Mutex::new(None),
            operation_in_progress: AtomicBool::new(false),
            automatic_check_scheduled: AtomicBool::new(false),
            workspace_hidden_by_update: AtomicBool::new(false),
            workspace_visibility_transition: Mutex::new(()),
            check_result_invalidated: AtomicBool::new(false),
            check_completion_transition: Mutex::new(()),
        }
    }
}

impl DesktopUpdaterState {
    pub fn initialize(&self, app_data_root: &Path, current_version: &str) -> Result<(), String> {
        let path = app_data_root.join(UPDATE_STATE_FILE);
        let recovery_path = app_data_root.join(UPDATE_RECOVERY_FILE);
        let persisted = match read_persisted_state(&path) {
            Ok(persisted) => persisted,
            Err(error) => {
                eprintln!("[Worktable Desktop] {error}");
                quarantine_invalid_state(&path);
                PersistedUpdaterState::default()
            }
        };
        let mut status = DesktopUpdaterStatus::idle(current_version);
        let recovery = match read_update_attempt(&recovery_path) {
            Ok(recovery) => recovery,
            Err(error) => {
                eprintln!("[Worktable Desktop] {error}");
                quarantine_invalid_state(&recovery_path);
                None
            }
        };
        if let Some(attempt) = recovery {
            if version_reaches_or_exceeds(current_version, &attempt.to_version) {
                // Keep the recovery marker until the trusted shell proves that
                // the new version reached a healthy boot. Process creation
                // alone is not enough evidence to retire manual recovery.
            } else {
                status.manual_download_url = attempt.previous_dmg_url.clone();
                status.state = "recovery";
                status.surface_visible = true;
                status.message = format!(
                    "Could not finish updating from {} to {}.",
                    attempt.from_version, attempt.to_version
                );
                status.can_dismiss = true;
                status.recovery = Some(attempt);
            }
        }
        *self
            .status
            .lock()
            .map_err(|_| "desktop updater status lock is poisoned".to_string())? = status;
        *self
            .persisted
            .lock()
            .map_err(|_| "desktop updater persistence lock is poisoned".to_string())? = persisted;
        *self
            .state_path
            .lock()
            .map_err(|_| "desktop updater path lock is poisoned".to_string())? = Some(path);
        *self
            .recovery_path
            .lock()
            .map_err(|_| "desktop updater recovery path lock is poisoned".to_string())? =
            Some(recovery_path);
        Ok(())
    }

    pub fn mark_healthy_boot(&self) -> Result<(), String> {
        let recovery_path = self.recovery_path()?;
        let Some(attempt) = read_update_attempt(&recovery_path)? else {
            return Ok(());
        };
        let current_version = self.snapshot()?.current_version;
        if version_reaches_or_exceeds(&current_version, &attempt.to_version) {
            remove_update_attempt(&recovery_path)?;
        }
        Ok(())
    }

    pub fn snapshot(&self) -> Result<DesktopUpdaterStatus, String> {
        self.status
            .lock()
            .map(|status| status.clone())
            .map_err(|_| "desktop updater status lock is poisoned".to_string())
    }

    pub fn begin_operation(&self) -> Result<UpdaterOperationGuard<'_>, String> {
        self.operation_in_progress
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| "another Desktop update operation is already running".to_string())?;
        Ok(UpdaterOperationGuard { state: self })
    }

    pub fn begin_check_operation(
        &self,
        manual: bool,
    ) -> Result<Option<UpdaterOperationGuard<'_>>, String> {
        let mut status = self
            .status
            .lock()
            .map_err(|_| "desktop updater status lock is poisoned".to_string())?;
        match self.operation_in_progress.compare_exchange(
            false,
            true,
            Ordering::SeqCst,
            Ordering::SeqCst,
        ) {
            Ok(_) => {
                self.check_result_invalidated.store(false, Ordering::SeqCst);
                Self::set_checking_status(&mut status, manual);
                Ok(Some(UpdaterOperationGuard { state: self }))
            }
            Err(_) if manual && status.state == "checking" => {
                Self::set_checking_status(&mut status, true);
                Ok(None)
            }
            Err(_) => Err("another Desktop update operation is already running".to_string()),
        }
    }

    pub fn schedule_automatic_check_once(&self) -> bool {
        self.automatic_check_scheduled
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    pub fn mark_workspace_hidden_by_update(&self) {
        self.workspace_hidden_by_update
            .store(true, Ordering::SeqCst);
    }

    pub fn take_workspace_hidden_by_update(&self) -> bool {
        self.workspace_hidden_by_update
            .swap(false, Ordering::SeqCst)
    }

    pub fn lock_workspace_visibility_transition(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, ()>, String> {
        self.workspace_visibility_transition
            .lock()
            .map_err(|_| "desktop workspace visibility lock is poisoned".to_string())
    }

    pub fn record_check_surface_failure(
        &self,
        checked_at: u64,
        message: String,
    ) -> Result<(), String> {
        let _transition = self
            .check_completion_transition
            .lock()
            .map_err(|_| "desktop check completion lock is poisoned".to_string())?;
        self.check_result_invalidated.store(true, Ordering::SeqCst);
        self.record_check_failure(true, checked_at, message)
    }

    pub fn apply_check_result_if_current<T>(
        &self,
        apply: impl FnOnce() -> Result<T, String>,
    ) -> Result<Option<T>, String> {
        let _transition = self
            .check_completion_transition
            .lock()
            .map_err(|_| "desktop check completion lock is poisoned".to_string())?;
        if self.check_result_invalidated.swap(false, Ordering::SeqCst) {
            return Ok(None);
        }
        apply().map(Some)
    }

    pub fn should_automatically_check(&self, now: u64) -> Result<bool, String> {
        if read_update_attempt(&self.recovery_path()?)?.is_some() {
            return Ok(false);
        }
        let persisted = self
            .persisted
            .lock()
            .map_err(|_| "desktop updater persistence lock is poisoned".to_string())?;
        Ok(persisted
            .last_checked_at
            .is_none_or(|checked| !timestamp_is_within_daily_window(now, checked)))
    }

    #[cfg(test)]
    pub fn begin_check(&self, manual: bool) -> Result<(), String> {
        let mut status = self
            .status
            .lock()
            .map_err(|_| "desktop updater status lock is poisoned".to_string())?;
        Self::set_checking_status(&mut status, manual);
        Ok(())
    }

    fn set_checking_status(status: &mut DesktopUpdaterStatus, manual: bool) {
        let surface_visible = manual || status.recovery.is_some();
        status.state = "checking";
        status.surface_visible = surface_visible;
        status.message = String::new();
        status.available_version = None;
        status.notes = None;
        status.published_at = None;
        status.downloaded_bytes = 0;
        status.total_bytes = None;
        status.can_check = false;
        status.can_install = false;
        status.can_dismiss = false;
    }

    pub fn record_no_update(&self, manual: bool, checked_at: u64) -> Result<(), String> {
        self.record_check_time(checked_at);
        let current_version = self.snapshot()?.current_version;
        let mut status = self
            .status
            .lock()
            .map_err(|_| "desktop updater status lock is poisoned".to_string())?;
        let manual = manual || status.surface_visible;
        let recovery = status.recovery.clone();
        *status = DesktopUpdaterStatus::idle(current_version);
        if let Some(recovery) = recovery {
            status.state = "recovery";
            status.surface_visible = true;
            status.message = format!(
                "Could not finish updating from {} to {}.",
                recovery.from_version, recovery.to_version
            );
            status.can_dismiss = true;
            Self::apply_recovery_context(&mut status, recovery);
        } else if manual {
            status.state = "current";
            status.surface_visible = true;
            status.message = "You have the latest version of Worktable.".into();
            status.can_dismiss = true;
        }
        Ok(())
    }

    pub fn record_available(
        &self,
        version: String,
        notes: Option<String>,
        published_at: Option<String>,
        checked_at: u64,
        manual: bool,
    ) -> Result<bool, String> {
        self.record_check_time(checked_at);
        let mut status = self
            .status
            .lock()
            .map_err(|_| "desktop updater status lock is poisoned".to_string())?;
        let manual = manual || status.surface_visible;
        let recovery = status.recovery.clone();
        let dismissed = {
            let persisted = self
                .persisted
                .lock()
                .map_err(|_| "desktop updater persistence lock is poisoned".to_string())?;
            persisted.dismissed_version.as_deref() == Some(version.as_str())
                && persisted.dismissed_at.is_some_and(|dismissed_at| {
                    timestamp_is_within_daily_window(checked_at, dismissed_at)
                })
        };
        if dismissed && !manual {
            let current_version = status.current_version.clone();
            *status = DesktopUpdaterStatus::idle(current_version);
            return Ok(false);
        }

        status.state = "available";
        status.surface_visible = true;
        status.message = format!("Worktable {version} is ready to download.");
        status.available_version = Some(version);
        status.notes = notes.filter(|value| !value.trim().is_empty());
        status.published_at = published_at;
        status.downloaded_bytes = 0;
        status.total_bytes = None;
        status.can_check = false;
        status.can_install = true;
        status.can_dismiss = true;
        if let Some(recovery) = recovery {
            Self::apply_recovery_context(&mut status, recovery);
        }
        Ok(true)
    }

    pub fn record_check_failure(
        &self,
        manual: bool,
        checked_at: u64,
        message: String,
    ) -> Result<(), String> {
        self.record_check_time(checked_at);
        let current_version = self.snapshot()?.current_version;
        let mut status = self
            .status
            .lock()
            .map_err(|_| "desktop updater status lock is poisoned".to_string())?;
        let manual = manual || status.surface_visible;
        let recovery = status.recovery.clone();
        *status = DesktopUpdaterStatus::idle(current_version);
        if let Some(recovery) = recovery {
            status.state = "error";
            status.surface_visible = true;
            status.message = message;
            status.can_dismiss = true;
            Self::apply_recovery_context(&mut status, recovery);
        } else if manual {
            status.state = "error";
            status.surface_visible = true;
            status.message = message;
            status.can_dismiss = true;
        }
        Ok(())
    }

    pub fn begin_download(&self, version: &str) -> Result<(), String> {
        let mut status = self
            .status
            .lock()
            .map_err(|_| "desktop updater status lock is poisoned".to_string())?;
        if status.available_version.as_deref() != Some(version) {
            return Err(
                "the available Desktop update changed; review it before downloading".into(),
            );
        }
        status.state = "downloading";
        status.surface_visible = true;
        status.message = format!("Downloading Worktable {version}…");
        status.downloaded_bytes = 0;
        status.total_bytes = None;
        status.can_install = false;
        status.can_dismiss = false;
        Ok(())
    }

    #[cfg(all(target_os = "macos", not(feature = "staging")))]
    pub fn record_download_progress(
        &self,
        chunk_bytes: usize,
        total_bytes: Option<u64>,
    ) -> Result<(), String> {
        let mut status = self
            .status
            .lock()
            .map_err(|_| "desktop updater status lock is poisoned".to_string())?;
        status.downloaded_bytes = status.downloaded_bytes.saturating_add(chunk_bytes as u64);
        status.total_bytes = total_bytes.or(status.total_bytes);
        Ok(())
    }

    pub fn begin_install(&self, version: &str, attempted_at: String) -> Result<(), String> {
        let current_version = self.snapshot()?.current_version;
        let attempt = UpdateAttempt {
            from_version: current_version.clone(),
            to_version: version.to_string(),
            previous_dmg_url: versioned_dmg_url(&current_version),
            attempted_at,
        };
        if let Err(error) = write_update_attempt(&self.recovery_path()?, &attempt) {
            eprintln!("[Worktable Desktop] could not prepare update recovery: {error}");
            let message = "Could not finish preparing the update. Try again.".to_string();
            self.record_recoverable_error(message.clone(), None)?;
            return Err(message);
        }
        let mut status = self
            .status
            .lock()
            .map_err(|_| "desktop updater status lock is poisoned".to_string())?;
        status.state = "installing";
        status.surface_visible = true;
        status.message = format!("Installing Worktable {version}…");
        status.can_check = false;
        status.can_install = false;
        status.can_dismiss = false;
        Ok(())
    }

    pub fn record_install_failure(&self, message: String) -> Result<(), String> {
        let recovery = match read_update_attempt(&self.recovery_path()?) {
            Ok(recovery) => recovery,
            Err(error) => {
                eprintln!(
                    "[Worktable Desktop] could not read update recovery marker while recording a recoverable failure: {error}"
                );
                None
            }
        };
        self.record_recoverable_error(message, recovery)
    }

    fn record_recoverable_error(
        &self,
        message: String,
        recovery: Option<UpdateAttempt>,
    ) -> Result<(), String> {
        let mut status = self
            .status
            .lock()
            .map_err(|_| "desktop updater status lock is poisoned".to_string())?;
        status.state = "error";
        status.surface_visible = true;
        status.message = message;
        status.can_check = true;
        status.can_install = false;
        status.can_dismiss = true;
        if let Some(recovery) = recovery {
            Self::apply_recovery_context(&mut status, recovery);
        } else {
            status.recovery = None;
        }
        Ok(())
    }

    fn apply_recovery_context(status: &mut DesktopUpdaterStatus, recovery: UpdateAttempt) {
        status.manual_download_url = recovery.previous_dmg_url.clone();
        status.recovery = Some(recovery);
    }

    pub fn dismiss(&self, now: u64) -> Result<(), String> {
        let (current_version, available_version) = {
            let status = self
                .status
                .lock()
                .map_err(|_| "desktop updater status lock is poisoned".to_string())?;
            if !status.can_dismiss {
                return Err(
                    "the Desktop update cannot be dismissed while an operation is in progress"
                        .to_string(),
                );
            }
            (
                status.current_version.clone(),
                status.available_version.clone(),
            )
        };
        let persistence_result = self.update_persisted(|persisted| {
            if let Some(version) = available_version {
                persisted.dismissed_version = Some(version);
                persisted.dismissed_at = Some(now);
            }
        });
        *self
            .status
            .lock()
            .map_err(|_| "desktop updater status lock is poisoned".to_string())? =
            DesktopUpdaterStatus::idle(current_version);
        if let Err(error) = persistence_result {
            eprintln!(
                "[Worktable Desktop] dismissed the update prompt in memory but could not persist the dismissal: {error}"
            );
        }
        Ok(())
    }

    pub fn available_version(&self) -> Result<Option<String>, String> {
        Ok(self.snapshot()?.available_version)
    }

    fn record_check_time(&self, checked_at: u64) {
        if let Err(error) = self.update_persisted(|persisted| {
            persisted.last_checked_at = Some(checked_at);
        }) {
            eprintln!(
                "[Worktable Desktop] completed the update check in memory but could not persist its timestamp: {error}"
            );
        }
    }

    fn update_persisted(
        &self,
        update: impl FnOnce(&mut PersistedUpdaterState),
    ) -> Result<(), String> {
        let path = self
            .state_path
            .lock()
            .map_err(|_| "desktop updater path lock is poisoned".to_string())?
            .clone()
            .ok_or_else(|| "desktop updater is not initialized".to_string())?;
        let mut persisted = self
            .persisted
            .lock()
            .map_err(|_| "desktop updater persistence lock is poisoned".to_string())?;
        update(&mut persisted);
        write_persisted_state(&path, &persisted)
    }

    fn recovery_path(&self) -> Result<PathBuf, String> {
        self.recovery_path
            .lock()
            .map_err(|_| "desktop updater recovery path lock is poisoned".to_string())?
            .clone()
            .ok_or_else(|| "desktop updater is not initialized".to_string())
    }
}

pub struct UpdaterOperationGuard<'a> {
    state: &'a DesktopUpdaterState,
}

impl Drop for UpdaterOperationGuard<'_> {
    fn drop(&mut self) {
        self.state
            .operation_in_progress
            .store(false, Ordering::SeqCst);
    }
}

pub fn now_epoch_seconds() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|error| format!("system clock cannot timestamp Desktop update state: {error}"))
}

pub fn now_rfc3339() -> Result<String, String> {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|error| format!("system clock cannot format Desktop update time: {error}"))
}

pub fn versioned_dmg_url(version: &str) -> String {
    format!("{RELEASE_BASE_URL}/v{version}/worktable-desktop-darwin-arm64.dmg")
}

fn version_reaches_or_exceeds(current_version: &str, target_version: &str) -> bool {
    Version::parse(current_version)
        .and_then(|current| Version::parse(target_version).map(|target| current >= target))
        .unwrap_or(false)
}

fn timestamp_is_within_daily_window(now: u64, recorded_at: u64) -> bool {
    recorded_at <= now && now - recorded_at < AUTOMATIC_CHECK_INTERVAL_SECS
}

fn read_persisted_state(path: &Path) -> Result<PersistedUpdaterState, String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(PersistedUpdaterState::default())
        }
        Err(error) => {
            return Err(format!(
                "failed to read Desktop update state {}: {error}",
                path.display()
            ))
        }
    };
    let parsed: PersistedUpdaterState = serde_json::from_str(&raw).map_err(|error| {
        format!(
            "failed to parse Desktop update state {}: {error}",
            path.display()
        )
    })?;
    if parsed.schema_version != UPDATE_STATE_SCHEMA_VERSION {
        return Err(format!(
            "unsupported Desktop update state schema version {}",
            parsed.schema_version
        ));
    }
    Ok(parsed)
}

fn write_persisted_state(path: &Path, state: &PersistedUpdaterState) -> Result<(), String> {
    write_private_json(path, state, UPDATE_STATE_FILE, "Desktop update state")
}

fn read_update_attempt(path: &Path) -> Result<Option<UpdateAttempt>, String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "failed to read Desktop update recovery marker {}: {error}",
                path.display()
            ))
        }
    };
    let attempt: UpdateAttempt = serde_json::from_str(&raw).map_err(|error| {
        format!(
            "failed to parse Desktop update recovery marker {}: {error}",
            path.display()
        )
    })?;
    validate_update_attempt(&attempt)
        .map_err(|error| {
            format!(
                "invalid Desktop update recovery marker {}: {error}",
                path.display()
            )
        })
        .map(|()| Some(attempt))
}

fn validate_update_attempt(attempt: &UpdateAttempt) -> Result<(), String> {
    Version::parse(&attempt.from_version)
        .map_err(|_| "the previous version is not valid semantic versioning".to_string())?;
    Version::parse(&attempt.to_version)
        .map_err(|_| "the target version is not valid semantic versioning".to_string())?;
    let expected_url = versioned_dmg_url(&attempt.from_version);
    if attempt.previous_dmg_url != expected_url {
        return Err("the previous signed disk-image URL does not match its version".to_string());
    }
    Ok(())
}

fn write_update_attempt(path: &Path, attempt: &UpdateAttempt) -> Result<(), String> {
    write_private_json(
        path,
        attempt,
        UPDATE_RECOVERY_FILE,
        "Desktop update recovery marker",
    )
}

fn remove_update_attempt(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "failed to remove Desktop update recovery marker {}: {error}",
            path.display()
        )),
    }
}

fn quarantine_invalid_state(path: &Path) {
    if !path.exists() {
        return;
    }
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("desktop-updater");
    let quarantined = path.with_file_name(format!(
        "{stem}.corrupt-{}-{}.json",
        process::id(),
        now_epoch_seconds().unwrap_or(0)
    ));
    if let Err(error) = fs::rename(path, &quarantined) {
        eprintln!(
            "[Worktable Desktop] failed to preserve invalid updater state {}: {error}",
            path.display()
        );
    }
}

fn write_private_json(
    path: &Path,
    state: &impl Serialize,
    file_name: &str,
    description: &str,
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Desktop update state path has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "failed to create Desktop app data {}: {error}",
            parent.display()
        )
    })?;
    let temporary = parent.join(format!(
        ".{file_name}.{}.{}.tmp",
        process::id(),
        now_epoch_seconds()?
    ));
    let bytes = serde_json::to_vec_pretty(state)
        .map_err(|error| format!("failed to serialize {description}: {error}"))?;
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options.open(&temporary)?;
        file.write_all(&bytes)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        Ok::<(), std::io::Error>(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(format!(
            "failed to persist {description} {}: {error}",
            path.display()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_root(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "worktable-desktop-updater-{name}-{}-{}",
            process::id(),
            now_epoch_seconds().unwrap()
        ))
    }

    #[test]
    fn automatic_checks_are_throttled_for_twenty_four_hours() {
        let root = temporary_root("throttle");
        let state = DesktopUpdaterState::default();
        state.initialize(&root, "0.0.45").unwrap();
        assert!(state.schedule_automatic_check_once());
        assert!(!state.schedule_automatic_check_once());
        assert!(state.should_automatically_check(100_000).unwrap());
        state.record_no_update(false, 100_000).unwrap();
        assert!(!state.should_automatically_check(186_399).unwrap());
        assert!(state.should_automatically_check(186_400).unwrap());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn backward_clock_corrections_expire_checks_and_dismissals() {
        let root = temporary_root("backward-clock");
        let state = DesktopUpdaterState::default();
        state.initialize(&root, "0.0.45").unwrap();
        state.record_no_update(false, 200_000).unwrap();
        assert!(state.should_automatically_check(100_000).unwrap());

        assert!(state
            .record_available("0.0.46".into(), None, None, 200_000, true)
            .unwrap());
        state.dismiss(200_000).unwrap();
        assert!(state
            .record_available("0.0.46".into(), None, None, 100_000, false)
            .unwrap());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn dismissed_version_stays_quiet_until_the_next_daily_window() {
        let root = temporary_root("dismiss");
        let state = DesktopUpdaterState::default();
        state.initialize(&root, "0.0.45").unwrap();
        assert!(state
            .record_available("0.0.46".into(), None, None, 100_000, false)
            .unwrap());
        state.dismiss(100_100).unwrap();
        assert!(!state
            .record_available("0.0.46".into(), None, None, 100_200, false)
            .unwrap());
        assert!(state
            .record_available("0.0.47".into(), None, None, 100_300, false)
            .unwrap());
        assert!(state
            .record_available("0.0.46".into(), None, None, 100_400, true)
            .unwrap());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn silent_checks_never_own_the_surface_but_available_updates_do() {
        let root = temporary_root("silent-surface");
        let state = DesktopUpdaterState::default();
        state.initialize(&root, "0.0.45").unwrap();

        state.begin_check(false).unwrap();
        let checking = state.snapshot().unwrap();
        assert_eq!(checking.state, "checking");
        assert!(!checking.surface_visible);
        assert!(!checking.can_dismiss);
        state.record_no_update(false, 100_000).unwrap();
        assert!(!state.snapshot().unwrap().surface_visible);

        state.begin_check(false).unwrap();
        state
            .record_check_failure(false, 150_000, "Network unavailable".into())
            .unwrap();
        let failed = state.snapshot().unwrap();
        assert_eq!(failed.state, "idle");
        assert!(!failed.surface_visible);

        state.begin_check(false).unwrap();
        assert!(state
            .record_available("0.0.46".into(), None, None, 200_000, false)
            .unwrap());
        let available = state.snapshot().unwrap();
        assert!(available.surface_visible);
        assert!(available.can_dismiss);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn manual_check_cannot_be_dismissed_until_its_result_arrives() {
        let root = temporary_root("manual-check-dismiss");
        let state = DesktopUpdaterState::default();
        state.initialize(&root, "0.0.45").unwrap();

        state.begin_check(true).unwrap();
        let checking = state.snapshot().unwrap();
        assert!(checking.surface_visible);
        assert!(!checking.can_dismiss);
        assert!(state.dismiss(100_000).is_err());
        assert_eq!(state.snapshot().unwrap().state, "checking");

        assert!(state
            .record_available("0.0.46".into(), None, None, 100_100, true)
            .unwrap());
        state.dismiss(100_200).unwrap();
        assert_eq!(state.snapshot().unwrap().state, "idle");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn manual_check_promotes_an_active_silent_check() {
        let root = temporary_root("manual-promotes-silent");
        let state = DesktopUpdaterState::default();
        state.initialize(&root, "0.0.45").unwrap();

        let automatic_operation = state.begin_check_operation(false).unwrap().unwrap();
        let silent = state.snapshot().unwrap();
        assert_eq!(silent.state, "checking");
        assert!(!silent.surface_visible);

        assert!(state.begin_check_operation(true).unwrap().is_none());
        let promoted = state.snapshot().unwrap();
        assert_eq!(promoted.state, "checking");
        assert!(promoted.surface_visible);
        assert!(!promoted.can_dismiss);

        state.record_no_update(false, 100_000).unwrap();
        let completed = state.snapshot().unwrap();
        assert_eq!(completed.state, "current");
        assert!(completed.surface_visible);
        assert!(completed.can_dismiss);
        drop(automatic_operation);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn failed_manual_surface_promotion_invalidates_the_joined_check_result() {
        let root = temporary_root("manual-promotion-surface-failure");
        let state = DesktopUpdaterState::default();
        state.initialize(&root, "0.0.45").unwrap();

        let automatic_operation = state.begin_check_operation(false).unwrap().unwrap();
        assert!(state.begin_check_operation(true).unwrap().is_none());
        state
            .record_check_surface_failure(100_000, "failed to show Desktop update surface".into())
            .unwrap();
        assert!(state
            .apply_check_result_if_current(|| state.record_no_update(false, 100_100))
            .unwrap()
            .is_none());
        let failed = state.snapshot().unwrap();
        assert_eq!(failed.state, "error");
        assert_eq!(
            failed.message,
            "failed to show Desktop update surface".to_string()
        );
        assert!(failed.surface_visible);
        assert!(failed.can_dismiss);
        drop(automatic_operation);

        let second_automatic_operation = state.begin_check_operation(false).unwrap().unwrap();
        assert!(state.begin_check_operation(true).unwrap().is_none());
        assert!(state
            .apply_check_result_if_current(|| state.record_no_update(false, 150_000))
            .unwrap()
            .is_some());
        state
            .record_check_surface_failure(
                150_100,
                "failed to reveal completed Desktop update check".into(),
            )
            .unwrap();
        assert_eq!(state.snapshot().unwrap().state, "error");
        assert_eq!(
            state.snapshot().unwrap().message,
            "failed to reveal completed Desktop update check".to_string()
        );
        drop(second_automatic_operation);

        let next_operation = state.begin_check_operation(true).unwrap().unwrap();
        assert!(state
            .apply_check_result_if_current(|| state.record_no_update(true, 200_000))
            .unwrap()
            .is_some());
        assert_eq!(state.snapshot().unwrap().state, "current");
        drop(next_operation);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn updater_restores_only_a_workspace_it_hid() {
        let state = DesktopUpdaterState::default();
        assert!(!state.take_workspace_hidden_by_update());
        state.mark_workspace_hidden_by_update();
        assert!(state.take_workspace_hidden_by_update());
        assert!(!state.take_workspace_hidden_by_update());
    }

    #[test]
    fn workspace_visibility_transition_closes_dismissal_overlap() {
        let root = temporary_root("workspace-visibility-overlap");
        let state = DesktopUpdaterState::default();
        state.initialize(&root, "0.0.45").unwrap();
        assert!(state
            .record_available("0.0.46".into(), None, None, 100_000, true)
            .unwrap());

        {
            let _transition = state.lock_workspace_visibility_transition().unwrap();
            state.dismiss(100_100).unwrap();
            assert!(!state.snapshot().unwrap().surface_visible);
            assert!(!state.take_workspace_hidden_by_update());
        }

        assert!(state
            .record_available("0.0.47".into(), None, None, 200_000, true)
            .unwrap());
        {
            let _transition = state.lock_workspace_visibility_transition().unwrap();
            assert!(state.snapshot().unwrap().surface_visible);
            state.mark_workspace_hidden_by_update();
        }
        state.dismiss(200_100).unwrap();
        {
            let _transition = state.lock_workspace_visibility_transition().unwrap();
            assert!(!state.snapshot().unwrap().surface_visible);
            assert!(state.take_workspace_hidden_by_update());
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn check_completion_remains_authoritative_when_timestamp_persistence_fails() {
        let root = temporary_root("check-time-persistence");
        let state = DesktopUpdaterState::default();
        state.initialize(&root, "0.0.45").unwrap();
        state.begin_check(true).unwrap();
        let state_path = root.join(UPDATE_STATE_FILE);
        fs::create_dir_all(&state_path).unwrap();

        state
            .record_check_failure(true, 100_000, "Network unavailable".into())
            .unwrap();
        let status = state.snapshot().unwrap();
        assert_eq!(status.state, "error");
        assert!(status.surface_visible);
        assert!(status.can_check);
        assert!(status.can_dismiss);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn dismiss_restores_idle_state_when_persistence_fails() {
        let root = temporary_root("dismiss-persistence");
        let state = DesktopUpdaterState::default();
        state.initialize(&root, "0.0.45").unwrap();
        assert!(state
            .record_available("0.0.46".into(), None, None, 100_000, false)
            .unwrap());
        let state_path = root.join(UPDATE_STATE_FILE);
        fs::remove_file(&state_path).unwrap();
        fs::create_dir(&state_path).unwrap();

        state.dismiss(100_100).unwrap();
        let status = state.snapshot().unwrap();
        assert_eq!(status.state, "idle");
        assert!(status.can_check);
        assert!(!status.can_dismiss);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn feed_recheck_failure_becomes_a_persistent_recoverable_state() {
        let root = temporary_root("feed-recheck-failure");
        let state = DesktopUpdaterState::default();
        state.initialize(&root, "0.0.45").unwrap();
        assert!(state
            .record_available("0.0.46".into(), None, None, 100_000, true)
            .unwrap());

        state
            .record_install_failure("Could not confirm the signed update".into())
            .unwrap();
        let status = state.snapshot().unwrap();
        assert_eq!(status.state, "error");
        assert!(status.surface_visible);
        assert!(status.can_check);
        assert!(status.can_dismiss);
        assert!(!status.can_install);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn install_marker_failure_does_not_strand_the_downloading_state() {
        let root = temporary_root("install-marker-failure");
        let state = DesktopUpdaterState::default();
        state.initialize(&root, "0.0.45").unwrap();
        assert!(state
            .record_available("0.0.46".into(), None, None, 100_000, true)
            .unwrap());
        state.begin_download("0.0.46").unwrap();
        fs::create_dir(root.join(UPDATE_RECOVERY_FILE)).unwrap();

        assert!(state
            .begin_install("0.0.46", "2026-07-29T12:34:56Z".into())
            .is_err());
        let status = state.snapshot().unwrap();
        assert_eq!(status.state, "error");
        assert!(status.surface_visible);
        assert!(status.can_check);
        assert!(status.can_dismiss);
        assert!(!status.can_install);
        assert_eq!(
            status.message,
            "Could not finish preparing the update. Try again."
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn pending_attempt_becomes_recovery_until_the_new_version_boots() {
        let root = temporary_root("recovery");
        let first = DesktopUpdaterState::default();
        first.initialize(&root, "0.0.45").unwrap();
        first
            .record_available("0.0.46".into(), None, None, 100_000, false)
            .unwrap();
        first.begin_download("0.0.46").unwrap();
        first
            .begin_install("0.0.46", "2026-07-29T12:34:56Z".into())
            .unwrap();

        let old_boot = DesktopUpdaterState::default();
        old_boot.initialize(&root, "0.0.45").unwrap();
        let recovery = old_boot.snapshot().unwrap();
        assert_eq!(recovery.state, "recovery");
        assert_eq!(recovery.recovery.unwrap().to_version, "0.0.46");
        assert!(!old_boot.should_automatically_check(200_000).unwrap());
        old_boot.dismiss(200_000).unwrap();
        assert!(!old_boot.should_automatically_check(200_001).unwrap());
        assert!(read_update_attempt(&root.join(UPDATE_RECOVERY_FILE))
            .unwrap()
            .is_some());

        let new_boot = DesktopUpdaterState::default();
        new_boot.initialize(&root, "0.0.46").unwrap();
        assert_eq!(new_boot.snapshot().unwrap().state, "idle");
        assert!(read_update_attempt(&root.join(UPDATE_RECOVERY_FILE))
            .unwrap()
            .is_some());
        new_boot.mark_healthy_boot().unwrap();
        assert!(read_update_attempt(&root.join(UPDATE_RECOVERY_FILE))
            .unwrap()
            .is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn older_launch_recovers_the_version_recorded_before_the_attempt() {
        let root = temporary_root("recorded-recovery");
        let first = DesktopUpdaterState::default();
        first.initialize(&root, "0.0.46").unwrap();
        first
            .record_available("0.0.47".into(), None, None, 100_000, false)
            .unwrap();
        first.begin_download("0.0.47").unwrap();
        first
            .begin_install("0.0.47", "2026-07-29T12:34:56Z".into())
            .unwrap();

        let older_boot = DesktopUpdaterState::default();
        older_boot.initialize(&root, "0.0.45").unwrap();
        let recovery = older_boot.snapshot().unwrap();
        assert_eq!(recovery.state, "recovery");
        assert_eq!(recovery.manual_download_url, versioned_dmg_url("0.0.46"));
        assert_eq!(recovery.recovery.unwrap().from_version, "0.0.46");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn recovery_context_survives_every_check_again_result() {
        let root = temporary_root("recovery-recheck");
        let first = DesktopUpdaterState::default();
        first.initialize(&root, "0.0.46").unwrap();
        first
            .record_available("0.0.47".into(), None, None, 100_000, false)
            .unwrap();
        first.begin_download("0.0.47").unwrap();
        first
            .begin_install("0.0.47", "2026-07-29T12:34:56Z".into())
            .unwrap();

        let old_boot = DesktopUpdaterState::default();
        old_boot.initialize(&root, "0.0.45").unwrap();
        old_boot.begin_check(true).unwrap();
        assert_eq!(
            old_boot.snapshot().unwrap().recovery.unwrap().from_version,
            "0.0.46"
        );
        old_boot.record_no_update(true, 200_000).unwrap();
        let no_update = old_boot.snapshot().unwrap();
        assert_eq!(no_update.state, "recovery");
        assert_eq!(no_update.manual_download_url, versioned_dmg_url("0.0.46"));
        assert_eq!(no_update.recovery.unwrap().to_version, "0.0.47");

        old_boot.begin_check(true).unwrap();
        old_boot
            .record_check_failure(true, 200_100, "Network unavailable".into())
            .unwrap();
        let failed = old_boot.snapshot().unwrap();
        assert_eq!(failed.state, "error");
        assert_eq!(failed.manual_download_url, versioned_dmg_url("0.0.46"));
        assert_eq!(failed.recovery.unwrap().to_version, "0.0.47");

        old_boot.begin_check(true).unwrap();
        assert!(old_boot
            .record_available("0.0.47".into(), None, None, 200_200, true)
            .unwrap());
        let available = old_boot.snapshot().unwrap();
        assert_eq!(available.state, "available");
        assert_eq!(available.manual_download_url, versioned_dmg_url("0.0.46"));
        assert_eq!(available.recovery.unwrap().to_version, "0.0.47");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn recovery_marker_cannot_redirect_the_manual_download() {
        let root = temporary_root("recovery-url-validation");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join(UPDATE_RECOVERY_FILE),
            br#"{
  "fromVersion": "0.0.46",
  "toVersion": "0.0.47",
  "previousDmgUrl": "https://example.com/worktable.dmg",
  "attemptedAt": "2026-07-29T12:34:56Z"
}"#,
        )
        .unwrap();

        let state = DesktopUpdaterState::default();
        state.initialize(&root, "0.0.45").unwrap();
        let status = state.snapshot().unwrap();
        assert_eq!(status.state, "idle");
        assert_eq!(status.manual_download_url, versioned_dmg_url("0.0.45"));
        assert!(fs::read_dir(&root).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("desktop-update-recovery.corrupt-")
        }));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn newer_manual_install_completes_an_older_recovery_target() {
        let root = temporary_root("newer-recovery");
        let first = DesktopUpdaterState::default();
        first.initialize(&root, "0.0.45").unwrap();
        first
            .record_available("0.0.46".into(), None, None, 100_000, false)
            .unwrap();
        first.begin_download("0.0.46").unwrap();
        first
            .begin_install("0.0.46", "2026-07-29T12:34:56Z".into())
            .unwrap();

        let newer_boot = DesktopUpdaterState::default();
        newer_boot.initialize(&root, "0.0.47").unwrap();
        assert_eq!(newer_boot.snapshot().unwrap().state, "idle");
        newer_boot.mark_healthy_boot().unwrap();
        assert!(read_update_attempt(&root.join(UPDATE_RECOVERY_FILE))
            .unwrap()
            .is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn updater_state_never_contains_workspace_or_connection_material() {
        let root = temporary_root("scope");
        let state = DesktopUpdaterState::default();
        state.initialize(&root, "0.0.45").unwrap();
        state
            .record_available(
                "0.0.46".into(),
                Some("Signed Desktop update".into()),
                Some("2026-07-29T00:00:00Z".into()),
                100_000,
                false,
            )
            .unwrap();
        state.begin_download("0.0.46").unwrap();
        state
            .begin_install("0.0.46", "2026-07-29T12:34:56Z".into())
            .unwrap();
        let raw = fs::read_to_string(root.join(UPDATE_RECOVERY_FILE)).unwrap();
        assert!(!raw.contains("workspace"));
        assert!(!raw.contains("connection"));
        assert!(!raw.contains("token"));
        assert!(raw.contains("worktable-desktop-darwin-arm64.dmg"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn manual_dmg_recovery_url_is_immutable_and_versioned() {
        assert_eq!(
            versioned_dmg_url("0.0.45"),
            "https://worktable.dev/releases/v0.0.45/worktable-desktop-darwin-arm64.dmg"
        );
    }

    #[test]
    fn malformed_machine_state_is_preserved_without_blocking_startup() {
        let root = temporary_root("malformed");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(UPDATE_STATE_FILE), b"{not-json").unwrap();
        fs::write(root.join(UPDATE_RECOVERY_FILE), b"{not-json").unwrap();

        let state = DesktopUpdaterState::default();
        state.initialize(&root, "0.0.45").unwrap();
        assert_eq!(state.snapshot().unwrap().state, "idle");
        assert!(state.should_automatically_check(100_000).unwrap());
        let quarantined = fs::read_dir(&root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(quarantined.len(), 2);
        assert!(quarantined
            .iter()
            .any(|name| name.starts_with("desktop-updater-state.corrupt-")));
        assert!(quarantined
            .iter()
            .any(|name| name.starts_with("desktop-update-recovery.corrupt-")));
        let _ = fs::remove_dir_all(root);
    }
}
