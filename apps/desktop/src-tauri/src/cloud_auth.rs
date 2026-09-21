use crate::{
    credential_store::{CredentialStore, StoredCredential, MAX_REFRESH_TOKEN_BYTES},
    updater::now_rfc3339,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use cookie::time::Duration as CookieDuration;
use reqwest::{
    header::{AUTHORIZATION, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE, RETRY_AFTER, SET_COOKIE},
    redirect::Policy,
    Client, Response, StatusCode,
};
use semver::Version;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    future::Future,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{webview::Cookie, AppHandle};
use tauri_plugin_opener::OpenerExt;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{watch, Mutex as AsyncMutex},
};
use url::Url;

#[cfg(feature = "staging")]
pub const WORKTABLE_CLOUD_ORIGIN: &str = env!("WORKTABLE_DESKTOP_STAGING_ORIGIN");
#[cfg(not(feature = "staging"))]
pub const WORKTABLE_CLOUD_ORIGIN: &str = "https://app.worktable.cloud";

#[cfg(feature = "staging")]
pub const WORKTABLE_CLOUD_ENVIRONMENT: &str = "staging";
#[cfg(not(feature = "staging"))]
pub const WORKTABLE_CLOUD_ENVIRONMENT: &str = "production";

pub const DESKTOP_SESSION_PROTOCOL_VERSION: u8 = 1;
pub const DESKTOP_CALLBACK_PATTERN: &str = "http://127.0.0.1:*/worktable/callback";

