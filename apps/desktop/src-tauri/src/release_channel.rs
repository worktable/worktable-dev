#![cfg_attr(any(not(target_os = "macos"), feature = "staging"), allow(dead_code))]

//! The release channel Desktop follows.
//!
//! The team publishes channels.json at the release base URL, naming each
//! channel's version and whether it is held. Desktop follows stable: it checks
//! the signed updater feed of exactly that version, offers nothing while the
//! channel is held, and confirms the version is still offered before it
//! installs. When the manifest can't be read, nothing is installed.

use semver::Version;
use serde::Deserialize;
use std::time::Duration;

pub const CHANNELS_URL: &str = "https://worktable.dev/releases/channels.json";
const RELEASE_BASE_URL: &str = "https://worktable.dev/releases";
/// The manifest is a few hundred bytes; anything far larger is not it.
const MAX_MANIFEST_BYTES: usize = 64 * 1024;

#[derive(Deserialize)]
struct Manifest {
    schema: u8,
    channels: Channels,
}

#[derive(Deserialize)]
struct Channels {
    stable: Option<ChannelEntry>,
}

#[derive(Deserialize)]
struct ChannelEntry {
    version: String,
    held: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StableTarget {
    /// A newer stable version, with the signed updater feed that publishes it.
    Offer { version: Version, feed_url: String },
    /// Stable is held: nothing new is offered.
    Held,
    /// Already on (or past) the stable version.
    Current,
}

const INVALID_MANIFEST: &str = "The release channel manifest is not valid.";

/// Resolve what stable offers to `current` from a channels.json body.
pub fn stable_target(body: &[u8], current: &Version) -> Result<StableTarget, String> {
    let manifest: Manifest =
        serde_json::from_slice(body).map_err(|_| INVALID_MANIFEST.to_string())?;
    if manifest.schema != 1 {
        return Err(INVALID_MANIFEST.into());
    }
    let stable = manifest.channels.stable.ok_or(INVALID_MANIFEST)?;
    let version = Version::parse(stable.version.trim().trim_start_matches('v'))
        .map_err(|_| INVALID_MANIFEST.to_string())?;
    if stable.held {
        return Ok(StableTarget::Held);
    }
    if version.cmp_precedence(current).is_le() {
        return Ok(StableTarget::Current);
    }
    // Release tags carry the version without build metadata.
    let mut tag = format!("v{}.{}.{}", version.major, version.minor, version.patch);
    if !version.pre.is_empty() {
        tag.push('-');
        tag.push_str(version.pre.as_str());
    }
    Ok(StableTarget::Offer {
        feed_url: format!("{RELEASE_BASE_URL}/{tag}/desktop-updater.json"),
        version,
    })
}

/// Fetch channels.json and resolve the stable target. Any failure is an
/// error, which callers treat as "install nothing".
pub async fn fetch_stable_target(
    current: &Version,
    timeout: Duration,
) -> Result<StableTarget, String> {
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|error| format!("could not prepare the release check: {error}"))?;
    let response = client
        .get(CHANNELS_URL)
        .send()
        .await
        .map_err(|error| format!("could not reach the release channel manifest: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "the release channel manifest answered {}",
            response.status()
        ));
    }
    let body = response
        .bytes()
        .await
        .map_err(|error| format!("could not read the release channel manifest: {error}"))?;
    if body.len() > MAX_MANIFEST_BYTES {
        return Err(INVALID_MANIFEST.into());
    }
    stable_target(&body, current)
}

/// Whether `version` is still what stable offers. False when stable is held,
/// has moved to another version, or the manifest can't be read.
pub async fn still_offered(current: &Version, version: &str, timeout: Duration) -> bool {
    let Ok(wanted) = Version::parse(version) else {
        return false;
    };
    matches!(
        fetch_stable_target(current, timeout).await,
        Ok(StableTarget::Offer { version, .. }) if version.cmp_precedence(&wanted).is_eq()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn current() -> Version {
        Version::parse("0.1.23").unwrap()
    }

    #[test]
    fn offers_the_exact_versioned_feed_of_a_newer_stable_release() {
        let body = br#"{"schema":1,"channels":{"stable":{"version":"0.1.24","tag":"v0.1.24","held":false},"beta":{"version":"0.1.25-dev.3+abc1234","held":false}}}"#;
        assert_eq!(
            stable_target(body, &current()).unwrap(),
            StableTarget::Offer {
                version: Version::parse("0.1.24").unwrap(),
                feed_url: "https://worktable.dev/releases/v0.1.24/desktop-updater.json".into(),
            }
        );
    }

    #[test]
    fn a_held_or_current_channel_offers_nothing() {
        let held = br#"{"schema":1,"channels":{"stable":{"version":"0.1.24","held":true}}}"#;
        assert_eq!(stable_target(held, &current()).unwrap(), StableTarget::Held);
        let same = br#"{"schema":1,"channels":{"stable":{"version":"0.1.23","held":false}}}"#;
        assert_eq!(
            stable_target(same, &current()).unwrap(),
            StableTarget::Current
        );
        // A beta Desktop build is newer than stable's release it leads up from.
        let beta = Version::parse("0.1.24-dev.5+abc1234").unwrap();
        let older = br#"{"schema":1,"channels":{"stable":{"version":"0.1.23","held":false}}}"#;
        assert_eq!(stable_target(older, &beta).unwrap(), StableTarget::Current);
    }

    #[test]
    fn rejects_a_manifest_that_does_not_say_whether_stable_is_held() {
        for body in [
            &br#"{"schema":1,"channels":{"stable":{"version":"0.1.24"}}}"#[..],
            br#"{"schema":2,"channels":{"stable":{"version":"0.1.24","held":false}}}"#,
            br#"{"schema":1,"channels":{}}"#,
            br#"{"schema":1,"channels":{"stable":{"version":"latest","held":false}}}"#,
            b"not json",
        ] {
            assert!(stable_target(body, &current()).is_err());
        }
    }
}
