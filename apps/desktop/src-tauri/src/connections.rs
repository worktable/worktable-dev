use crate::{
    cloud_auth::WORKTABLE_CLOUD_ORIGIN,
    remote_connection::{normalize_remote_origin, remote_origin_string},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process,
    time::{SystemTime, UNIX_EPOCH},
};

pub const CONNECTIONS_SCHEMA_VERSION: u8 = 3;
pub const CONNECTIONS_FILE: &str = "desktop-connections.json";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "provider", deny_unknown_fields)]
pub enum DesktopConnectionProfile {
    #[serde(rename = "local")]
    Local {
        id: String,
        #[serde(rename = "label")]
        display_name: String,
        #[serde(rename = "workspaceId")]
        workspace_id: String,
        #[serde(rename = "workspacePath")]
        workspace_path: String,
        port: u16,
    },
    #[serde(rename = "selfHosted")]
    SelfHosted {
        id: String,
        #[serde(rename = "label")]
        display_name: String,
        origin: String,
        #[serde(rename = "workspaceId", skip_serializing_if = "Option::is_none")]
        workspace_id: Option<String>,
        #[serde(rename = "allowInsecureHttp", default)]
        allow_insecure_http: bool,
    },
    #[serde(rename = "cloud")]
    Cloud {
        id: String,
        #[serde(rename = "label")]
        display_name: String,
        origin: String,
        #[serde(rename = "workosUserId")]
        workos_user_id: String,
        #[serde(rename = "hostedWorkspaceId")]
        hosted_workspace_id: String,
        #[serde(rename = "portableWorkspaceId")]
        portable_workspace_id: String,
    },
}

impl DesktopConnectionProfile {
    pub fn id(&self) -> &str {
        match self {
            Self::Local { id, .. } | Self::SelfHosted { id, .. } | Self::Cloud { id, .. } => id,
        }
    }

    pub fn local(
        display_name: String,
        workspace_id: String,
        workspace_path: String,
        port: u16,
    ) -> Self {
        Self::Local {
            id: format!("local:{workspace_id}"),
            display_name,
            workspace_id,
            workspace_path,
            port,
        }
    }

    pub fn self_hosted(
        id: String,
        display_name: String,
        origin: String,
        workspace_id: String,
        allow_insecure_http: bool,
    ) -> Self {
        Self::SelfHosted {
            id,
            display_name,
            origin,
            workspace_id: Some(workspace_id),
            allow_insecure_http,
        }
    }