const LOOPBACK_CALLBACK_PATH: &str = "/worktable/callback";
const AUTHORIZATION_TIMEOUT: Duration = Duration::from_secs(10 * 60);
// The gateway stamps its deadline with its own clock. Validation permits a
// bounded difference; the callback wait remains capped locally at ten minutes.
const AUTHORIZATION_CLOCK_SKEW: Duration = Duration::from_secs(30);
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_CALLBACK_REQUEST_BYTES: usize = 8 * 1024;
const MAX_OAUTH_ERROR_BYTES: usize = 256;
const ACCESS_REFRESH_MARGIN_SECONDS: i64 = 90;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudDesktopConfig {
    #[serde(rename = "type")]
    document_type: String,
    version: u8,
    environment: String,
    public_base_url: String,
    issuer: String,
    auth: CloudDesktopAuthConfig,
    minimum_desktop_version: String,
    session_protocol_version: u8,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct CloudDesktopAuthConfig {
    mode: String,
    client_id: String,
    redirect_uri_pattern: String,
}

impl CloudDesktopConfig {
    pub fn client_id(&self) -> &str {
        &self.auth.client_id
    }

    fn validate(self, desktop_version: &str) -> Result<Self, CloudAuthError> {
        let public_base_url = Url::parse(&self.public_base_url)
            .map_err(|_| CloudAuthError::configuration("Cloud origin is invalid"))?;
        let issuer = Url::parse(&self.issuer)
            .map_err(|_| CloudAuthError::configuration("Cloud issuer is invalid"))?;
        let issuer_host = issuer.host_str().unwrap_or_default();
        let issuer_is_staging = issuer_host.contains("-staging");
        let desktop_version = Version::parse(desktop_version)
            .map_err(|_| CloudAuthError::configuration("Desktop version is invalid"))?;
        let minimum_version = Version::parse(&self.minimum_desktop_version)
            .map_err(|_| CloudAuthError::configuration("Cloud minimum version is invalid"))?;
        if self.document_type != "worktable.desktop-cloud-config"
            || self.version != 1
            || self.environment != WORKTABLE_CLOUD_ENVIRONMENT
            || self.public_base_url != WORKTABLE_CLOUD_ORIGIN
            || public_base_url.as_str().trim_end_matches('/') != WORKTABLE_CLOUD_ORIGIN
            || public_base_url.scheme() != "https"
            || public_base_url.path() != "/"
            || public_base_url.query().is_some()
            || public_base_url.fragment().is_some()
            || issuer.scheme() != "https"
            || !issuer_host.ends_with(".authkit.app")
            || issuer.path() != "/"
            || issuer.query().is_some()
            || issuer.fragment().is_some()
            || issuer.username() != ""
            || issuer.password().is_some()
            || issuer.port().is_some()
            || issuer_is_staging != cfg!(feature = "staging")
            || self.auth.mode != "authkit-pkce-loopback"
            || self.auth.client_id.trim().is_empty()
            || self.auth.client_id.len() > 512
            || self.auth.redirect_uri_pattern != DESKTOP_CALLBACK_PATTERN
            || self.session_protocol_version != DESKTOP_SESSION_PROTOCOL_VERSION
        {
            return Err(CloudAuthError::configuration(
                "Cloud configuration does not match this Desktop build",
            ));
        }
        if desktop_version < minimum_version {
            return Err(CloudAuthError::new(
                "DESKTOP_UPGRADE_REQUIRED",
                format!(
                    "Update Worktable Desktop to {} before connecting to Cloud.",
                    self.minimum_desktop_version
                ),
                false,
                false,
            ));
        }
        Ok(self)
    }
}

#[derive(Clone)]
pub struct CloudUser {
    pub id: String,
}

struct CloudAccessSession {
    access_token: String,
    access_token_expires_at: OffsetDateTime,
    session_id: String,
    user: CloudUser,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    access_token_expires_at: String,
    session_id: String,
    user: TokenUser,
}

#[derive(Clone, Deserialize)]
struct TokenUser {
    id: String,
    email: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartResponse {
    authorization_url: String,
    state: String,
    code_verifier: String,
    expires_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GatewayErrorBody {
    error: Option<String>,
    code: Option<String>,
    minimum_desktop_version: Option<String>,
    refresh_token: Option<String>,
    expected_user_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadyResponse {
    state: String,
    workspace: CloudWorkspace,
    session_expires_at: String,
}

#[derive(Deserialize)]
struct ProvisioningResponse {
    state: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudWorkspace {
    pub hosted_workspace_id: String,
    pub portable_workspace_id: String,
    pub name: String,
}

pub struct CloudWebViewSession {
    pub workspace: CloudWorkspace,
    pub cookie: Cookie<'static>,
    pub renew_at_epoch_seconds: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LogoutResponse {
    logout_url: String,
}

pub struct CloudAuthError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub clears_credential: bool,
    pub retry_after: Option<Duration>,
}

impl CloudAuthError {
    fn new(
        code: impl Into<String>,
        message: impl Into<String>,
        retryable: bool,
        clears_credential: bool,
    ) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable,
            clears_credential,
            retry_after: None,
        }
    }

    fn configuration(message: impl Into<String>) -> Self {
        Self::new("CLOUD_CONFIGURATION_INVALID", message, false, false)
    }

    fn transient(message: impl Into<String>) -> Self {
        Self::new("CLOUD_UNAVAILABLE", message, true, false)
    }
}

impl std::fmt::Display for CloudAuthError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

fn cancelled_auth_error() -> CloudAuthError {
    CloudAuthError::new("AUTH_CANCELLED", "Sign-in was cancelled.", true, false)
}

async fn await_auth_operation<T>(
    operation: impl Future<Output = T>,
    cancelled: &mut watch::Receiver<bool>,
) -> Result<T, CloudAuthError> {
    tokio::pin!(operation);
    loop {
        if *cancelled.borrow() {
            return Err(cancelled_auth_error());
        }
        tokio::select! {
            value = &mut operation => return Ok(value),
            changed = cancelled.changed() => {
                if changed.is_err() || *cancelled.borrow() {
                    return Err(cancelled_auth_error());
                }
            }
        }
    }
}

struct GatewayFailure {
    status: StatusCode,
    code: String,
    message: String,
    retry_after: Option<Duration>,
    details: Box<GatewayFailureDetails>,
}

#[derive(Default)]
struct GatewayFailureDetails {
    refresh_token: Option<String>,
    expected_user_id: Option<String>,
    minimum_desktop_version: Option<String>,
}

struct CloudHttpClient {
    client: Client,
}

impl CloudHttpClient {
    fn new() -> Result<Self, String> {
        let client = Client::builder()
            .redirect(Policy::none())
            .timeout(HTTP_TIMEOUT)
            .user_agent(concat!("Worktable-Desktop/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| "could not initialize the Worktable Cloud client".to_string())?;
        Ok(Self { client })
    }

    async fn config(&self, desktop_version: &str) -> Result<CloudDesktopConfig, CloudAuthError> {
        let response = self
            .client
            .get(format!("{WORKTABLE_CLOUD_ORIGIN}/gateway/desktop/config"))
            .send()
            .await
            .map_err(|_| {
                CloudAuthError::transient("Worktable Cloud configuration is unavailable")
            })?;
        self.success_json::<CloudDesktopConfig>(response)
            .await?
            .validate(desktop_version)
    }

    async fn start(&self, redirect_uri: &str) -> Result<StartResponse, CloudAuthError> {
        self.post_json(
            "/gateway/desktop/auth/start",
            &serde_json::json!({ "redirectUri": redirect_uri }),
            None,
        )
        .await
    }

    async fn exchange(
        &self,
        redirect_uri: &str,
        code: &str,
        code_verifier: &str,
    ) -> Result<TokenResponse, GatewayFailure> {
        self.post_json_failure(
            "/gateway/desktop/auth/exchange",
            &serde_json::json!({
                "redirectUri": redirect_uri,
                "code": code,
                "codeVerifier": code_verifier,
            }),
            None,
        )
        .await
    }

    async fn refresh(
        &self,
        refresh_token: &str,
        expected_user_id: &str,
    ) -> Result<TokenResponse, GatewayFailure> {
        self.post_json_failure(
            "/gateway/desktop/auth/refresh",
            &serde_json::json!({
                "refreshToken": refresh_token,
                "expectedUserId": expected_user_id,
            }),
            None,
        )
        .await
    }

    async fn webview_session(
        &self,
        access_token: &str,
        access_token_expires_at: OffsetDateTime,
        desktop_version: &str,
    ) -> Result<CloudWebViewSession, GatewayFailure> {
        let response = self
            .post(
                "/gateway/desktop/session",
                &serde_json::json!({
                    "desktopVersion": desktop_version,
                    "sessionProtocolVersion": DESKTOP_SESSION_PROTOCOL_VERSION,
                }),
                Some(access_token),
            )
            .await?;
        if response.status() == StatusCode::ACCEPTED {
            let retry_after = response
                .headers()
                .get(RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok())
                .map(Duration::from_secs);
            let provisioning = read_success_json::<ProvisioningResponse>(response)
                .await
                .map_err(GatewayFailure::from_auth_error)?;
            let Some((code, message)) = desktop_provisioning_retry(&provisioning.state) else {
                return Err(GatewayFailure::invalid(
                    "Desktop provisioning response is invalid",
                ));
            };
            return Err(GatewayFailure {
                status: StatusCode::ACCEPTED,
                code: code.into(),
                message: message.into(),
                retry_after,
                details: Box::default(),
            });
        }
        if !response.status().is_success() {
            return Err(read_gateway_failure(response).await);
        }
        let set_cookie_values = response
            .headers()
            .get_all(SET_COOKIE)
            .iter()
            .map(|value| value.to_str().map(str::to_owned))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| GatewayFailure::invalid("Desktop session cookie is invalid"))?;
        if set_cookie_values.len() != 1 {
            return Err(GatewayFailure::invalid(
                "Desktop session response has unexpected cookies",
            ));
        }
        let mut cookie = validate_session_cookie(&set_cookie_values[0])?;
        let ready = read_success_json::<ReadyResponse>(response)
            .await
            .map_err(GatewayFailure::from_auth_error)?;
        let session_expires_at =
            parse_timestamp(&ready.session_expires_at).map_err(GatewayFailure::from_auth_error)?;
        let now = OffsetDateTime::now_utc();
        if ready.state != "ready"
            || ready.workspace.hosted_workspace_id.trim().is_empty()
            || ready.workspace.portable_workspace_id.trim().is_empty()
            || ready.workspace.name.trim().is_empty()
            || session_expires_at <= now
            || session_expires_at > access_token_expires_at
        {
            return Err(GatewayFailure::invalid(
                "Desktop session response has invalid workspace identity",
            ));
        }
        let maximum_cookie_seconds = (session_expires_at - now)
            .whole_seconds()
            .min((access_token_expires_at - now).whole_seconds());
        let returned_cookie_seconds = cookie
            .max_age()
            .map(|duration| duration.whole_seconds())
            .unwrap_or_default();
        let bounded_cookie_seconds = returned_cookie_seconds.min(maximum_cookie_seconds);
        if bounded_cookie_seconds <= 0 {
            return Err(GatewayFailure::invalid(
                "Desktop session cookie has already expired",
            ));
        }
        let renew_at_epoch_seconds = cookie_renewal_deadline(now, bounded_cookie_seconds)
            .map_err(GatewayFailure::invalid)?;
        cookie.set_max_age(CookieDuration::seconds(bounded_cookie_seconds));
        Ok(CloudWebViewSession {
            workspace: ready.workspace,
            cookie,
            renew_at_epoch_seconds,
        })
    }

    async fn logout_url(&self, access_token: &str) -> Result<Url, CloudAuthError> {
        let response: LogoutResponse = self
            .post_json(
                "/gateway/desktop/auth/logout-url",
                &serde_json::json!({}),
                Some(access_token),
            )
            .await?;
        let url = Url::parse(&response.logout_url)
            .map_err(|_| CloudAuthError::configuration("The sign-out link is invalid"))?;
        let query = url.query_pairs().collect::<Vec<_>>();
        if url.scheme() != "https"
            || url.host_str() != Some("api.workos.com")
            || url.path() != "/user_management/sessions/logout"
            || query.len() != 1
            || query[0].0 != "session_id"
            || query[0].1.is_empty()
            || query[0].1.len() > 512
            || url.username() != ""
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err(CloudAuthError::configuration(
                "Worktable Desktop couldn’t verify the sign-out link.",
            ));
        }
        Ok(url)
    }

    async fn post_json<T: DeserializeOwned>(
        &self,
        path: &str,
        body: &impl Serialize,
        access_token: Option<&str>,
    ) -> Result<T, CloudAuthError> {
        match self.post_json_failure(path, body, access_token).await {
            Ok(value) => Ok(value),
            Err(error) => Err(error.into_auth_error()),
        }
    }

    async fn post_json_failure<T: DeserializeOwned>(
        &self,
        path: &str,
        body: &impl Serialize,
        access_token: Option<&str>,
    ) -> Result<T, GatewayFailure> {
        let response = self.post(path, body, access_token).await?;
        if !response.status().is_success() {
            return Err(read_gateway_failure(response).await);
        }
        read_success_json(response)
            .await
            .map_err(GatewayFailure::from_auth_error)
    }

    async fn post(
        &self,
        path: &str,
        body: &impl Serialize,
        access_token: Option<&str>,
    ) -> Result<Response, GatewayFailure> {
        let mut request = self
            .client
            .post(format!("{WORKTABLE_CLOUD_ORIGIN}{path}"))
            .header(CONTENT_TYPE, "application/json")
            .json(body);
        if let Some(token) = access_token {
            request = request.header(AUTHORIZATION, format!("Bearer {token}"));
        }
        request
            .send()
            .await
            .map_err(|_| GatewayFailure::transient("Worktable Cloud is unavailable"))
    }

    async fn success_json<T: DeserializeOwned>(
        &self,
        response: Response,
    ) -> Result<T, CloudAuthError> {
        if !response.status().is_success() {
            return Err(read_gateway_failure(response).await.into_auth_error());
        }
        read_success_json(response).await
    }
}

fn cookie_renewal_deadline(
    now: OffsetDateTime,
    bounded_cookie_seconds: i64,
) -> Result<u64, &'static str> {
    if bounded_cookie_seconds <= 0 {
        return Err("Desktop session renewal deadline is invalid");
    }
    let renewal_margin_seconds =
        (bounded_cookie_seconds / 2).clamp(1, ACCESS_REFRESH_MARGIN_SECONDS);
    (now + Duration::from_secs(
        bounded_cookie_seconds.saturating_sub(renewal_margin_seconds) as u64,
    ))
    .unix_timestamp()
    .try_into()
    .map_err(|_| "Desktop session renewal deadline is invalid")
}

impl GatewayFailure {
    fn transient(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "CLOUD_UNAVAILABLE".into(),
            message: message.into(),
            retry_after: None,
            details: Box::default(),
        }
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            code: "CLOUD_RESPONSE_INVALID".into(),
            message: message.into(),
            retry_after: None,
            details: Box::default(),
        }
    }

    fn from_auth_error(error: CloudAuthError) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            code: error.code,
            message: error.message,
            retry_after: None,
            details: Box::default(),
        }
    }

    fn into_auth_error(self) -> CloudAuthError {
        let credential_rejected = self.status == StatusCode::UNAUTHORIZED
            || matches!(self.code.as_str(), "AUTH_REFRESH_FAILED" | "UNAUTHORIZED");
        let retryable = gateway_failure_retryable(self.status, &self.code);
        let message = if self.code == "DESKTOP_UPGRADE_REQUIRED" {
            self.details
                .minimum_desktop_version
                .map(|version| format!("Update Worktable Desktop to {version} before connecting."))
                .unwrap_or(self.message)
        } else {
            self.message
        };
        let mut error = CloudAuthError::new(self.code, message, retryable, credential_rejected);
        error.retry_after = self.retry_after;
        error
    }
}

