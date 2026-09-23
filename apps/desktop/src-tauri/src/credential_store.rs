use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[cfg(feature = "staging")]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const WORKTABLE_KEYCHAIN_SERVICE: &str = "dev.worktable.desktop.staging.workos";
#[cfg(not(feature = "staging"))]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const WORKTABLE_KEYCHAIN_SERVICE: &str = "dev.worktable.desktop.workos";

const STORED_CREDENTIAL_VERSION: u8 = 1;
pub(crate) const MAX_REFRESH_TOKEN_BYTES: usize = 6_144;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredCredential {
    version: u8,
    refresh_token: String,
    workos_user_id: String,
    session_id: String,
    rotated_at: String,
}

impl StoredCredential {
    pub fn new(
        refresh_token: String,
        workos_user_id: String,
        session_id: String,
        rotated_at: String,
    ) -> Result<Self, String> {
        if session_id.trim().is_empty() {
            return Err("the stored Desktop credential is invalid".into());
        }
        let credential = Self {
            version: STORED_CREDENTIAL_VERSION,
            refresh_token,
            workos_user_id,
            session_id,
            rotated_at,
        };
        credential.validate()?;
        Ok(credential)
    }

    pub fn continuation(
        refresh_token: String,
        workos_user_id: String,
        rotated_at: String,
    ) -> Result<Self, String> {
        let credential = Self {
            version: STORED_CREDENTIAL_VERSION,
            refresh_token,
            workos_user_id,
            // WorkOS does not expose a trustworthy session id until the
            // continuation has produced a verifiable access token.
            session_id: String::new(),
            rotated_at,
        };
        credential.validate()?;
        Ok(credential)
    }

    pub fn refresh_token(&self) -> &str {
        &self.refresh_token
    }

    pub fn workos_user_id(&self) -> &str {
        &self.workos_user_id
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn is_continuation(&self) -> bool {
        self.session_id.is_empty()
    }

    fn validate(&self) -> Result<(), String> {
        if self.version != STORED_CREDENTIAL_VERSION
            || self.refresh_token.is_empty()
            || self.refresh_token.len() > MAX_REFRESH_TOKEN_BYTES
            || self.workos_user_id.trim().is_empty()
            || self.workos_user_id.len() > 512
            || self.session_id.len() > 512
            || self.rotated_at.trim().is_empty()
        {
            return Err("the stored Desktop credential is invalid".into());
        }
        Ok(())
    }
}

pub trait CredentialStore: Send + Sync {
    fn load(&self, origin: &str, workos_user_id: &str) -> Result<Option<StoredCredential>, String>;
    fn load_only(&self, origin: &str) -> Result<Option<StoredCredential>, String>;
    fn store(&self, origin: &str, credential: &StoredCredential) -> Result<(), String>;
    fn remove(&self, origin: &str, workos_user_id: &str) -> Result<(), String>;
    fn remove_all(&self, origin: &str) -> Result<(), String>;
}

#[cfg_attr(not(any(test, target_os = "macos")), allow(dead_code))]
fn credential_account(origin: &str, workos_user_id: &str) -> Result<String, String> {
    if origin.trim().is_empty()
        || origin.contains('|')
        || workos_user_id.trim().is_empty()
        || workos_user_id.contains('|')
    {
        return Err("Desktop credential identity is invalid".into());
    }
    Ok(format!("{origin}|{workos_user_id}"))
}

#[cfg(target_os = "macos")]
struct MacOsKeychainCredentialStore;

#[cfg(target_os = "macos")]
impl MacOsKeychainCredentialStore {
    fn accounts_for_origin(&self, origin: &str) -> Result<Vec<String>, String> {
        use security_framework::item::{ItemClass, ItemSearchOptions, Limit};

        if origin.trim().is_empty() || origin.contains('|') {
            return Err("Desktop credential origin is invalid".into());
        }
        let prefix = format!("{origin}|");
        let mut search = ItemSearchOptions::new();
        let results = match search
            .class(ItemClass::generic_password())
            .service(WORKTABLE_KEYCHAIN_SERVICE)
            .load_attributes(true)
            .limit(Limit::All)
            .search()
        {
            Ok(results) => results,
            Err(error) if error.code() == -25_300 => return Ok(Vec::new()),
            Err(_) => {
                return Err(
                    "macOS Keychain could not discover the Worktable Cloud credential".into(),
                )
            }
        };
        let mut accounts = Vec::new();
        for result in results {
            let attributes = result.simplify_dict().ok_or_else(|| {
                "macOS Keychain returned unreadable Worktable Cloud credential metadata".to_string()
            })?;
            if let Some(account) = attributes.values().find(|value| value.starts_with(&prefix)) {
                accounts.push(account.clone());
            }
        }
        accounts.sort();
        accounts.dedup();
        Ok(accounts)
    }
}

#[cfg(target_os = "macos")]
impl CredentialStore for MacOsKeychainCredentialStore {
    fn load(&self, origin: &str, workos_user_id: &str) -> Result<Option<StoredCredential>, String> {
        use security_framework::passwords::get_generic_password;

        // Apple documents errSecItemNotFound as -25300.
        const ERR_SEC_ITEM_NOT_FOUND: i32 = -25_300;
        let account = credential_account(origin, workos_user_id)?;
        let bytes = match get_generic_password(WORKTABLE_KEYCHAIN_SERVICE, &account) {
            Ok(bytes) => bytes,
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => return Ok(None),
            Err(_) => {
                return Err("macOS Keychain could not read the Worktable Cloud credential".into())
            }
        };
        let credential = serde_json::from_slice::<StoredCredential>(&bytes).map_err(|_| {
            "the Worktable Cloud credential in macOS Keychain is unreadable".to_string()
        })?;
        credential.validate()?;
        if credential.workos_user_id() != workos_user_id {
            return Err("the Worktable Cloud credential identity does not match".into());
        }
        Ok(Some(credential))
    }

