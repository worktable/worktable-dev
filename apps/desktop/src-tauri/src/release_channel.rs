#![cfg_attr(any(not(target_os = "macos"), feature = "staging"), allow(dead_code))]

//! The release channel Desktop follows.
//!
//! The team publishes channels.json at the release base URL, naming each
//! channel's version and whether it is held. Desktop follows stable unless the
//! person chose beta. It checks the signed updater feed of exactly the version
//! its channel offers, offers nothing while the channel is held, and confirms
//! the version is still offered before it installs. When the manifest can't be
//! read, nothing is installed.
//!
//! Beta moves with every verified change on main, but Desktop builds are made
//! less often. The beta entry names the newest beta that has a signed Desktop
//! build (`desktop`), and only that version is ever offered to Desktop. Beta
//! also follows stable, so a beta install moves on to the release its builds
//! led up to.

use semver::Version;
use serde::{Deserialize, Serialize};
use std::time::Duration;

pub const CHANNELS_URL: &str = "https://worktable.dev/releases/channels.json";
const RELEASE_BASE_URL: &str = "https://worktable.dev/releases";
/// The manifest is a few hundred bytes; anything far larger is not it.
const MAX_MANIFEST_BYTES: usize = 64 * 1024;

/// The channel this Desktop follows. Stored in the updater state.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    #[default]
    Stable,
    Beta,
}

impl UpdateChannel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Beta => "beta",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "stable" => Some(Self::Stable),
            "beta" => Some(Self::Beta),
            _ => None,
        }
    }
}

#[derive(Deserialize)]
struct Manifest {
    schema: u8,
    channels: Channels,
}