    pub fn cloud(
        display_name: String,
        workos_user_id: String,
        hosted_workspace_id: String,
        portable_workspace_id: String,
    ) -> Self {
        Self::Cloud {
            id: format!("cloud:{workos_user_id}"),
            display_name,
            origin: WORKTABLE_CLOUD_ORIGIN.into(),
            workos_user_id,
            hosted_workspace_id,
            portable_workspace_id,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DesktopConnections {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u8,
    #[serde(rename = "activeConnectionId")]
    pub active_profile_id: Option<String>,
    #[serde(rename = "connections")]
    pub profiles: Vec<DesktopConnectionProfile>,
}

impl Default for DesktopConnections {
    fn default() -> Self {
        Self {
            schema_version: CONNECTIONS_SCHEMA_VERSION,
            active_profile_id: None,
            profiles: Vec::new(),
        }
    }
}

impl DesktopConnections {
    pub fn validate(self) -> Result<Self, String> {
        if self.schema_version != CONNECTIONS_SCHEMA_VERSION {
            return Err(format!(
                "unsupported desktop connection schema version {}",
                self.schema_version
            ));
        }
        let mut ids = HashSet::new();
        let mut local_ports = HashSet::new();
        let mut remote_origins = HashSet::new();
        let mut cloud_profiles = 0_u8;
        for profile in &self.profiles {
            if profile.id().trim().is_empty() || !ids.insert(profile.id()) {
                return Err("desktop connection profiles contain an empty or duplicate id".into());
            }
            match profile {
                DesktopConnectionProfile::Local {
                    id,
                    workspace_id,
                    workspace_path,
                    port,
                    ..
                } => {
                    if id != &format!("local:{workspace_id}") {
                        return Err(
                            "local desktop profile id does not match its workspace id".into()
                        );
                    }
                    if workspace_id.trim().is_empty()
                        || workspace_path.trim().is_empty()
                        || !Path::new(workspace_path).is_absolute()
                        || *port == 0
                    {
                        return Err("local desktop profile has invalid workspace data".into());
                    }
                    if !local_ports.insert(*port) {
                        return Err("local desktop profiles cannot share a loopback port".into());
                    }
                }
                DesktopConnectionProfile::SelfHosted {
                    origin,
                    workspace_id,
                    allow_insecure_http,
                    ..
                } => {
                    let normalized = normalize_remote_origin(origin).map_err(|error| {
                        format!("remote desktop profile has an invalid origin: {error}")
                    })?;
                    if origin != &remote_origin_string(&normalized) {
                        return Err("remote desktop profile origin is not canonical".into());
                    }
                    if !remote_origins.insert(origin) {
                        return Err("remote desktop profiles cannot share an origin".into());
                    }
                    if workspace_id.as_ref().is_some_and(|id| id.trim().is_empty()) {
                        return Err("remote desktop profile has an empty workspace id".into());
                    }
                    if normalized.scheme() == "https" && *allow_insecure_http {
                        return Err(
                            "secure remote desktop profile has an unexpected HTTP acknowledgement"
                                .into(),
                        );
                    }
                }
                DesktopConnectionProfile::Cloud {
                    id,
                    display_name,
                    origin,
                    workos_user_id,
                    hosted_workspace_id,
                    portable_workspace_id,
                } => {
                    cloud_profiles += 1;
                    if cloud_profiles > 1 {
                        return Err("Desktop supports only one Worktable Cloud connection".into());
                    }
                    if origin != WORKTABLE_CLOUD_ORIGIN {
                        return Err("Worktable Cloud profile has an unexpected origin".into());
                    }
                    if workos_user_id.trim().is_empty()
                        || hosted_workspace_id.trim().is_empty()
                        || portable_workspace_id.trim().is_empty()
                        || display_name.trim().is_empty()
                        || id != &format!("cloud:{workos_user_id}")
                    {
                        return Err("Worktable Cloud profile has invalid identity data".into());
                    }
                }
            }
        }
        if self
            .active_profile_id
            .as_ref()
            .is_some_and(|active| !ids.contains(active.as_str()))
        {
            return Err("active desktop connection profile does not exist".into());
        }
        Ok(self)
    }

    pub fn active(&self) -> Option<&DesktopConnectionProfile> {
        let active = self.active_profile_id.as_deref()?;
        self.profiles.iter().find(|profile| profile.id() == active)
    }

    pub fn activate(&mut self, profile: DesktopConnectionProfile) {
        let id = profile.id().to_string();
        if let Some(existing) = self
            .profiles
            .iter_mut()
            .find(|candidate| candidate.id() == id)
        {
            *existing = profile;
        } else {
            self.profiles.push(profile);
        }
        self.active_profile_id = Some(id);
    }

    pub fn remove_active(&mut self) {
        if let Some(active) = self.active_profile_id.take() {
            self.profiles.retain(|profile| profile.id() != active);
        }
    }

    pub fn remove(&mut self, profile_id: &str) {
        self.profiles.retain(|profile| profile.id() != profile_id);
        if self.active_profile_id.as_deref() == Some(profile_id) {
            self.active_profile_id = None;
        }
    }
}

pub fn connections_path(app_data_root: &Path) -> PathBuf {
    app_data_root.join(CONNECTIONS_FILE)
}

#[cfg(test)]
pub fn read_connections(path: &Path) -> Result<DesktopConnections, String> {
    let (connections, migrated) = load_connections(path)?;
    if migrated {
        write_connections(path, &connections)?;
    }
    Ok(connections)
}

pub fn read_connections_for_boot(path: &Path) -> Result<(DesktopConnections, bool), String> {
    load_connections(path)
}

pub fn persist_connections_for_boot(
    path: &Path,
    connections: &DesktopConnections,
    migration_pending: bool,
    allow_migration_promotion: bool,
) -> Result<bool, String> {
    if migration_pending && !allow_migration_promotion {
        return Ok(true);
    }
    write_connections(path, connections)?;
    Ok(false)
}

fn load_connections(path: &Path) -> Result<(DesktopConnections, bool), String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((DesktopConnections::default(), false))
        }
        Err(error) => {
            return Err(format!(
                "failed to read desktop connections {}: {error}",
                path.display()
            ))
        }
    };
    let document = serde_json::from_str::<serde_json::Value>(&raw).map_err(|error| {
        format!(
            "failed to parse desktop connections {}: {error}",
            path.display()
        )
    })?;
    let schema_version = document
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| "desktop connections have no schema version".to_string())?;
    let (parsed, migrated) = match schema_version {
        1 | 2 => (migrate_legacy_connections(document)?, true),
        3 => (
            serde_json::from_value::<DesktopConnections>(document).map_err(|error| {
                format!(
                    "failed to parse desktop connections {}: {error}",
                    path.display()
                )
            })?,
            false,
        ),
        other => {
            return Err(format!(
                "unsupported desktop connection schema version {other}"
            ))
        }
    };
    let validated = parsed.validate()?;
    Ok((validated, migrated))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyDesktopConnections {
    schema_version: u8,
    active_profile_id: Option<String>,
    profiles: Vec<LegacyDesktopConnectionProfile>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind")]
enum LegacyDesktopConnectionProfile {
    #[serde(rename = "local")]
    Local {
        id: String,
        #[serde(rename = "displayName")]
        display_name: String,
        #[serde(rename = "workspaceId")]
        workspace_id: String,
        #[serde(rename = "workspacePath")]
        workspace_path: String,
        port: u16,
    },
    #[serde(rename = "selfHosted")]
    SelfHosted {
        id: String,
        #[serde(rename = "displayName")]
        display_name: String,
        origin: String,
        #[serde(rename = "workspaceId")]
        workspace_id: Option<String>,
        #[serde(rename = "allowInsecureHttp", default)]
        allow_insecure_http: bool,
    },
    #[serde(rename = "cloud")]
    Cloud { id: String },
}

fn migrate_legacy_connections(document: serde_json::Value) -> Result<DesktopConnections, String> {
    let legacy = serde_json::from_value::<LegacyDesktopConnections>(document)
        .map_err(|error| format!("failed to parse legacy desktop connections: {error}"))?;
    if !matches!(legacy.schema_version, 1 | 2) {
        return Err(format!(
            "unsupported desktop connection schema version {}",
            legacy.schema_version
        ));
    }
    let mut removed_active_cloud = false;
    let mut profiles = Vec::with_capacity(legacy.profiles.len());
    for profile in legacy.profiles {
        match profile {
            LegacyDesktopConnectionProfile::Local {
                id,
                display_name,
                workspace_id,
                workspace_path,
                port,
            } => profiles.push(DesktopConnectionProfile::Local {
                id,
                display_name,
                workspace_id,
                workspace_path,
                port,
            }),
            LegacyDesktopConnectionProfile::SelfHosted {
                id,
                display_name,
                origin,
                workspace_id,
                allow_insecure_http,
            } => {
                let normalized = normalize_remote_origin(&origin).map_err(|error| {
                    format!("failed to migrate remote desktop profile origin: {error}")
                })?;
                profiles.push(DesktopConnectionProfile::SelfHosted {
                    id,
                    display_name,
                    origin: remote_origin_string(&normalized),
                    workspace_id,
                    allow_insecure_http,
                });
            }
            LegacyDesktopConnectionProfile::Cloud { id } => {
                removed_active_cloud |= legacy.active_profile_id.as_deref() == Some(id.as_str());
            }
        }
    }
    Ok(DesktopConnections {
        schema_version: CONNECTIONS_SCHEMA_VERSION,
        active_profile_id: if removed_active_cloud {
            None
        } else {
            legacy.active_profile_id
        },
        profiles,
    })
}

pub fn write_connections(path: &Path, connections: &DesktopConnections) -> Result<(), String> {
    let validated = connections.clone().validate()?;
    let parent = path
        .parent()
        .ok_or_else(|| "desktop connections path has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "failed to create desktop app data {}: {error}",
            parent.display()
        )
    })?;
    let temporary = parent.join(format!(
        ".{CONNECTIONS_FILE}.{}.{}.tmp",
        process::id(),
        now_nanos()?
    ));
    let bytes = serde_json::to_vec_pretty(&validated)
        .map_err(|error| format!("failed to serialize desktop connections: {error}"))?;
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
            "failed to persist desktop connections {}: {error}",
            path.display()
        ));
    }
    Ok(())
}