fn desktop_provisioning_retry(state: &str) -> Option<(&'static str, &'static str)> {
    match state {
        "provisioning" => Some((
            "PROVISIONING",
            "Worktable Cloud is preparing this workspace.",
        )),
        "confirming_payment" => Some((
            "CONFIRMING_PAYMENT",
            "Worktable Cloud is confirming this workspace subscription.",
        )),
        _ => None,
    }
}

fn gateway_failure_retryable(status: StatusCode, code: &str) -> bool {
    matches!(
        code,
        "PROVISIONING"
            | "CONFIRMING_PAYMENT"
            | "INSTANCE_MIGRATING"
            | "CONTROL_PLANE_DOWN"
            | "AUTH_VERIFICATION_UNAVAILABLE"
            | "AUTH_REFRESH_UNAVAILABLE"
    ) || status == StatusCode::TOO_MANY_REQUESTS
        || status == StatusCode::REQUEST_TIMEOUT
        || (status.is_server_error()
            && !matches!(
                code,
                "PROVISIONING_FAILED" | "CLOUD_RESPONSE_INVALID" | "CLOUD_CONFIGURATION_INVALID"
            ))
}

async fn read_response_bytes(mut response: Response) -> Result<Vec<u8>, CloudAuthError> {
    if response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > MAX_RESPONSE_BYTES)
    {
        return Err(CloudAuthError::configuration(
            "Cloud response exceeded the Desktop limit",
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| CloudAuthError::transient("Cloud response could not be read"))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(CloudAuthError::configuration(
                "Cloud response exceeded the Desktop limit",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn read_success_json<T: DeserializeOwned>(response: Response) -> Result<T, CloudAuthError> {
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim);
    let no_store = response
        .headers()
        .get_all(CACHE_CONTROL)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|directive| directive.trim().eq_ignore_ascii_case("no-store"));
    if !content_type.is_some_and(|value| value.eq_ignore_ascii_case("application/json"))
        || !no_store
    {
        return Err(CloudAuthError::configuration(
            "Cloud response does not meet the Desktop cache and media-type contract",
        ));
    }
    let bytes = read_response_bytes(response).await?;
    serde_json::from_slice(&bytes)
        .map_err(|_| CloudAuthError::configuration("Cloud returned an invalid response"))
}

async fn read_gateway_failure(response: Response) -> GatewayFailure {
    let status = response.status();
    let retry_after = response
        .headers()
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .map(Duration::from_secs);
    let body = match read_response_bytes(response).await {
        Ok(bytes) => serde_json::from_slice::<GatewayErrorBody>(&bytes).ok(),
        Err(_) => None,
    };
    let code = body
        .as_ref()
        .and_then(|body| body.code.clone())
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .unwrap_or_else(|| format!("CLOUD_HTTP_{}", status.as_u16()));
    let message = body
        .as_ref()
        .and_then(|body| body.error.clone())
        .filter(|value| !value.is_empty() && value.len() <= 2_048)
        .unwrap_or_else(|| "Worktable Cloud could not complete the request".into());
    GatewayFailure {
        status,
        code,
        message,
        retry_after,
        details: Box::new(GatewayFailureDetails {
            refresh_token: body.as_ref().and_then(|body| body.refresh_token.clone()),
            expected_user_id: body.as_ref().and_then(|body| body.expected_user_id.clone()),
            minimum_desktop_version: body.and_then(|body| body.minimum_desktop_version),
        }),
    }
}

fn parse_timestamp(value: &str) -> Result<OffsetDateTime, CloudAuthError> {
    OffsetDateTime::parse(value, &Rfc3339)
        .map_err(|_| CloudAuthError::configuration("Cloud returned an invalid timestamp"))
}

fn validate_session_cookie(header: &str) -> Result<Cookie<'static>, GatewayFailure> {
    let cookie = Cookie::parse(header.to_string())
        .map(Cookie::into_owned)
        .map_err(|_| GatewayFailure::invalid("Desktop session cookie is invalid"))?;
    if cookie.name() != "wt_session"
        || cookie.value().is_empty()
        || cookie.value().len() > 3_800
        || cookie.path() != Some("/")
        || cookie.domain().is_some()
        || cookie.http_only() != Some(true)
        || cookie.secure() != Some(true)
        || cookie.same_site() != Some(tauri::webview::cookie::SameSite::Lax)
        || cookie.max_age().is_none()
        || cookie.max_age().is_some_and(|age| age.whole_seconds() <= 0)
        || cookie.expires().is_some()
    {
        return Err(GatewayFailure::invalid(
            "Desktop session cookie does not meet the security contract",
        ));
    }
    Ok(cookie)
}

struct LoopbackCallback {
    code: String,
}

enum CallbackRequest {
    Complete(LoopbackCallback),
    OAuthError(String),
    Reject(&'static str),
}

fn parse_callback_request(
    request: &[u8],
    expected_port: u16,
    expected_state: &str,
) -> CallbackRequest {
    let raw = match std::str::from_utf8(request) {
        Ok(raw) => raw,
        Err(_) => return CallbackRequest::Reject("Invalid callback request"),
    };
    let mut lines = raw.split("\r\n");
    let request_line = match lines.next() {
        Some(line) => line,
        None => return CallbackRequest::Reject("Invalid callback request"),
    };
    let mut request_parts = request_line.split(' ');
    let method = request_parts.next();
    let target = request_parts.next();
    let version = request_parts.next();
    if method != Some("GET")
        || !matches!(version, Some("HTTP/1.0" | "HTTP/1.1"))
        || request_parts.next().is_some()
    {
        return CallbackRequest::Reject("Only an HTTP GET callback is accepted");
    }
    let expected_host = format!("127.0.0.1:{expected_port}");
    let mut host = None;
    let mut content_length = None;
    for line in lines {
        if line.is_empty() {
            break;
        }
        let Some((name, value)) = line.split_once(':') else {
            return CallbackRequest::Reject("Invalid callback headers");
        };
        let value = value.trim();
        if name.eq_ignore_ascii_case("host") {
            if host.replace(value).is_some() {
                return CallbackRequest::Reject("Callback host does not match this sign-in");
            }
        } else if name.eq_ignore_ascii_case("content-length") {
            if content_length.replace(value).is_some() {
                return CallbackRequest::Reject("Invalid callback headers");
            }
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            return CallbackRequest::Reject("Callback request body is not accepted");
        }
    }
    if host != Some(expected_host.as_str()) {
        return CallbackRequest::Reject("Callback host does not match this sign-in");
    }
    if content_length.is_some_and(|value| value != "0") {
        return CallbackRequest::Reject("Callback request body is not accepted");
    }
    let target = match target {
        Some(target) if target.len() <= 6_144 && !target.contains('#') => target,
        _ => return CallbackRequest::Reject("Invalid callback target"),
    };
    let url = match Url::parse(&format!("http://{expected_host}{target}")) {
        Ok(url) => url,
        Err(_) => return CallbackRequest::Reject("Invalid callback target"),
    };
    if url.path() != LOOPBACK_CALLBACK_PATH
        || url.host_str() != Some("127.0.0.1")
        || url.port() != Some(expected_port)
    {
        return CallbackRequest::Reject("Callback address does not match this sign-in");
    }
    let pairs = url.query_pairs().collect::<Vec<_>>();
    let values = |name: &str| {
        pairs
            .iter()
            .filter(|(key, _)| key == name)
            .map(|(_, value)| value.as_ref())
            .collect::<Vec<_>>()
    };
    if values("state") != [expected_state] {
        return CallbackRequest::Reject("Callback state does not match this sign-in");
    }
    let codes = values("code");
    let errors = values("error");
    let error_descriptions = values("error_description");
    if pairs.len() == 2
        && codes.len() == 1
        && errors.is_empty()
        && !codes[0].is_empty()
        && codes[0].len() <= 4_096
    {
        return CallbackRequest::Complete(LoopbackCallback {
            code: codes[0].to_string(),
        });
    }
    if errors.len() == 1
        && codes.is_empty()
        && !errors[0].is_empty()
        && errors[0].len() <= MAX_OAUTH_ERROR_BYTES
        && error_descriptions.len() <= 1
        && error_descriptions
            .first()
            .is_none_or(|description| description.len() <= 1_024)
    {
        return CallbackRequest::OAuthError(errors[0].to_string());
    }
    CallbackRequest::Reject("Callback must contain one authorization result")
}

async fn read_callback_request(stream: &mut TcpStream) -> Result<Vec<u8>, ()> {
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut request = Vec::with_capacity(1_024);
        let mut chunk = [0_u8; 1_024];
        loop {
            let read = stream.read(&mut chunk).await.map_err(|_| ())?;
            if read == 0 {
                return Err(());
            }
            request.extend_from_slice(&chunk[..read]);
            if request.len() > MAX_CALLBACK_REQUEST_BYTES {
                return Err(());
            }
            if let Some(header_end) = request
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
                .map(|position| position + 4)
            {
                if request.len() != header_end {
                    return Err(());
                }
                return Ok(request);
            }
        }
    })
    .await
    .map_err(|_| ())?
}