#[derive(Deserialize)]
struct Channels {
    stable: Option<ChannelEntry>,
    /// Read leniently: a missing or malformed beta entry leaves beta installs
    /// on stable, as it does for the CLI.
    #[serde(default)]
    beta: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct ChannelEntry {
    version: String,
    held: bool,
}

#[derive(Deserialize)]
struct BetaEntry {
    held: bool,
    #[serde(default)]
    desktop: Option<DesktopBuild>,
}

#[derive(Deserialize)]
struct DesktopBuild {
    version: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ChannelTarget {
    /// A newer version, with the signed updater feed that publishes it.
    /// `channel_held` is set when beta is held and this is stable's release.
    Offer {
        version: Version,
        feed_url: String,
        channel_held: bool,
    },
    /// The followed channel is held and offers nothing new.
    Held,
    /// Already on (or past) everything the channel offers.
    Current,
}

const INVALID_MANIFEST: &str = "The release channel manifest is not valid.";

fn parse_version(text: &str) -> Option<Version> {
    Version::parse(text.trim().trim_start_matches('v')).ok()
}

/// The release tag that publishes `version`: `v` plus the version without
/// build metadata (`0.1.24-dev.5+abc1234` is published as `v0.1.24-dev.5`).
pub fn release_tag(version: &Version) -> String {
    let mut tag = format!("v{}.{}.{}", version.major, version.minor, version.patch);
    if !version.pre.is_empty() {
        tag.push('-');
        tag.push_str(version.pre.as_str());
    }
    tag
}

/// Resolve what `channel` offers to `current` from a channels.json body.
pub fn channel_target(
    body: &[u8],
    current: &Version,
    channel: UpdateChannel,
) -> Result<ChannelTarget, String> {
    let manifest: Manifest =
        serde_json::from_slice(body).map_err(|_| INVALID_MANIFEST.to_string())?;
    if manifest.schema != 1 {
        return Err(INVALID_MANIFEST.into());
    }
    let stable = manifest.channels.stable.ok_or(INVALID_MANIFEST)?;
    let stable_version = parse_version(&stable.version).ok_or(INVALID_MANIFEST)?;
    let beta = match channel {
        UpdateChannel::Stable => None,
        UpdateChannel::Beta => manifest
            .channels
            .beta
            .and_then(|value| serde_json::from_value::<BetaEntry>(value).ok()),
    };

    let mut candidates = Vec::new();
    if !stable.held {
        candidates.push(stable_version);
    }
    if let Some(beta) = &beta {
        if !beta.held {
            if let Some(version) = beta
                .desktop
                .as_ref()
                .and_then(|desktop| parse_version(&desktop.version))
            {
                candidates.push(version);
            }
        }
    }
    let newest = candidates
        .into_iter()
        .max_by(|left, right| left.cmp_precedence(right));
    let followed_held = match &beta {
        Some(beta) => beta.held,
        None => stable.held,
    };
    if let Some(version) = newest.filter(|version| version.cmp_precedence(current).is_gt()) {
        return Ok(ChannelTarget::Offer {
            feed_url: format!(
                "{RELEASE_BASE_URL}/{}/desktop-updater.json",
                release_tag(&version)
            ),
            version,
            channel_held: followed_held,
        });
    }
    Ok(if followed_held {
        ChannelTarget::Held
    } else {
        ChannelTarget::Current
    })
}

/// Whether a downloaded `prepared` version may still be installed, given what
/// the channel offers now. Stable installs exactly what it offers. An unheld
/// beta also installs a build it has since moved past, because beta moves on
/// often and only a hold withdraws a build; while beta is held, only the
/// stable release it still offers installs.
pub fn may_install(target: &ChannelTarget, prepared: &Version, channel: UpdateChannel) -> bool {
    match target {
        ChannelTarget::Offer {
            version,
            channel_held,
            ..
        } => match channel {
            UpdateChannel::Beta if !channel_held => version.cmp_precedence(prepared).is_ge(),
            _ => version.cmp_precedence(prepared).is_eq(),
        },
        ChannelTarget::Held | ChannelTarget::Current => false,
    }
}

/// Fetch channels.json and resolve the target for `channel`. Any failure is
/// an error, which callers treat as "install nothing".
pub async fn fetch_channel_target(
    current: &Version,
    channel: UpdateChannel,
    timeout: Duration,
) -> Result<ChannelTarget, String> {
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|error| format!("could not prepare the release check: {error}"))?;
    let mut response = client
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
    // Read at most MAX_MANIFEST_BYTES, whatever the server sends.
    if response
        .content_length()
        .is_some_and(|length| length > MAX_MANIFEST_BYTES as u64)
    {
        return Err(INVALID_MANIFEST.into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("could not read the release channel manifest: {error}"))?
    {
        if body.len() + chunk.len() > MAX_MANIFEST_BYTES {
            return Err(INVALID_MANIFEST.into());
        }
        body.extend_from_slice(&chunk);
    }
    channel_target(&body, current, channel)
}

/// Whether `version` may still be installed from `channel`. False when the
/// channel is held, no longer offers it, or the manifest can't be read.
pub async fn still_offered(
    current: &Version,
    version: &str,
    channel: UpdateChannel,
    timeout: Duration,
) -> bool {
    let Ok(prepared) = Version::parse(version) else {
        return false;
    };
    match fetch_channel_target(current, channel, timeout).await {
        Ok(target) => may_install(&target, &prepared, channel),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn version(text: &str) -> Version {
        Version::parse(text).unwrap()
    }

    fn offer(text: &str) -> ChannelTarget {
        let version = version(text);
        ChannelTarget::Offer {
            feed_url: format!(
                "https://worktable.dev/releases/{}/desktop-updater.json",
                release_tag(&version)
            ),
            version,
            channel_held: false,
        }
    }

    fn held_offer(text: &str) -> ChannelTarget {
        match offer(text) {
            ChannelTarget::Offer {
                version, feed_url, ..
            } => ChannelTarget::Offer {
                version,
                feed_url,
                channel_held: true,
            },
            other => other,
        }
    }

    const BOTH: &[u8] = br#"{"schema":1,"channels":{
        "stable":{"version":"0.1.23","tag":"v0.1.23","held":false},
        "beta":{"version":"0.1.24-dev.9+fedcba9","held":false,
                "desktop":{"version":"0.1.24-dev.5+abc1234","tag":"v0.1.24-dev.5"}}}}"#;