pub fn quarantine_connections(path: &Path) -> Result<Option<PathBuf>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let quarantine =
        path.with_file_name(format!("desktop-connections.corrupt-{}.json", now_nanos()?));
    fs::rename(path, &quarantine).map_err(|error| {
        format!(
            "failed to preserve corrupt desktop connections {}: {error}",
            path.display()
        )
    })?;
    Ok(Some(quarantine))
}

fn now_nanos() -> Result<u128, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .map_err(|error| format!("system clock cannot timestamp desktop state: {error}"))
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceIdentity {
    pub id: String,
    pub name: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "outcome", rename_all = "kebab-case")]
pub enum WorkspaceInspection {
    Missing {
        path: String,
    },
    Empty {
        path: String,
    },
    Valid {
        path: String,
        workspace: WorkspaceIdentity,
    },
    Reject {
        path: String,
        reason: String,
        message: String,
    },
}

impl WorkspaceInspection {
    pub fn path(&self) -> &str {
        match self {
            Self::Missing { path }
            | Self::Empty { path }
            | Self::Valid { path, .. }
            | Self::Reject { path, .. } => path,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePrepared {
    pub path: String,
    pub created: bool,
    pub workspace: WorkspaceIdentity,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SavedWorkspaceResolution {
    Ready(WorkspacePrepared),
    Missing,
    Rejected(String),
    IdentityMismatch(WorkspaceIdentity),
}

pub fn resolve_saved_workspace(
    inspection: WorkspaceInspection,
    expected_workspace_id: &str,
) -> SavedWorkspaceResolution {
    match inspection {
        WorkspaceInspection::Valid { path, workspace } if workspace.id == expected_workspace_id => {
            SavedWorkspaceResolution::Ready(WorkspacePrepared {
                path,
                created: false,
                workspace,
            })
        }
        WorkspaceInspection::Valid { workspace, .. } => {
            SavedWorkspaceResolution::IdentityMismatch(workspace)
        }
        WorkspaceInspection::Reject { message, .. } => SavedWorkspaceResolution::Rejected(message),
        WorkspaceInspection::Missing { .. } | WorkspaceInspection::Empty { .. } => {
            SavedWorkspaceResolution::Missing
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCommandError {
    pub code: String,
    pub message: String,
    pub path: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectionEnvelope {
    pub schema_version: u8,
    pub ok: bool,
    pub inspection: WorkspaceInspection,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparationEnvelope {
    pub schema_version: u8,
    pub ok: bool,
    pub prepared: Option<WorkspacePrepared>,
    pub error: Option<WorkspaceCommandError>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "worktable-desktop-{label}-{}-{}",
            process::id(),
            now_nanos().unwrap()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn local_profile(port: u16) -> DesktopConnectionProfile {
        DesktopConnectionProfile::local(
            "Local Workspace".into(),
            "ws_test".into(),
            "/tmp/Worktable".into(),
            port,
        )
    }

    #[test]
    fn connection_profiles_round_trip_atomically() {
        let root = temp_dir("profiles");
        let path = connections_path(&root);
        let mut connections = DesktopConnections::default();
        connections.activate(local_profile(17480));
        write_connections(&path, &connections).unwrap();
        assert_eq!(read_connections(&path).unwrap(), connections);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_unknown_schema_duplicate_ids_and_missing_active_profile() {
        let profile = local_profile(17480);
        assert!(DesktopConnections {
            schema_version: 99,
            active_profile_id: None,
            profiles: vec![],
        }
        .validate()
        .is_err());

        let other_workspace = DesktopConnectionProfile::local(
            "Other Workspace".into(),
            "ws_other".into(),
            "/tmp/OtherWorktable".into(),
            17480,
        );
        assert!(DesktopConnections {
            schema_version: CONNECTIONS_SCHEMA_VERSION,
            active_profile_id: None,
            profiles: vec![profile.clone(), other_workspace],
        }
        .validate()
        .unwrap_err()
        .contains("cannot share a loopback port"));
        assert!(DesktopConnections {
            schema_version: CONNECTIONS_SCHEMA_VERSION,
            active_profile_id: None,
            profiles: vec![DesktopConnectionProfile::Cloud {
                id: "cloud:test".into(),
                display_name: "Cloud".into(),
                origin: "https://example.com".into(),
                workos_user_id: "test".into(),
                hosted_workspace_id: "hosted".into(),
                portable_workspace_id: "portable".into(),
            }],
        }
        .validate()
        .is_err());
        assert!(DesktopConnections {
            schema_version: CONNECTIONS_SCHEMA_VERSION,
            active_profile_id: None,
            profiles: vec![profile.clone(), profile],
        }
        .validate()
        .is_err());
        assert!(DesktopConnections {
            schema_version: CONNECTIONS_SCHEMA_VERSION,
            active_profile_id: Some("local:missing".into()),
            profiles: vec![],
        }
        .validate()
        .is_err());
    }

    #[test]
    fn migrates_schema_one_profiles_without_losing_remote_setup_state() {
        let root = temp_dir("profile-migration");
        let path = connections_path(&root);
        fs::write(
            &path,
            r#"{
  "schemaVersion": 1,
  "activeProfileId": "remote-old",
  "profiles": [
    {
      "id": "remote-old",
      "kind": "selfHosted",
      "displayName": "Remote",
      "origin": "https://Example.com/"
    }
  ]
}"#,
        )
        .unwrap();
        let migrated = read_connections(&path).unwrap();
        assert_eq!(migrated.schema_version, CONNECTIONS_SCHEMA_VERSION);
        assert_eq!(migrated.active_profile_id.as_deref(), Some("remote-old"));
        assert!(matches!(
            &migrated.profiles[0],
            DesktopConnectionProfile::SelfHosted {
                origin,
                workspace_id: None,
                allow_insecure_http: false,
                ..
            } if origin == "https://example.com"
        ));
        let persisted: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(persisted["schemaVersion"], CONNECTIONS_SCHEMA_VERSION);
        assert!(persisted.get("activeProfileId").is_none());
        assert!(persisted.get("profiles").is_none());
        assert_eq!(persisted["activeConnectionId"], "remote-old");
        assert_eq!(persisted["connections"][0]["provider"], "selfHosted");
        assert_eq!(persisted["connections"][0]["label"], "Remote");
        assert_eq!(persisted["connections"][0]["allowInsecureHttp"], false);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn schema_two_migration_preserves_real_profiles_and_discards_cloud_placeholders() {
        let root = temp_dir("schema-two-cloud-removal");
        let path = connections_path(&root);
        fs::write(
            &path,
            r#"{
  "schemaVersion": 2,
  "activeProfileId": "cloud:unreachable",
  "profiles": [
    {
      "id": "local:ws_real",
      "kind": "local",
      "displayName": "Real local workspace",
      "workspaceId": "ws_real",
      "workspacePath": "/tmp/Worktable",
      "port": 17480
    },
    {
      "id": "remote-real",
      "kind": "selfHosted",
      "displayName": "Real server",
      "origin": "https://Example.com/",
      "workspaceId": "ws_remote"
    },
    {
      "id": "cloud:unreachable",
      "kind": "cloud",
      "displayName": "Never connected",
      "origin": "https://app.worktable.cloud"
    }
  ]
}"#,
        )
        .unwrap();

        let migrated = read_connections(&path).unwrap();
        assert_eq!(migrated.schema_version, CONNECTIONS_SCHEMA_VERSION);
        assert_eq!(migrated.active_profile_id, None);
        assert_eq!(migrated.profiles.len(), 2);
        assert!(matches!(
            &migrated.profiles[0],
            DesktopConnectionProfile::Local { workspace_id, .. } if workspace_id == "ws_real"
        ));
        assert!(matches!(
            &migrated.profiles[1],
            DesktopConnectionProfile::SelfHosted { origin, .. } if origin == "https://example.com"
        ));

        let persisted: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(persisted["schemaVersion"], 3);
        assert!(persisted["activeConnectionId"].is_null());
        assert_eq!(persisted["connections"].as_array().unwrap().len(), 2);
        assert!(persisted["connections"]
            .as_array()
            .unwrap()
            .iter()
            .all(|connection| connection["provider"] != "cloud"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn boot_migration_keeps_schema_two_readable_until_the_new_shell_is_healthy() {
        let root = temp_dir("rollback-readable");
        let path = connections_path(&root);
        fs::write(
            &path,
            r#"{
  "schemaVersion": 2,
  "activeProfileId": "local:workspace-1",
  "profiles": [
    {
      "kind": "local",
      "id": "local:workspace-1",
      "displayName": "Local workspace",
      "workspaceId": "workspace-1",
      "workspacePath": "/tmp/Worktable",
      "port": 7480
    }
  ]
}"#,
        )
        .unwrap();

        let (connections, migration_pending) = read_connections_for_boot(&path).unwrap();
        assert!(migration_pending);
        assert_eq!(connections.schema_version, CONNECTIONS_SCHEMA_VERSION);
        assert_eq!(
            connections.active_profile_id.as_deref(),
            Some("local:workspace-1")
        );
        let rollback_readable: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(rollback_readable["schemaVersion"], 2);
        assert!(rollback_readable.get("profiles").is_some());

        assert!(
            persist_connections_for_boot(&path, &connections, true, false).unwrap(),
            "the migration should remain pending before healthy boot"
        );
        let still_rollback_readable: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(still_rollback_readable["schemaVersion"], 2);
        assert!(still_rollback_readable.get("profiles").is_some());

        assert!(
            !persist_connections_for_boot(&path, &connections, true, true).unwrap(),
            "healthy boot should promote the pending migration"
        );
        let promoted: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(promoted["schemaVersion"], 3);
        assert!(promoted.get("connections").is_some());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cloud_profile_requires_complete_identity_and_never_serializes_credentials() {
        let profile = DesktopConnectionProfile::cloud(
            "Owner workspace".into(),
            "user_owner".into(),
            "workspace_hosted".into(),
            "workspace_portable".into(),
        );
        let mut connections = DesktopConnections::default();
        connections.activate(profile);
        let value = serde_json::to_value(connections.validate().unwrap()).unwrap();
        assert_eq!(value["schemaVersion"], 3);
        assert_eq!(value["activeConnectionId"], "cloud:user_owner");
        assert_eq!(value["connections"][0]["provider"], "cloud");
        assert_eq!(value["connections"][0]["workosUserId"], "user_owner");
        assert!(value.to_string().find("refreshToken").is_none());
        assert!(value.to_string().find("accessToken").is_none());
        assert!(value.to_string().find("wt_session").is_none());

        let mut injected = value;
        injected["connections"][0]["refreshToken"] = "must_not_be_ignored".into();
        assert!(serde_json::from_value::<DesktopConnections>(injected).is_err());
    }

    #[test]
    fn remote_profiles_require_unique_canonical_origins() {
        let first = DesktopConnectionProfile::SelfHosted {
            id: "remote-a".into(),
            display_name: "A".into(),
            origin: "https://example.com".into(),
            workspace_id: Some("ws_a".into()),
            allow_insecure_http: false,
        };
        let mut second = first.clone();
        if let DesktopConnectionProfile::SelfHosted { id, .. } = &mut second {
            *id = "remote-b".into();
        }
        assert!(DesktopConnections {
            schema_version: CONNECTIONS_SCHEMA_VERSION,
            active_profile_id: None,
            profiles: vec![first, second],
        }
        .validate()
        .unwrap_err()
        .contains("cannot share an origin"));

        let insecure_pending = DesktopConnectionProfile::SelfHosted {
            id: "legacy-http".into(),
            display_name: "Legacy HTTP".into(),
            origin: "http://localhost:17480".into(),
            workspace_id: None,
            allow_insecure_http: false,
        };
        assert!(DesktopConnections {
            schema_version: CONNECTIONS_SCHEMA_VERSION,
            active_profile_id: None,
            profiles: vec![insecure_pending],
        }
        .validate()
        .is_ok());

        let invalid_secure_consent = DesktopConnectionProfile::SelfHosted {
            id: "invalid-https".into(),
            display_name: "Invalid HTTPS".into(),
            origin: "https://example.test".into(),
            workspace_id: Some("ws_secure".into()),
            allow_insecure_http: true,
        };
        assert!(DesktopConnections {
            schema_version: CONNECTIONS_SCHEMA_VERSION,
            active_profile_id: None,
            profiles: vec![invalid_secure_consent],
        }
        .validate()
        .is_err());
    }

    #[test]
    fn corrupt_connections_are_preserved_before_reset() {
        let root = temp_dir("corrupt");
        let path = connections_path(&root);
        fs::write(&path, "{broken").unwrap();
        assert!(read_connections(&path).is_err());
        let quarantine = quarantine_connections(&path).unwrap().unwrap();
        assert!(!path.exists());
        assert_eq!(fs::read_to_string(quarantine).unwrap(), "{broken");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn parses_every_workspace_inspection_shape() {
        for body in [
            r#"{"schemaVersion":1,"ok":true,"inspection":{"outcome":"missing","path":"/tmp/a"}}"#,
            r#"{"schemaVersion":1,"ok":true,"inspection":{"outcome":"empty","path":"/tmp/a"}}"#,
            r#"{"schemaVersion":1,"ok":true,"inspection":{"outcome":"valid","path":"/tmp/a","workspace":{"id":"ws_1","name":"A","createdAt":"2024-01-01T00:00:00.000Z"}}}"#,
            r#"{"schemaVersion":1,"ok":true,"inspection":{"outcome":"reject","path":"/tmp/a","reason":"symlink","message":"No"}}"#,
        ] {
            let envelope: InspectionEnvelope = serde_json::from_str(body).unwrap();
            assert_eq!(envelope.schema_version, 1);
            assert!(envelope.ok);
            assert_eq!(envelope.inspection.path(), "/tmp/a");
        }
    }

    #[test]
    fn resolves_saved_workspace_without_adopting_a_replacement() {
        let identity = WorkspaceIdentity {
            id: "ws_expected".into(),
            name: "Expected".into(),
            created_at: "2024-01-01T00:00:00.000Z".into(),
        };
        assert!(matches!(
            resolve_saved_workspace(
                WorkspaceInspection::Valid {
                    path: "/tmp/a".into(),
                    workspace: identity.clone(),
                },
                "ws_expected"
            ),
            SavedWorkspaceResolution::Ready(WorkspacePrepared { created: false, .. })
        ));
        assert!(matches!(
            resolve_saved_workspace(
                WorkspaceInspection::Valid {
                    path: "/tmp/a".into(),
                    workspace: WorkspaceIdentity {
                        id: "ws_replacement".into(),
                        ..identity
                    },
                },
                "ws_expected"
            ),
            SavedWorkspaceResolution::IdentityMismatch(_)
        ));
        assert_eq!(
            resolve_saved_workspace(
                WorkspaceInspection::Missing {
                    path: "/tmp/a".into(),
                },
                "ws_expected"
            ),
            SavedWorkspaceResolution::Missing
        );
        assert_eq!(
            resolve_saved_workspace(
                WorkspaceInspection::Reject {
                    path: "/tmp/a".into(),
                    reason: "symlink".into(),
                    message: "No".into(),
                },
                "ws_expected"
            ),
            SavedWorkspaceResolution::Rejected("No".into())
        );
    }
}