    fn load_only(&self, origin: &str) -> Result<Option<StoredCredential>, String> {
        use security_framework::passwords::get_generic_password;

        let mut accounts = self.accounts_for_origin(origin)?;
        if accounts.len() > 1 {
            return Err("macOS Keychain contains more than one Worktable Cloud credential".into());
        }
        let Some(account) = accounts.pop() else {
            return Ok(None);
        };
        let bytes = get_generic_password(WORKTABLE_KEYCHAIN_SERVICE, &account)
            .map_err(|_| "macOS Keychain could not read the Worktable Cloud credential")?;
        let credential = serde_json::from_slice::<StoredCredential>(&bytes).map_err(|_| {
            "the Worktable Cloud credential in macOS Keychain is unreadable".to_string()
        })?;
        credential.validate()?;
        if credential_account(origin, credential.workos_user_id())? != account {
            return Err("the Worktable Cloud credential identity does not match".into());
        }
        Ok(Some(credential))
    }

    fn store(&self, origin: &str, credential: &StoredCredential) -> Result<(), String> {
        use security_framework::passwords::set_generic_password;

        credential.validate()?;
        let account = credential_account(origin, credential.workos_user_id())?;
        let bytes = serde_json::to_vec(credential)
            .map_err(|_| "could not encode the Worktable Cloud credential".to_string())?;
        set_generic_password(WORKTABLE_KEYCHAIN_SERVICE, &account, &bytes)
            .map_err(|_| "macOS Keychain could not save the Worktable Cloud credential".into())
    }

    fn remove(&self, origin: &str, workos_user_id: &str) -> Result<(), String> {
        use security_framework::passwords::delete_generic_password;

        const ERR_SEC_ITEM_NOT_FOUND: i32 = -25_300;
        let account = credential_account(origin, workos_user_id)?;
        match delete_generic_password(WORKTABLE_KEYCHAIN_SERVICE, &account) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
            Err(_) => Err("macOS Keychain could not remove the Worktable Cloud credential".into()),
        }
    }