    #[test]
    fn stable_offers_the_exact_versioned_feed_of_a_newer_release() {
        let body = br#"{"schema":1,"channels":{"stable":{"version":"0.1.24","tag":"v0.1.24","held":false},"beta":{"version":"0.1.25-dev.3+abc1234","held":false,"desktop":{"version":"0.1.25-dev.3+abc1234"}}}}"#;
        let target = channel_target(body, &version("0.1.23"), UpdateChannel::Stable).unwrap();
        assert_eq!(target, offer("0.1.24"));
        assert_eq!(
            target,
            ChannelTarget::Offer {
                version: version("0.1.24"),
                feed_url: "https://worktable.dev/releases/v0.1.24/desktop-updater.json".into(),
                channel_held: false,
            }
        );
    }

    #[test]
    fn beta_offers_only_the_newest_beta_with_a_desktop_build() {
        // Beta has moved to dev.9, but only dev.5 has a Desktop build.
        let target = channel_target(BOTH, &version("0.1.23"), UpdateChannel::Beta).unwrap();
        assert_eq!(
            target,
            ChannelTarget::Offer {
                version: version("0.1.24-dev.5+abc1234"),
                feed_url: "https://worktable.dev/releases/v0.1.24-dev.5/desktop-updater.json"
                    .into(),
                channel_held: false,
            }
        );
        // Stable never sees it.
        assert_eq!(
            channel_target(BOTH, &version("0.1.23"), UpdateChannel::Stable).unwrap(),
            ChannelTarget::Current
        );
        // Without any Desktop build, beta waits on stable.
        let no_desktop = br#"{"schema":1,"channels":{"stable":{"version":"0.1.23","held":false},"beta":{"version":"0.1.24-dev.9+fedcba9","held":false}}}"#;
        assert_eq!(
            channel_target(no_desktop, &version("0.1.23"), UpdateChannel::Beta).unwrap(),
            ChannelTarget::Current
        );
        // Already on that build.
        assert_eq!(
            channel_target(BOTH, &version("0.1.24-dev.5+abc1234"), UpdateChannel::Beta).unwrap(),
            ChannelTarget::Current
        );
    }

    #[test]
    fn beta_moves_on_to_the_release_its_builds_led_up_to() {
        let released = br#"{"schema":1,"channels":{"stable":{"version":"0.1.24","held":false},"beta":{"version":"0.1.24-dev.9+fedcba9","held":false,"desktop":{"version":"0.1.24-dev.9+fedcba9"}}}}"#;
        assert_eq!(
            channel_target(
                released,
                &version("0.1.24-dev.9+fedcba9"),
                UpdateChannel::Beta
            )
            .unwrap(),
            offer("0.1.24")
        );
        // A beta build is newer than the stable release it leads up from.
        let older = br#"{"schema":1,"channels":{"stable":{"version":"0.1.23","held":false}}}"#;
        assert_eq!(
            channel_target(
                older,
                &version("0.1.24-dev.5+abc1234"),
                UpdateChannel::Stable
            )
            .unwrap(),
            ChannelTarget::Current
        );
    }

    #[test]
    fn a_held_channel_offers_nothing_from_that_channel() {
        let stable_held = br#"{"schema":1,"channels":{"stable":{"version":"0.1.24","held":true}}}"#;
        assert_eq!(
            channel_target(stable_held, &version("0.1.23"), UpdateChannel::Stable).unwrap(),
            ChannelTarget::Held
        );
        let beta_held = br#"{"schema":1,"channels":{"stable":{"version":"0.1.23","held":false},"beta":{"version":"0.1.24-dev.9+fedcba9","held":true,"desktop":{"version":"0.1.24-dev.5+abc1234"}}}}"#;
        assert_eq!(
            channel_target(beta_held, &version("0.1.23"), UpdateChannel::Beta).unwrap(),
            ChannelTarget::Held
        );
        // A held beta still lets a newer, unheld stable release through.
        let beta_held_stable_newer = br#"{"schema":1,"channels":{"stable":{"version":"0.1.24","held":false},"beta":{"version":"0.1.24-dev.9+fedcba9","held":true,"desktop":{"version":"0.1.24-dev.9+fedcba9"}}}}"#;
        assert_eq!(
            channel_target(
                beta_held_stable_newer,
                &version("0.1.23"),
                UpdateChannel::Beta
            )
            .unwrap(),
            held_offer("0.1.24")
        );
        // A held stable doesn't stop beta's own Desktop build.
        let stable_held_beta = br#"{"schema":1,"channels":{"stable":{"version":"0.1.24","held":true},"beta":{"version":"0.1.25-dev.2+abc1234","held":false,"desktop":{"version":"0.1.25-dev.2+abc1234"}}}}"#;
        assert_eq!(
            channel_target(stable_held_beta, &version("0.1.23"), UpdateChannel::Beta).unwrap(),
            offer("0.1.25-dev.2+abc1234")
        );
    }