fn callback_expired_error() -> CloudAuthError {
    CloudAuthError::new(
        "AUTH_CALLBACK_EXPIRED",
        "This sign-in expired. Try again.",
        true,
        false,
    )
}

async fn read_callback_request_until(
    stream: &mut TcpStream,
    deadline: tokio::time::Instant,
    cancelled: &mut watch::Receiver<bool>,
) -> Result<Option<Vec<u8>>, CloudAuthError> {
    let request = read_callback_request(stream);
    tokio::pin!(request);
    loop {
        if *cancelled.borrow() {
            return Err(cancelled_auth_error());
        }
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => {
                return Err(callback_expired_error());
            }
            changed = cancelled.changed() => {
                if changed.is_err() || *cancelled.borrow() {
                    return Err(cancelled_auth_error());
                }
            }
            request = &mut request => return Ok(request.ok()),
        }
    }
}

async fn write_callback_response(stream: &mut TcpStream, success: bool) {
    let (status, heading, message) = if success {
        (
            "200 OK",
            "Sign-in complete",
            "You can close this window and return to Worktable.",
        )
    } else {
        (
            "400 Bad Request",
            "Sign-in not completed",
            "Return to Worktable and try again.",
        )
    };
    let body = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>{heading}</title></head><body><main><h1>{heading}</h1><p>{message}</p></main></body></html>"
    );
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

async fn await_loopback_callback(
    listener: TcpListener,
    expected_state: &str,
    expires_at: OffsetDateTime,
    cancelled: &mut watch::Receiver<bool>,
) -> Result<LoopbackCallback, CloudAuthError> {
    let timeout = authorization_callback_timeout(expires_at, OffsetDateTime::now_utc());
    if timeout.is_zero() {
        return Err(callback_expired_error());
    }
    let deadline = tokio::time::Instant::now() + timeout;
    let port = listener
        .local_addr()
        .map_err(|_| CloudAuthError::configuration("Loopback listener address is unavailable"))?
        .port();
    loop {
        let accepted = tokio::select! {
            _ = tokio::time::sleep_until(deadline) => {
                return Err(callback_expired_error());
            }
            changed = cancelled.changed() => {
                if changed.is_err() || *cancelled.borrow() {
                    return Err(cancelled_auth_error());
                }
                continue;
            }
            accepted = listener.accept() => accepted,
        };
        let (mut stream, peer) = accepted.map_err(|_| {
            CloudAuthError::transient("Worktable stopped waiting for browser sign-in. Try again.")
        })?;
        if !peer.ip().is_loopback() {
            write_callback_response(&mut stream, false).await;
            continue;
        }
        let request = match read_callback_request_until(&mut stream, deadline, cancelled).await? {
            Some(request) => request,
            None => {
                write_callback_response(&mut stream, false).await;
                continue;
            }
        };
        if request.is_empty() {
            write_callback_response(&mut stream, false).await;
            continue;
        }
        match parse_callback_request(&request, port, expected_state) {
            CallbackRequest::Complete(callback) => {
                write_callback_response(&mut stream, true).await;
                return Ok(callback);
            }
            CallbackRequest::OAuthError(error) => {
                write_callback_response(&mut stream, false).await;
                return Err(CloudAuthError::new(
                    "AUTH_DENIED",
                    match error.as_str() {
                        "access_denied" => "Sign-in was cancelled.",
                        "interaction_required" | "login_required" => "Sign in again to continue.",
                        _ => "Sign-in couldn’t be completed. Try again.",
                    },
                    true,
                    false,
                ));
            }
            CallbackRequest::Reject(_reason) => {
                write_callback_response(&mut stream, false).await;
            }
        }
    }
}

fn authorization_callback_timeout(expires_at: OffsetDateTime, now: OffsetDateTime) -> Duration {
    let provider_deadline = expires_at - now;
    let provider_duration = provider_deadline.try_into().unwrap_or(Duration::ZERO);
    AUTHORIZATION_TIMEOUT.min(provider_duration)
}