    fn remove_all(&self, origin: &str) -> Result<(), String> {
        use security_framework::passwords::delete_generic_password;

        const ERR_SEC_ITEM_NOT_FOUND: i32 = -25_300;
        for account in self.accounts_for_origin(origin)? {
            match delete_generic_password(WORKTABLE_KEYCHAIN_SERVICE, &account) {
                Ok(()) => {}
                Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => {}
                Err(_) => {
                    return Err(
                        "macOS Keychain could not remove the Worktable Cloud credential".into(),
                    )
                }
            }
        }
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
struct UnsupportedCredentialStore;

#[cfg(not(target_os = "macos"))]
impl CredentialStore for UnsupportedCredentialStore {
    fn load(
        &self,
        _origin: &str,
        _workos_user_id: &str,
    ) -> Result<Option<StoredCredential>, String> {
        Err("Worktable Cloud credentials require macOS Keychain".into())
    }

    fn load_only(&self, _origin: &str) -> Result<Option<StoredCredential>, String> {
        Ok(None)
    }

    fn store(&self, _origin: &str, _credential: &StoredCredential) -> Result<(), String> {
        Err("Worktable Cloud credentials require macOS Keychain".into())
    }

    fn remove(&self, _origin: &str, _workos_user_id: &str) -> Result<(), String> {
        Err("Worktable Cloud credentials require macOS Keychain".into())
    }

    fn remove_all(&self, _origin: &str) -> Result<(), String> {
        Err("Worktable Cloud credentials require macOS Keychain".into())
    }
}

pub fn system_credential_store() -> Arc<dyn CredentialStore> {
    #[cfg(target_os = "macos")]
    {
        Arc::new(MacOsKeychainCredentialStore)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Arc::new(UnsupportedCredentialStore)
    }
}

#[cfg(test)]
pub struct MemoryCredentialStore {
    value: std::sync::Mutex<Option<(String, String, Vec<u8>)>>,
    fail_writes: bool,
    fail_removals: bool,
}

#[cfg(test)]
impl MemoryCredentialStore {
    pub fn new(fail_writes: bool) -> Self {
        Self {
            value: std::sync::Mutex::new(None),
            fail_writes,
            fail_removals: false,
        }
    }

    pub fn with_failures(fail_writes: bool, fail_removals: bool) -> Self {
        Self {
            value: std::sync::Mutex::new(None),
            fail_writes,
            fail_removals,
        }
    }
}

#[cfg(test)]
impl CredentialStore for MemoryCredentialStore {
    fn load(&self, origin: &str, workos_user_id: &str) -> Result<Option<StoredCredential>, String> {
        let account = credential_account(origin, workos_user_id)?;
        let guard = self
            .value
            .lock()
            .map_err(|_| "memory credential store is poisoned".to_string())?;
        let Some((service, stored_account, bytes)) = guard.as_ref() else {
            return Ok(None);
        };
        if service != WORKTABLE_KEYCHAIN_SERVICE || stored_account != &account {
            return Ok(None);
        }
        let value = serde_json::from_slice::<StoredCredential>(bytes)
            .map_err(|_| "memory credential is invalid".to_string())?;
        value.validate()?;
        Ok(Some(value))
    }

    fn load_only(&self, origin: &str) -> Result<Option<StoredCredential>, String> {
        let guard = self
            .value
            .lock()
            .map_err(|_| "memory credential store is poisoned".to_string())?;
        let Some((service, account, bytes)) = guard.as_ref() else {
            return Ok(None);
        };
        if service != WORKTABLE_KEYCHAIN_SERVICE || !account.starts_with(&format!("{origin}|")) {
            return Ok(None);
        }
        let value = serde_json::from_slice::<StoredCredential>(bytes)
            .map_err(|_| "memory credential is invalid".to_string())?;
        value.validate()?;
        Ok(Some(value))
    }

    fn store(&self, origin: &str, credential: &StoredCredential) -> Result<(), String> {
        if self.fail_writes {
            return Err("injected Keychain write failure".into());
        }
        let account = credential_account(origin, credential.workos_user_id())?;
        let bytes = serde_json::to_vec(credential)
            .map_err(|_| "could not encode memory credential".to_string())?;
        self.value
            .lock()
            .map_err(|_| "memory credential store is poisoned".to_string())?
            .replace((WORKTABLE_KEYCHAIN_SERVICE.into(), account, bytes));
        Ok(())
    }

    fn remove(&self, origin: &str, workos_user_id: &str) -> Result<(), String> {
        if self.fail_removals {
            return Err("injected Keychain removal failure".into());
        }
        let account = credential_account(origin, workos_user_id)?;
        let mut guard = self
            .value
            .lock()
            .map_err(|_| "memory credential store is poisoned".to_string())?;
        if guard.as_ref().is_some_and(|(service, stored_account, _)| {
            service == WORKTABLE_KEYCHAIN_SERVICE && stored_account == &account
        }) {
            guard.take();
        }
        Ok(())
    }

    fn remove_all(&self, origin: &str) -> Result<(), String> {
        if self.fail_removals {
            return Err("injected Keychain removal failure".into());
        }
        let prefix = format!("{origin}|");
        let mut guard = self
            .value
            .lock()
            .map_err(|_| "memory credential store is poisoned".to_string())?;
        if guard.as_ref().is_some_and(|(service, account, _)| {
            service == WORKTABLE_KEYCHAIN_SERVICE && account.starts_with(&prefix)
        }) {
            guard.take();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn credential() -> StoredCredential {
        StoredCredential::new(
            "refresh_secret".into(),
            "user_owner".into(),
            "session_owner".into(),
            "2026-07-29T20:00:00Z".into(),
        )
        .unwrap()
    }

    #[test]
    fn credential_accounts_isolate_origins_and_users_without_ambiguous_keys() {
        let production = credential_account("https://app.worktable.cloud", "user_owner").unwrap();
        let staging =
            credential_account("https://staging.app.worktable.cloud", "user_owner").unwrap();
        let other_user = credential_account("https://app.worktable.cloud", "user_other").unwrap();
        assert_ne!(production, staging);
        assert_ne!(production, other_user);
        // The Keychain discovery path uses this persisted origin delimiter.
        assert!(production.starts_with("https://app.worktable.cloud|"));
        for (origin, user) in [
            ("", "user"),
            ("origin", " "),
            ("origin|other", "user"),
            ("origin", "user|other"),
        ] {
            assert!(credential_account(origin, user).is_err());
        }
    }

    #[test]
    fn serialized_credential_contains_only_the_versioned_keychain_contract() {
        let value = serde_json::to_value(credential()).unwrap();
        assert_eq!(
            value
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect::<Vec<_>>(),
            [
                "refreshToken",
                "rotatedAt",
                "sessionId",
                "version",
                "workosUserId"
            ]
        );
    }

    #[test]
    fn only_an_explicit_continuation_may_omit_the_verified_session_id() {
        assert!(StoredCredential::new(
            "refresh_secret".into(),
            "user_owner".into(),
            String::new(),
            "2026-07-29T20:00:00Z".into(),
        )
        .is_err());
        assert!(StoredCredential::continuation(
            "refresh_secret".into(),
            "user_owner".into(),
            "2026-07-29T20:00:00Z".into(),
        )
        .is_ok());
    }

    #[test]
    fn refresh_token_storage_matches_the_desktop_gateway_limit() {
        assert!(StoredCredential::new(
            "r".repeat(MAX_REFRESH_TOKEN_BYTES),
            "user_owner".into(),
            "session_owner".into(),
            "2026-07-29T20:00:00Z".into(),
        )
        .is_ok());
        assert!(StoredCredential::new(
            "r".repeat(MAX_REFRESH_TOKEN_BYTES + 1),
            "user_owner".into(),
            "session_owner".into(),
            "2026-07-29T20:00:00Z".into(),
        )
        .is_err());
    }
}