    #[test]
    fn rejects_a_manifest_that_does_not_say_whether_stable_is_held() {
        for channel in [UpdateChannel::Stable, UpdateChannel::Beta] {
            for body in [
                &br#"{"schema":1,"channels":{"stable":{"version":"0.1.24"}}}"#[..],
                br#"{"schema":2,"channels":{"stable":{"version":"0.1.24","held":false}}}"#,
                br#"{"schema":1,"channels":{}}"#,
                br#"{"schema":1,"channels":{"beta":{"version":"0.1.24-dev.1+abc1234","held":false,"desktop":{"version":"0.1.24-dev.1+abc1234"}}}}"#,
                br#"{"schema":1,"channels":{"stable":{"version":"latest","held":false}}}"#,
                b"not json",
            ] {
                assert!(channel_target(body, &version("0.1.23"), channel).is_err());
            }
        }
    }

    #[test]
    fn a_malformed_beta_entry_leaves_beta_on_stable() {
        for beta in [
            r#""nonsense""#,
            r#"{"version":"0.1.24-dev.9+fedcba9"}"#,
            r#"{"version":"0.1.24-dev.9+fedcba9","held":false,"desktop":{"version":"latest"}}"#,
        ] {
            let body = format!(
                r#"{{"schema":1,"channels":{{"stable":{{"version":"0.1.24","held":false}},"beta":{beta}}}}}"#
            );
            assert_eq!(
                channel_target(body.as_bytes(), &version("0.1.23"), UpdateChannel::Beta).unwrap(),
                offer("0.1.24"),
                "{beta}"
            );
        }
    }

    #[test]
    fn installs_only_what_the_channel_still_offers() {
        let prepared = version("0.1.24-dev.5+abc1234");
        // Beta installs its build while offered, and after beta moves past it.
        assert!(may_install(
            &offer("0.1.24-dev.5+abc1234"),
            &prepared,
            UpdateChannel::Beta
        ));
        assert!(may_install(
            &offer("0.1.24-dev.8+0123abc"),
            &prepared,
            UpdateChannel::Beta
        ));
        // Not a build the channel moved back from, nor anything while held.
        assert!(!may_install(
            &offer("0.1.24-dev.3+0123abc"),
            &prepared,
            UpdateChannel::Beta
        ));
        // A held beta that still lets stable through doesn't let its own
        // downloaded build through with it.
        assert!(!may_install(
            &held_offer("0.1.24"),
            &prepared,
            UpdateChannel::Beta
        ));
        assert!(may_install(
            &held_offer("0.1.24"),
            &version("0.1.24"),
            UpdateChannel::Beta
        ));
        assert!(!may_install(
            &ChannelTarget::Held,
            &prepared,
            UpdateChannel::Beta
        ));
        assert!(!may_install(
            &ChannelTarget::Current,
            &prepared,
            UpdateChannel::Beta
        ));
        // Stable installs exactly the offered release.
        let release = version("0.1.24");
        assert!(may_install(
            &offer("0.1.24"),
            &release,
            UpdateChannel::Stable
        ));
        assert!(!may_install(
            &offer("0.1.25"),
            &release,
            UpdateChannel::Stable
        ));
        assert!(!may_install(
            &ChannelTarget::Held,
            &release,
            UpdateChannel::Stable
        ));
    }
}