fn validate_authorization_start(
    start: &StartResponse,
    config: &CloudDesktopConfig,
    redirect_uri: &str,
) -> Result<OffsetDateTime, CloudAuthError> {
    let url = Url::parse(&start.authorization_url)
        .map_err(|_| CloudAuthError::configuration("The sign-in link is invalid"))?;
    let one = |name: &str| {
        let values = url
            .query_pairs()
            .filter(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
            .collect::<Vec<_>>();
        (values.len() == 1).then(|| values[0].clone())
    };
    let code_challenge = one("code_challenge");
    let expected_code_challenge =
        URL_SAFE_NO_PAD.encode(Sha256::digest(start.code_verifier.as_bytes()));
    if url.scheme() != "https"
        || url.host_str() != Some("api.workos.com")
        || url.path() != "/user_management/authorize"
        || url.username() != ""
        || url.password().is_some()
        || url.fragment().is_some()
        || one("client_id").as_deref() != Some(config.client_id())
        || one("redirect_uri").as_deref() != Some(redirect_uri)
        || one("provider").as_deref() != Some("authkit")
        || one("response_type").as_deref() != Some("code")
        || one("code_challenge_method").as_deref() != Some("S256")
        || one("state").as_deref() != Some(start.state.as_str())
        || code_challenge.as_deref() != Some(expected_code_challenge.as_str())
        || !(43..=256).contains(&start.state.len())
        || !start
            .state
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_".contains(character))
        || !(43..=128).contains(&start.code_verifier.len())
        || !start
            .code_verifier
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._~-".contains(character))
    {
        return Err(CloudAuthError::configuration(
            "Worktable Desktop couldn’t verify this sign-in.",
        ));
    }
    let expires_at = parse_timestamp(&start.expires_at)?;
    validate_authorization_deadline(expires_at, OffsetDateTime::now_utc())?;
    Ok(expires_at)
}

fn validate_authorization_deadline(
    expires_at: OffsetDateTime,
    now: OffsetDateTime,
) -> Result<(), CloudAuthError> {
    if expires_at <= now || expires_at > now + AUTHORIZATION_TIMEOUT + AUTHORIZATION_CLOCK_SKEW {
        return Err(CloudAuthError::configuration(
            "Worktable Desktop couldn’t verify this sign-in.",
        ));
    }
    Ok(())
}

fn validate_token_response(
    response: TokenResponse,
    expected_user_id: Option<&str>,
) -> Result<(CloudAccessSession, StoredCredential), CloudAuthError> {
    let expires_at = parse_timestamp(&response.access_token_expires_at)?;
    let now = OffsetDateTime::now_utc();
    if response.access_token.is_empty()
        || response.access_token.len() > 16_384
        || response.refresh_token.is_empty()
        || response.refresh_token.len() > MAX_REFRESH_TOKEN_BYTES
        || response.session_id.trim().is_empty()
        || response.session_id.len() > 512
        || response.user.id.trim().is_empty()
        || response.user.id.len() > 512
        || response.user.email.trim().is_empty()
        || response.user.email.len() > 2_048
        || expected_user_id.is_some_and(|expected| expected != response.user.id)
        || expires_at <= now
        || expires_at > now + Duration::from_secs(10 * 60)
    {
        return Err(CloudAuthError::new(
            "AUTH_IDENTITY_MISMATCH",
            "A different account completed sign-in.",
            false,
            true,
        ));
    }
    let credential = StoredCredential::new(
        response.refresh_token,
        response.user.id.clone(),
        response.session_id.clone(),
        now_rfc3339().map_err(CloudAuthError::configuration)?,
    )
    .map_err(CloudAuthError::configuration)?;
    Ok((
        CloudAccessSession {
            access_token: response.access_token,
            access_token_expires_at: expires_at,
            session_id: response.session_id,
            user: CloudUser {
                id: response.user.id,
            },
        },
        credential,
    ))
}

fn replacement_credential(
    current: &StoredCredential,
    refresh_token: String,
) -> Result<StoredCredential, CloudAuthError> {
    let rotated_at = now_rfc3339().map_err(CloudAuthError::configuration)?;
    if current.is_continuation() {
        StoredCredential::continuation(
            refresh_token,
            current.workos_user_id().to_string(),
            rotated_at,
        )
    } else {
        StoredCredential::new(
            refresh_token,
            current.workos_user_id().to_string(),
            current.session_id().to_string(),
            rotated_at,
        )
    }
    .map_err(CloudAuthError::configuration)
}

pub struct CloudAuthController {
    http: CloudHttpClient,
    credentials: Arc<dyn CredentialStore>,
    access: Mutex<Option<CloudAccessSession>>,
    auth_cancellation: Mutex<Option<watch::Sender<bool>>>,
    session_operation: AsyncMutex<()>,
}

impl CloudAuthController {
    pub fn new(credentials: Arc<dyn CredentialStore>) -> Result<Self, String> {
        Ok(Self {
            http: CloudHttpClient::new()?,
            credentials,
            access: Mutex::new(None),
            auth_cancellation: Mutex::new(None),
            session_operation: AsyncMutex::new(()),
        })
    }

    pub fn cancel_auth_operation(&self) {
        if let Ok(mut current) = self.auth_cancellation.lock() {
            if let Some(sender) = current.take() {
                let _ = sender.send(true);
            }
        }
    }

    pub async fn authenticate_interactively(
        &self,
        app: &AppHandle,
        desktop_version: &str,
    ) -> Result<CloudUser, CloudAuthError> {
        self.cancel_auth_operation();
        let _session_operation = self.session_operation.lock().await;
        let (cancel_sender, mut cancel_receiver) = watch::channel(false);
        self.auth_cancellation
            .lock()
            .map_err(|_| CloudAuthError::configuration("Cloud sign-in state is unavailable"))?
            .replace(cancel_sender);
        let result = async {
            let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|_| {
                CloudAuthError::configuration("Could not open a secure loopback sign-in callback")
            })?;
            let port = listener
                .local_addr()
                .map_err(|_| CloudAuthError::configuration("Loopback callback is unavailable"))?
                .port();
            if port < 1024 {
                return Err(CloudAuthError::configuration(
                    "Loopback callback selected a privileged port",
                ));
            }
            let redirect_uri = format!("http://127.0.0.1:{port}{LOOPBACK_CALLBACK_PATH}");
            let config =
                await_auth_operation(self.http.config(desktop_version), &mut cancel_receiver)
                    .await??;
            let start = await_auth_operation(self.http.start(&redirect_uri), &mut cancel_receiver)
                .await??;
            let expires_at = validate_authorization_start(&start, &config, &redirect_uri)?;
            let authorization_url = start
                .authorization_url
                .parse::<tauri::Url>()
                .map_err(|_| CloudAuthError::configuration("The sign-in link is invalid"))?;
            app.opener()
                .open_url(authorization_url, None::<&str>)
                .map_err(|_| {
                    CloudAuthError::transient("Couldn’t open the sign-in page in your browser.")
                })?;
            let callback =
                await_loopback_callback(listener, &start.state, expires_at, &mut cancel_receiver)
                    .await?;
            let exchange = await_auth_operation(
                self.http
                    .exchange(&redirect_uri, &callback.code, &start.code_verifier),
                &mut cancel_receiver,
            )
            .await?;
            let token = match exchange {
                Ok(token) => token,
                Err(mut failure)
                    if failure.status == StatusCode::SERVICE_UNAVAILABLE
                        && failure.code == "AUTH_EXCHANGE_UNAVAILABLE"
                        && failure.details.refresh_token.is_some()
                        && failure.details.expected_user_id.is_some() =>
                {
                    let refresh_token = failure.details.refresh_token.take().unwrap_or_default();
                    let expected_user_id =
                        failure.details.expected_user_id.take().unwrap_or_default();
                    let continuation = StoredCredential::continuation(
                        refresh_token,
                        expected_user_id,
                        now_rfc3339().map_err(CloudAuthError::configuration)?,
                    )
                    .map_err(CloudAuthError::configuration)?;
                    self.credentials
                        .store(WORKTABLE_CLOUD_ORIGIN, &continuation)
                        .map_err(|_| {
                            CloudAuthError::new(
                                "CREDENTIAL_STORE_FAILED",
                                "macOS Keychain couldn’t save this unfinished sign-in.",
                                true,
                                true,
                            )
                        })?;
                    return self
                        .refresh_with_credential(
                            continuation,
                            desktop_version,
                            Some(&mut cancel_receiver),
                        )
                        .await;
                }
                Err(failure) => return Err(failure.into_auth_error()),
            };
            let (access, credential) = validate_token_response(token, None)?;
            self.credentials
                .store(WORKTABLE_CLOUD_ORIGIN, &credential)
                .map_err(|_| {
                    CloudAuthError::new(
                        "CREDENTIAL_STORE_FAILED",
                        "macOS Keychain couldn’t save this Cloud session. Sign in again.",
                        true,
                        true,
                    )
                })?;
            let user = access.user.clone();
            *self.access.lock().map_err(|_| {
                CloudAuthError::configuration("Cloud session state is unavailable")
            })? = Some(access);
            Ok(user)
        }
        .await;
        if let Ok(mut current) = self.auth_cancellation.lock() {
            current.take();
        }
        result
    }

    pub async fn resume(
        &self,
        workos_user_id: &str,
        desktop_version: &str,
    ) -> Result<CloudUser, CloudAuthError> {
        self.cancel_auth_operation();
        let _session_operation = self.session_operation.lock().await;
        let (cancel_sender, mut cancel_receiver) = watch::channel(false);
        self.auth_cancellation
            .lock()
            .map_err(|_| CloudAuthError::configuration("Cloud restore state is unavailable"))?
            .replace(cancel_sender);
        let result = self
            .resume_locked(workos_user_id, desktop_version, Some(&mut cancel_receiver))
            .await;
        if let Ok(mut current) = self.auth_cancellation.lock() {
            current.take();
        }
        result
    }

    pub fn stored_profileless_user_id(&self) -> Result<Option<String>, CloudAuthError> {
        self.credentials
            .load_only(WORKTABLE_CLOUD_ORIGIN)
            .map(|credential| credential.map(|credential| credential.workos_user_id().to_string()))
            .map_err(|message| CloudAuthError::new("CREDENTIAL_STORE_FAILED", message, true, true))
    }

    pub fn has_stored_credential(&self, workos_user_id: &str) -> Result<bool, CloudAuthError> {
        self.credentials
            .load(WORKTABLE_CLOUD_ORIGIN, workos_user_id)
            .map(|credential| credential.is_some())
            .map_err(|message| CloudAuthError::new("CREDENTIAL_STORE_FAILED", message, true, true))
    }

    async fn resume_locked(
        &self,
        workos_user_id: &str,
        desktop_version: &str,
        mut cancellation: Option<&mut watch::Receiver<bool>>,
    ) -> Result<CloudUser, CloudAuthError> {
        let config = if let Some(cancelled) = cancellation.as_mut() {
            await_auth_operation(self.http.config(desktop_version), cancelled).await?
        } else {
            self.http.config(desktop_version).await
        };
        config?;
        let credential = self
            .credentials
            .load(WORKTABLE_CLOUD_ORIGIN, workos_user_id)
            .map_err(|message| CloudAuthError::new("CREDENTIAL_STORE_FAILED", message, true, true))?
            .ok_or_else(|| {
                CloudAuthError::new(
                    "AUTHENTICATION_REQUIRED",
                    "Sign in to Worktable Cloud on this Mac.",
                    true,
                    true,
                )
            })?;
        if credential.workos_user_id() != workos_user_id {
            return Err(self.discard_rejected_credential(
                workos_user_id,
                CloudAuthError::new(
                    "AUTH_IDENTITY_MISMATCH",
                    "The saved account doesn’t match this Cloud connection.",
                    false,
                    true,
                ),
            ));
        }
        self.refresh_with_credential(credential, desktop_version, cancellation)
            .await
    }

    async fn refresh_with_credential(
        &self,
        credential: StoredCredential,
        desktop_version: &str,
        cancellation: Option<&mut watch::Receiver<bool>>,
    ) -> Result<CloudUser, CloudAuthError> {
        let expected_user_id = credential.workos_user_id().to_string();
        let refresh = self
            .http
            .refresh(credential.refresh_token(), &expected_user_id);
        let refresh = if let Some(cancelled) = cancellation {
            await_auth_operation(refresh, cancelled).await?
        } else {
            refresh.await
        };
        let token = match refresh {
            Ok(token) => token,
            Err(mut failure)
                if failure.status == StatusCode::SERVICE_UNAVAILABLE
                    && failure.code == "AUTH_REFRESH_UNAVAILABLE" =>
            {
                if let Some(refresh_token) = failure.details.refresh_token.take() {
                    let replacement = match replacement_credential(&credential, refresh_token) {
                        Ok(replacement) => replacement,
                        Err(error) => {
                            return Err(self.discard_rejected_credential(&expected_user_id, error));
                        }
                    };
                    if self
                        .credentials
                        .store(WORKTABLE_CLOUD_ORIGIN, &replacement)
                        .is_err()
                    {
                        let error = CloudAuthError::new(
                            "CREDENTIAL_STORE_FAILED",
                            "macOS Keychain couldn’t update this Cloud session. Sign in again.",
                            true,
                            true,
                        );
                        return Err(self.discard_rejected_credential(&expected_user_id, error));
                    }
                }
                return Err(failure.into_auth_error());
            }
            Err(failure) => {
                let error = failure.into_auth_error();
                if error.clears_credential {
                    return Err(self.discard_rejected_credential(&expected_user_id, error));
                }
                return Err(error);
            }
        };
        let (access, rotated) = match validate_token_response(token, Some(&expected_user_id)) {
            Ok(validated) => validated,
            Err(error) => {
                if error.clears_credential {
                    return Err(self.discard_rejected_credential(&expected_user_id, error));
                }
                return Err(error);
            }
        };
        if let Err(_error) = self.credentials.store(WORKTABLE_CLOUD_ORIGIN, &rotated) {
            let error = CloudAuthError::new(
                "CREDENTIAL_STORE_FAILED",
                "macOS Keychain couldn’t update this Cloud session. Sign in again.",
                true,
                true,
            );
            return Err(self.discard_rejected_credential(&expected_user_id, error));
        }
        let user = access.user.clone();
        *self
            .access
            .lock()
            .map_err(|_| CloudAuthError::configuration("Cloud session state is unavailable"))? =
            Some(access);
        let _ = desktop_version;
        Ok(user)
    }

    fn discard_rejected_credential(
        &self,
        workos_user_id: &str,
        original: CloudAuthError,
    ) -> CloudAuthError {
        if let Ok(mut current) = self.access.lock() {
            current.take();
        }
        match self
            .credentials
            .remove(WORKTABLE_CLOUD_ORIGIN, workos_user_id)
        {
            Ok(()) => original,
            Err(_) => CloudAuthError::new(
                "CREDENTIAL_STORE_FAILED",
                "macOS Keychain couldn’t remove the saved Cloud credential. Remove the Cloud connection before signing in again.",
                false,
                false,
            ),
        }
    }

    pub async fn renew_if_needed(
        &self,
        workos_user_id: &str,
        desktop_version: &str,
    ) -> Result<bool, CloudAuthError> {
        let _session_operation = self.session_operation.lock().await;
        let needs_refresh = self
            .access
            .lock()
            .map_err(|_| CloudAuthError::configuration("Cloud session state is unavailable"))?
            .as_ref()
            .map(|access| {
                access.user.id != workos_user_id
                    || access.access_token_expires_at
                        <= OffsetDateTime::now_utc()
                            + Duration::from_secs(ACCESS_REFRESH_MARGIN_SECONDS as u64)
            })
            .unwrap_or(true);
        if !needs_refresh {
            return Ok(false);
        }
        self.resume_locked(workos_user_id, desktop_version, None)
            .await?;
        Ok(true)
    }

    pub fn refresh_delay(&self) -> Result<Option<Duration>, CloudAuthError> {
        let guard = self
            .access
            .lock()
            .map_err(|_| CloudAuthError::configuration("Cloud session state is unavailable"))?;
        let Some(access) = guard.as_ref() else {
            return Ok(None);
        };
        let refresh_at = access.access_token_expires_at
            - Duration::from_secs(ACCESS_REFRESH_MARGIN_SECONDS as u64);
        let remaining = refresh_at - OffsetDateTime::now_utc();
        Ok(Some(remaining.try_into().unwrap_or(Duration::ZERO)))
    }

    pub fn access_is_valid(&self, workos_user_id: &str) -> bool {
        self.access
            .lock()
            .ok()
            .and_then(|access| {
                access.as_ref().map(|session| {
                    session.user.id == workos_user_id
                        && session.access_token_expires_at > OffsetDateTime::now_utc()
                })
            })
            .unwrap_or(false)
    }

    pub fn current_user(&self) -> Option<CloudUser> {
        self.access.lock().ok().and_then(|access| {
            access.as_ref().and_then(|session| {
                (session.access_token_expires_at > OffsetDateTime::now_utc())
                    .then(|| session.user.clone())
            })
        })
    }

    pub async fn issue_webview_session(
        &self,
        desktop_version: &str,
    ) -> Result<CloudWebViewSession, CloudAuthError> {
        let (access_token, access_token_expires_at) = self
            .access
            .lock()
            .map_err(|_| CloudAuthError::configuration("Cloud session state is unavailable"))?
            .as_ref()
            .map(|access| (access.access_token.clone(), access.access_token_expires_at))
            .ok_or_else(|| {
                CloudAuthError::new(
                    "AUTHENTICATION_REQUIRED",
                    "Sign in to Worktable Cloud on this Mac.",
                    true,
                    true,
                )
            })?;
        self.http
            .webview_session(&access_token, access_token_expires_at, desktop_version)
            .await
            .map_err(GatewayFailure::into_auth_error)
    }

    pub async fn exact_session_logout_url(
        &self,
        workos_user_id: &str,
        desktop_version: &str,
    ) -> Result<Url, CloudAuthError> {
        self.renew_if_needed(workos_user_id, desktop_version)
            .await?;
        let (access_token, expected_session_id) = self
            .access
            .lock()
            .map_err(|_| CloudAuthError::configuration("Cloud session state is unavailable"))?
            .as_ref()
            .map(|access| (access.access_token.clone(), access.session_id.clone()))
            .ok_or_else(|| {
                CloudAuthError::new(
                    "AUTHENTICATION_REQUIRED",
                    "Sign in to Worktable Cloud on this Mac.",
                    true,
                    true,
                )
            })?;
        let url = self.http.logout_url(&access_token).await?;
        let session_id = url
            .query_pairs()
            .find(|(key, _)| key == "session_id")
            .map(|(_, value)| value.into_owned());
        if session_id.as_deref() != Some(expected_session_id.as_str()) {
            return Err(CloudAuthError::configuration(
                "Worktable Desktop couldn’t verify the sign-out link.",
            ));
        }
        Ok(url)
    }

    pub async fn clear_local(&self, workos_user_id: &str) -> Result<(), String> {
        self.cancel_auth_operation();
        let _session_operation = self.session_operation.lock().await;
        if let Ok(mut access) = self.access.lock() {
            access.take();
        }
        self.credentials
            .remove(WORKTABLE_CLOUD_ORIGIN, workos_user_id)
    }

    pub async fn clear_all_local(&self) -> Result<(), String> {
        self.cancel_auth_operation();
        let _session_operation = self.session_operation.lock().await;
        if let Ok(mut access) = self.access.lock() {
            access.take();
        }
        self.credentials.remove_all(WORKTABLE_CLOUD_ORIGIN)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credential_store::MemoryCredentialStore;
    use tokio::sync::oneshot;

    fn config() -> CloudDesktopConfig {
        CloudDesktopConfig {
            document_type: "worktable.desktop-cloud-config".into(),
            version: 1,
            environment: WORKTABLE_CLOUD_ENVIRONMENT.into(),
            public_base_url: WORKTABLE_CLOUD_ORIGIN.into(),
            issuer: if cfg!(feature = "staging") {
                "https://example-staging.authkit.app".into()
            } else {
                "https://worktable.authkit.app".into()
            },
            auth: CloudDesktopAuthConfig {
                mode: "authkit-pkce-loopback".into(),
                client_id: "client_desktop".into(),
                redirect_uri_pattern: DESKTOP_CALLBACK_PATTERN.into(),
            },
            minimum_desktop_version: "0.0.49".into(),
            session_protocol_version: DESKTOP_SESSION_PROTOCOL_VERSION,
        }
    }

    #[test]
    fn configuration_is_bound_to_the_compiled_environment() {
        assert!(config().validate("0.0.49").is_ok());
        let mut wrong = config();
        wrong.public_base_url = if cfg!(feature = "staging") {
            "https://app.worktable.cloud".into()
        } else {
            "https://staging.example.test".into()
        };
        assert!(wrong.validate("0.0.49").is_err());

        let mut wrong_issuer = config();
        wrong_issuer.issuer = if cfg!(feature = "staging") {
            "https://worktable.authkit.app".into()
        } else {
            "https://example-staging.authkit.app".into()
        };
        assert!(wrong_issuer.validate("0.0.49").is_err());
        assert_eq!(
            config().validate("0.0.45").unwrap_err().code,
            "DESKTOP_UPGRADE_REQUIRED"
        );
    }

    #[test]
    fn callback_accepts_only_the_exact_bound_request_and_state() {
        let request = b"GET /worktable/callback?code=code_123&state=state_123 HTTP/1.1\r\nHost: 127.0.0.1:49152\r\nConnection: close\r\n\r\n";
        assert!(matches!(
            parse_callback_request(request, 49152, "state_123"),
            CallbackRequest::Complete(LoopbackCallback { code }) if code == "code_123"
        ));
        assert!(matches!(
            parse_callback_request(
                b"GET /worktable/callback?error=access_denied&error_description=User%20cancelled&state=state_123 HTTP/1.1\r\nHost: 127.0.0.1:49152\r\n\r\n",
                49152,
                "state_123"
            ),
            CallbackRequest::OAuthError(error) if error == "access_denied"
        ));
        assert!(matches!(
            parse_callback_request(
                b"GET /worktable/callback?error=temporarily_unavailable&state=state_123 HTTP/1.1\r\nHost: 127.0.0.1:49152\r\n\r\n",
                49152,
                "state_123"
            ),
            CallbackRequest::OAuthError(error) if error == "temporarily_unavailable"
        ));
        assert!(matches!(
            parse_callback_request(
                b"GET /worktable/callback?error=server_error&error_uri=https%3A%2F%2Fapi.workos.com%2Ferrors%2Fserver&state=state_123 HTTP/1.1\r\nHost: 127.0.0.1:49152\r\n\r\n",
                49152,
                "state_123"
            ),
            CallbackRequest::OAuthError(error) if error == "server_error"
        ));
        for rejected in [
            b"POST /worktable/callback?code=code_123&state=state_123 HTTP/1.1\r\nHost: 127.0.0.1:49152\r\n\r\n".as_slice(),
            b"GET /worktable/callback?code=code_123&state=wrong HTTP/1.1\r\nHost: 127.0.0.1:49152\r\n\r\n".as_slice(),
            b"GET /worktable/callback?code=code_123&state=state_123 HTTP/1.1\r\nHost: localhost:49152\r\n\r\n".as_slice(),
            b"GET /other?code=code_123&state=state_123 HTTP/1.1\r\nHost: 127.0.0.1:49152\r\n\r\n".as_slice(),
            b"GET /worktable/callback?code=one&code=two&state=state_123 HTTP/1.1\r\nHost: 127.0.0.1:49152\r\n\r\n".as_slice(),
            b"GET /worktable/callback?code=code_123&state=state_123 HTTP/1.1\r\nHost: 127.0.0.1:49152\r\nHost: 127.0.0.1:49152\r\n\r\n".as_slice(),
            b"GET /worktable/callback?code=code_123&state=state_123 HTTP/1.1\r\nHost: 127.0.0.1:49152\r\nContent-Length: 1\r\n\r\n".as_slice(),
            b"GET /worktable/callback?code=code_123&state=state_123&extra=value HTTP/1.1\r\nHost: 127.0.0.1:49152\r\n\r\n".as_slice(),
        ] {
            assert!(matches!(
                parse_callback_request(rejected, 49152, "state_123"),
                CallbackRequest::Reject(_)
            ));
        }
    }

    #[test]
    fn authorization_start_is_bound_to_pkce_state_client_and_callback() {
        let redirect_uri = "http://127.0.0.1:49152/worktable/callback";
        let state = "s".repeat(43);
        let code_verifier = "v".repeat(64);
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(code_verifier.as_bytes()));
        let expires_at = (OffsetDateTime::now_utc() + Duration::from_secs(600))
            .format(&Rfc3339)
            .unwrap();
        let mut authorization_url =
            Url::parse("https://api.workos.com/user_management/authorize").unwrap();
        authorization_url
            .query_pairs_mut()
            .append_pair("client_id", config().client_id())
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("provider", "authkit")
            .append_pair("response_type", "code")
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", &state)
            .append_pair("code_challenge", &challenge);
        let valid = StartResponse {
            authorization_url: authorization_url.to_string(),
            state: state.clone(),
            code_verifier: code_verifier.clone(),
            expires_at: expires_at.clone(),
        };
        assert!(validate_authorization_start(&valid, &config(), redirect_uri).is_ok());

        for invalid in [
            StartResponse {
                state: "short".into(),
                ..StartResponse {
                    authorization_url: authorization_url.to_string(),
                    state: state.clone(),
                    code_verifier: code_verifier.clone(),
                    expires_at: expires_at.clone(),
                }
            },
            StartResponse {
                code_verifier: "contains whitespace".into(),
                ..StartResponse {
                    authorization_url: authorization_url.to_string(),
                    state: state.clone(),
                    code_verifier: code_verifier.clone(),
                    expires_at: expires_at.clone(),
                }
            },
            StartResponse {
                authorization_url: authorization_url.to_string().replace(
                    &format!("code_challenge={challenge}"),
                    "code_challenge=short",
                ),
                state: state.clone(),
                code_verifier,
                expires_at,
            },
        ] {
            assert!(validate_authorization_start(&invalid, &config(), redirect_uri).is_err());
        }
    }

    #[test]
    fn authorization_deadline_allows_bounded_clock_skew_without_extending_the_callback() {
        let now = OffsetDateTime::UNIX_EPOCH;
        let observed_staging_deadline = now + AUTHORIZATION_TIMEOUT + Duration::from_millis(34);
        assert!(validate_authorization_deadline(observed_staging_deadline, now).is_ok());
        assert_eq!(
            authorization_callback_timeout(observed_staging_deadline, now),
            AUTHORIZATION_TIMEOUT
        );

        let maximum_valid_deadline = now + AUTHORIZATION_TIMEOUT + AUTHORIZATION_CLOCK_SKEW;
        assert!(validate_authorization_deadline(maximum_valid_deadline, now).is_ok());
        assert!(validate_authorization_deadline(
            maximum_valid_deadline + Duration::from_millis(1),
            now
        )
        .is_err());
        assert!(validate_authorization_deadline(now, now).is_err());
    }

    #[test]
    fn validates_the_http_only_host_bound_session_cookie() {
        assert!(validate_session_cookie(
            "wt_session=sealed; Max-Age=300; Path=/; HttpOnly; Secure; SameSite=Lax"
        )
        .is_ok());
        for rejected in [
            "wt_session=sealed; Max-Age=300; Path=/; Secure; SameSite=Lax",
            "wt_session=sealed; Max-Age=300; Path=/; HttpOnly; SameSite=Lax",
            "wt_session=sealed; Max-Age=300; Domain=app.worktable.cloud; Path=/; HttpOnly; Secure; SameSite=Lax",
            "other=sealed; Max-Age=300; Path=/; HttpOnly; Secure; SameSite=Lax",
        ] {
            assert!(validate_session_cookie(rejected).is_err());
        }
    }

    #[test]
    fn renews_webview_sessions_before_their_earliest_bounded_expiry() {
        let now = OffsetDateTime::from_unix_timestamp(1_000).unwrap();
        assert_eq!(cookie_renewal_deadline(now, 300).unwrap(), 1_210);
        assert_eq!(cookie_renewal_deadline(now, 60).unwrap(), 1_030);
        assert!(cookie_renewal_deadline(now, 0).is_err());
    }

    #[test]
    fn invalid_desktop_responses_remain_terminal_even_with_a_502_status() {
        for failure in [
            GatewayFailure::invalid("invalid ready response"),
            GatewayFailure::from_auth_error(CloudAuthError::configuration(
                "invalid response contract",
            )),
        ] {
            assert!(!failure.into_auth_error().retryable);
        }
        assert!(
            GatewayFailure {
                status: StatusCode::BAD_GATEWAY,
                code: "CLOUD_HTTP_502".into(),
                message: "upstream unavailable".into(),
                retry_after: None,
                details: Box::default(),
            }
            .into_auth_error()
            .retryable
        );
    }

    #[test]
    fn every_supported_desktop_provisioning_state_remains_retryable() {
        for (state, code) in [
            ("provisioning", "PROVISIONING"),
            ("confirming_payment", "CONFIRMING_PAYMENT"),
        ] {
            let (actual_code, _) =
                desktop_provisioning_retry(state).expect("supported state should keep polling");
            assert_eq!(actual_code, code);
            assert!(gateway_failure_retryable(StatusCode::ACCEPTED, actual_code));
        }
        assert!(desktop_provisioning_retry("payment_required").is_none());
        assert!(desktop_provisioning_retry("ready").is_none());
    }

    #[tokio::test]
    async fn cancellation_interrupts_an_in_flight_authentication_operation() {
        let (cancel_sender, mut cancel_receiver) = watch::channel(false);
        let (started_sender, started_receiver) = oneshot::channel();
        let operation = async move {
            let _ = started_sender.send(());
            std::future::pending::<()>().await;
        };
        let task =
            tokio::spawn(
                async move { await_auth_operation(operation, &mut cancel_receiver).await },
            );
        started_receiver.await.unwrap();
        cancel_sender.send(true).unwrap();
        let error = tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .expect("authentication cancellation should not wait for the HTTP timeout")
            .unwrap()
            .unwrap_err();
        assert_eq!(error.code, "AUTH_CANCELLED");
    }

    #[tokio::test]
    async fn cancellation_interrupts_a_stalled_callback_request_read() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (client, accepted) = tokio::join!(TcpStream::connect(address), listener.accept());
        let mut client = client.unwrap();
        let (mut server, _) = accepted.unwrap();
        client.write_all(b"GET /worktable").await.unwrap();

        let (cancel_sender, mut cancel_receiver) = watch::channel(false);
        let task = tokio::spawn(async move {
            read_callback_request_until(
                &mut server,
                tokio::time::Instant::now() + Duration::from_secs(60),
                &mut cancel_receiver,
            )
            .await
        });
        cancel_sender.send(true).unwrap();
        let error = tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .expect("callback cancellation should not wait for the read timeout")
            .unwrap()
            .unwrap_err();
        assert_eq!(error.code, "AUTH_CANCELLED");
    }

    #[tokio::test]
    async fn a_state_bound_provider_error_ends_the_callback_wait() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (_cancel_sender, mut cancel_receiver) = watch::channel(false);
        let expires_at = OffsetDateTime::now_utc() + Duration::from_secs(60);
        let task = tokio::spawn(async move {
            await_loopback_callback(listener, "state_123", expires_at, &mut cancel_receiver).await
        });

        let mut client = TcpStream::connect(address).await.unwrap();
        client
            .write_all(
                b"GET /worktable/callback?error=server_error&state=state_123 HTTP/1.1\r\nHost: 127.0.0.1:",
            )
            .await
            .unwrap();
        client
            .write_all(format!("{}\r\n\r\n", address.port()).as_bytes())
            .await
            .unwrap();

        let result = tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .expect("provider error should end the callback wait")
            .expect("callback task should finish");
        let error = match result {
            Ok(_) => panic!("provider error must not complete sign-in"),
            Err(error) => error,
        };
        assert_eq!(error.code, "AUTH_DENIED");
        assert_eq!(error.message, "Sign-in couldn’t be completed. Try again.");
    }

    #[test]
    fn token_validation_rejects_subject_change_without_exposing_tokens() {
        let response = TokenResponse {
            access_token: "access_secret".into(),
            refresh_token: "refresh_secret".into(),
            access_token_expires_at: (OffsetDateTime::now_utc() + Duration::from_secs(300))
                .format(&Rfc3339)
                .unwrap(),
            session_id: "session_owner".into(),
            user: TokenUser {
                id: "user_other".into(),
                email: "owner@example.com".into(),
            },
        };
        let error = validate_token_response(response, Some("user_owner"))
            .err()
            .unwrap();
        assert_eq!(error.code, "AUTH_IDENTITY_MISMATCH");
        assert!(!error.message.contains("access_secret"));
        assert!(!error.message.contains("refresh_secret"));
    }

    #[test]
    fn token_validation_uses_the_keychain_refresh_token_limit() {
        let response = |refresh_token: String| TokenResponse {
            access_token: "access_secret".into(),
            refresh_token,
            access_token_expires_at: (OffsetDateTime::now_utc() + Duration::from_secs(300))
                .format(&Rfc3339)
                .unwrap(),
            session_id: "session_owner".into(),
            user: TokenUser {
                id: "user_owner".into(),
                email: "owner@example.com".into(),
            },
        };
        assert!(
            validate_token_response(response("r".repeat(MAX_REFRESH_TOKEN_BYTES)), None).is_ok()
        );
        assert!(
            validate_token_response(response("r".repeat(MAX_REFRESH_TOKEN_BYTES + 1)), None)
                .is_err()
        );
    }

    #[test]
    fn replacement_refresh_credential_keeps_the_exact_identity_and_session() {
        let current = StoredCredential::new(
            "old_refresh".into(),
            "user_owner".into(),
            "session_owner".into(),
            "2026-07-29T00:00:00Z".into(),
        )
        .unwrap();
        let replacement = replacement_credential(&current, "new_refresh".into())
            .ok()
            .unwrap();
        assert_eq!(replacement.refresh_token(), "new_refresh");
        assert_eq!(replacement.workos_user_id(), "user_owner");
        assert_eq!(replacement.session_id(), "session_owner");
    }

    #[test]
    fn replacement_refresh_credential_preserves_unverified_continuation_state() {
        let current = StoredCredential::continuation(
            "old_refresh".into(),
            "user_owner".into(),
            "2026-07-29T00:00:00Z".into(),
        )
        .unwrap();
        let replacement = replacement_credential(&current, "new_refresh".into())
            .ok()
            .unwrap();
        assert_eq!(replacement.refresh_token(), "new_refresh");
        assert_eq!(replacement.workos_user_id(), "user_owner");
        assert!(replacement.is_continuation());
    }

    #[test]
    fn every_lone_credential_is_eligible_for_profileless_resume() {
        let store = Arc::new(MemoryCredentialStore::new(false));
        let controller = CloudAuthController::new(store.clone()).unwrap();
        assert!(matches!(
            controller.has_stored_credential("user_owner"),
            Ok(false)
        ));
        let verified = StoredCredential::new(
            "verified_refresh".into(),
            "user_owner".into(),
            "session_owner".into(),
            "2026-07-29T00:00:00Z".into(),
        )
        .unwrap();
        store.store(WORKTABLE_CLOUD_ORIGIN, &verified).unwrap();
        assert!(matches!(
            controller.has_stored_credential("user_owner"),
            Ok(true)
        ));
        assert_eq!(
            controller
                .stored_profileless_user_id()
                .ok()
                .flatten()
                .as_deref(),
            Some("user_owner")
        );

        let continuation = StoredCredential::continuation(
            "continuation_refresh".into(),
            "user_owner".into(),
            "2026-07-29T00:01:00Z".into(),
        )
        .unwrap();
        store.store(WORKTABLE_CLOUD_ORIGIN, &continuation).unwrap();
        assert_eq!(
            controller
                .stored_profileless_user_id()
                .ok()
                .flatten()
                .as_deref(),
            Some("user_owner")
        );
    }

    #[test]
    fn rejected_credential_cleanup_propagates_keychain_removal_failure() {
        let store = Arc::new(MemoryCredentialStore::with_failures(false, true));
        let credential = StoredCredential::new(
            "rejected_refresh".into(),
            "user_owner".into(),
            "session_owner".into(),
            "2026-07-29T00:00:00Z".into(),
        )
        .unwrap();
        store.store(WORKTABLE_CLOUD_ORIGIN, &credential).unwrap();
        let controller = CloudAuthController::new(store.clone()).unwrap();
        let error = controller.discard_rejected_credential(
            "user_owner",
            CloudAuthError::new("UNAUTHORIZED", "Rejected", false, true),
        );
        assert_eq!(error.code, "CREDENTIAL_STORE_FAILED");
        assert!(!error.retryable);
        assert!(
            !error.clears_credential,
            "a caller must not clear a different remembered profile identity"
        );
        assert!(store
            .load(WORKTABLE_CLOUD_ORIGIN, "user_owner")
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn origin_scoped_cleanup_removes_an_unexpected_profileless_identity() {
        let store = Arc::new(MemoryCredentialStore::new(false));
        let unexpected = StoredCredential::new(
            "unexpected_refresh".into(),
            "user_unexpected".into(),
            "session_unexpected".into(),
            "2026-07-29T00:00:00Z".into(),
        )
        .unwrap();
        store.store(WORKTABLE_CLOUD_ORIGIN, &unexpected).unwrap();
        let controller = CloudAuthController::new(store.clone()).unwrap();

        controller.clear_all_local().await.unwrap();

        assert!(store
            .load(WORKTABLE_CLOUD_ORIGIN, "user_unexpected")
            .unwrap()
            .is_none());
    }
}
