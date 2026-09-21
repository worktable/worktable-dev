use crate::cloud_auth::WORKTABLE_CLOUD_ORIGIN;
use reqwest::{
    header::{ACCEPT, COOKIE, ORIGIN},
    redirect::Policy,
    Client, Response, StatusCode,
};
use serde::Deserialize;
use std::{net::IpAddr, time::Duration};
use url::Url;

pub const DESKTOP_CONNECTION_PROTOCOL_VERSION: u8 = 1;
const MAX_REMOTE_RESPONSE_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteConnectionError {
    pub code: &'static str,
    pub message: String,
    pub transient: bool,
}

impl RemoteConnectionError {
    fn permanent(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            transient: false,
        }
    }

    fn transient(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            transient: true,
        }
    }
}

impl std::fmt::Display for RemoteConnectionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct DesktopConnectionMarker {
    protocol_version: u8,
    provider: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteHealthPayload {
    ok: bool,
    service: String,
    desktop_connection: Option<DesktopConnectionMarker>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct RemoteWorkspace {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WorkspaceProbe {
    Ready(RemoteWorkspace),
    AuthenticationRequired,
}

#[derive(Debug, PartialEq, Eq)]
enum ResponseBodyError {
    Transport,
    TooLarge,
    InvalidJson,
}

impl std::fmt::Display for ResponseBodyError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Transport => "response body could not be read",
            Self::TooLarge => "response exceeded the 1 MiB limit",
            Self::InvalidJson => "response body was not valid JSON",
        })
    }
}

#[derive(Clone)]
pub struct RemoteHttpClient {
    client: Client,
}

impl RemoteHttpClient {
    pub fn new() -> Result<Self, String> {
        let client = Client::builder()
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(10))
            .user_agent(concat!("Worktable-Desktop/", env!("CARGO_PKG_VERSION")))
            .tls_backend_rustls()
            .build()
            .map_err(|error| format!("failed to initialize remote HTTP client: {error}"))?;
        Ok(Self { client })
    }

    pub async fn verify_service(&self, origin: &Url) -> Result<(), RemoteConnectionError> {
        let url = origin.join("/health").map_err(|error| {
            RemoteConnectionError::permanent(
                "REMOTE_ORIGIN_INVALID",
                format!("Could not build the Worktable health URL: {error}"),
            )
        })?;
        let response = self
            .client
            .get(url.clone())
            .header(ACCEPT, "application/json")
            .send()
            .await
            .map_err(|error| request_error(&url, error))?;
        reject_health_status(&response)?;
        let payload: RemoteHealthPayload = read_bounded_json(response).await.map_err(|error| {
            classify_response_body_error(
                error,
                "REMOTE_NOT_WORKTABLE",
                "That address did not return a valid Worktable health response.",
            )
        })?;
        validate_health_payload(payload)
    }

    pub async fn probe_workspace(
        &self,
        origin: &Url,
        session_cookie: Option<&str>,
    ) -> Result<WorkspaceProbe, RemoteConnectionError> {
        let url = origin.join("/api/workspace").map_err(|error| {
            RemoteConnectionError::permanent(
                "REMOTE_ORIGIN_INVALID",
                format!("Could not build the Worktable workspace URL: {error}"),
            )
        })?;
        let mut request = self
            .client
            .get(url.clone())
            .header(ACCEPT, "application/json");
        if let Some(cookie) = session_cookie {
            request = request.header(COOKIE, session_cookie_header(cookie)?);
        }
        let response = request
            .send()
            .await
            .map_err(|error| request_error(&url, error))?;
        if response.status() == StatusCode::UNAUTHORIZED {
            return Ok(WorkspaceProbe::AuthenticationRequired);
        }
        if response.status() == StatusCode::FORBIDDEN {
            return Err(RemoteConnectionError::permanent(
                "REMOTE_ACCESS_REJECTED",
                "The remote Worktable rejected this Desktop session. Sign in again or check the server's access configuration.",
            ));
        }
        if response.status() == StatusCode::NOT_FOUND {
            return Err(RemoteConnectionError::permanent(
                "REMOTE_API_UNAVAILABLE",
                "The remote server does not expose the Worktable workspace API. Update the server and try again.",
            ));
        }
        reject_redirect_or_status(&response, "workspace")?;
        let workspace: RemoteWorkspace = read_bounded_json(response).await.map_err(|error| {
            classify_response_body_error(
                error,
                "REMOTE_API_UNAVAILABLE",
                "The remote Worktable returned an invalid workspace response.",
            )
        })?;
        if workspace.id.trim().is_empty() || workspace.name.trim().is_empty() {
            return Err(RemoteConnectionError::permanent(
                "REMOTE_API_UNAVAILABLE",
                "The remote Worktable returned an incomplete workspace identity.",
            ));
        }
        Ok(WorkspaceProbe::Ready(workspace))
    }

    pub async fn logout(&self, origin: &Url, session_cookie: Option<&str>) {
        let Ok(url) = origin.join("/auth/logout") else {
            return;
        };
        let mut request = self
            .client
            .post(url)
            .header(ORIGIN, remote_origin_string(origin))
            .header(ACCEPT, "application/json");
        if let Some(cookie) = session_cookie {
            let Ok(value) = session_cookie_header(cookie) else {
                return;
            };
            request = request.header(COOKIE, value);
        }
        let _ = request.send().await;
    }
}

fn validate_health_payload(payload: RemoteHealthPayload) -> Result<(), RemoteConnectionError> {
    if !payload.ok || payload.service != "worktable" {
        return Err(RemoteConnectionError::permanent(
            "REMOTE_NOT_WORKTABLE",
            "That address is not a Worktable server.",
        ));
    }
    let marker = payload.desktop_connection.ok_or_else(|| {
        RemoteConnectionError::permanent(
            "REMOTE_PROTOCOL_UNSUPPORTED",
            "This Worktable server is too old for Desktop connections. Update the remote server and try again.",
        )
    })?;
    if marker.protocol_version != DESKTOP_CONNECTION_PROTOCOL_VERSION {
        return Err(RemoteConnectionError::permanent(
            "REMOTE_PROTOCOL_UNSUPPORTED",
            "This Worktable server uses an unsupported Desktop connection protocol. Update Worktable Desktop and the remote server.",
        ));
    }
    if marker.provider != "selfHosted" {
        return Err(RemoteConnectionError::permanent(
            "REMOTE_PROVIDER_MISMATCH",
            "This address belongs to Worktable Cloud. Use the separate Worktable Cloud connection when it becomes available.",
        ));
    }
    Ok(())
}

pub fn normalize_remote_origin(input: &str) -> Result<Url, RemoteConnectionError> {
    let trimmed = input.trim();
    let url = Url::parse(trimmed).map_err(|_| {
        RemoteConnectionError::permanent(
            "REMOTE_ORIGIN_INVALID",
            "Enter a complete Worktable address beginning with https:// or http://.",
        )
    })?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(RemoteConnectionError::permanent(
            "REMOTE_ORIGIN_INVALID",
            "The Worktable address must use https:// or http://.",
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(RemoteConnectionError::permanent(
            "REMOTE_ORIGIN_INVALID",
            "The Worktable address cannot contain a username or password.",
        ));
    }
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err(RemoteConnectionError::permanent(
            "REMOTE_ORIGIN_INVALID",
            "Enter the Worktable origin only, without a path, query, or fragment.",
        ));
    }
    let host = url.host_str().ok_or_else(|| {
        RemoteConnectionError::permanent(
            "REMOTE_ORIGIN_INVALID",
            "The Worktable address must include a host.",
        )
    })?;
    if host.contains('*') {
        return Err(RemoteConnectionError::permanent(
            "REMOTE_ORIGIN_INVALID",
            "The Worktable address cannot contain a wildcard host.",
        ));
    }
    let ip_candidate = host.trim_start_matches('[').trim_end_matches(']');
    if ip_candidate
        .parse::<IpAddr>()
        .is_ok_and(|address| address.is_unspecified())
    {
        return Err(RemoteConnectionError::permanent(
            "REMOTE_ORIGIN_INVALID",
            "Use a reachable hostname or address instead of an unspecified bind address.",
        ));
    }
    let canonical = Url::parse(&url.origin().ascii_serialization()).map_err(|error| {
        RemoteConnectionError::permanent(
            "REMOTE_ORIGIN_INVALID",
            format!("Could not normalize the Worktable address: {error}"),
        )
    })?;
    if canonical.as_str().trim_end_matches('/') == WORKTABLE_CLOUD_ORIGIN {
        return Err(RemoteConnectionError::permanent(
            "REMOTE_PROVIDER_MISMATCH",
            "Worktable Cloud uses its native sign-in connection.",
        ));
    }
    Ok(canonical)
}

pub fn validate_remote_origin(
    input: &str,
    allow_insecure_http: bool,
) -> Result<Url, RemoteConnectionError> {
    let origin = normalize_remote_origin(input)?;
    if origin.scheme() == "http" && !allow_insecure_http {
        return Err(RemoteConnectionError::permanent(
            "INSECURE_HTTP_CONFIRMATION_REQUIRED",
            "Confirm that you understand this HTTP connection is not encrypted.",
        ));
    }
    Ok(origin)
}

pub fn remote_origin_string(origin: &Url) -> String {
    origin.origin().ascii_serialization()
}

pub fn session_cookie_header(cookie_value: &str) -> Result<String, RemoteConnectionError> {
    if cookie_value.is_empty()
        || cookie_value
            .bytes()
            .any(|byte| byte <= 0x20 || byte == 0x7f || matches!(byte, b';' | b','))
    {
        return Err(RemoteConnectionError::permanent(
            "REMOTE_SESSION_READ_FAILED",
            "Desktop could not read a valid Worktable session cookie.",
        ));
    }
    Ok(format!("wt_session={cookie_value}"))
}

fn request_error(url: &Url, error: reqwest::Error) -> RemoteConnectionError {
    let detail = error.to_string().to_ascii_lowercase();
    if url.scheme() == "https"
        && ["certificate", "tls", "ssl", "unknown issuer"]
            .iter()
            .any(|needle| detail.contains(needle))
    {
        RemoteConnectionError::permanent(
            "REMOTE_TLS_FAILED",
            "Desktop could not verify the server certificate. Use a certificate trusted by this Mac; certificate bypass is not supported.",
        )
    } else {
        RemoteConnectionError::transient(
            "REMOTE_UNREACHABLE",
            "Desktop could not reach that Worktable server. Check the address and network, then try again.",
        )
    }
}

fn reject_redirect_or_status(
    response: &Response,
    endpoint: &str,
) -> Result<(), RemoteConnectionError> {
    classify_endpoint_status(response.status(), endpoint)
}

fn classify_endpoint_status(
    status: StatusCode,
    endpoint: &str,
) -> Result<(), RemoteConnectionError> {
    if status.is_redirection() {
        return Err(RemoteConnectionError::permanent(
            "REMOTE_REDIRECTED",
            "The Worktable address redirected to another origin. Enter the canonical origin directly.",
        ));
    }
    if status.is_server_error() {
        return Err(RemoteConnectionError::transient(
            "REMOTE_UNREACHABLE",
            format!("The remote Worktable {endpoint} service is temporarily unavailable."),
        ));
    }
    if !status.is_success() {
        return Err(RemoteConnectionError::permanent(
            "REMOTE_API_UNAVAILABLE",
            format!("The remote Worktable {endpoint} request failed with status {status}."),
        ));
    }
    Ok(())
}

fn reject_health_status(response: &Response) -> Result<(), RemoteConnectionError> {
    classify_health_status(response.status())
}

fn classify_health_status(status: StatusCode) -> Result<(), RemoteConnectionError> {
    if status.is_redirection() {
        return Err(RemoteConnectionError::permanent(
            "REMOTE_REDIRECTED",
            "The Worktable address redirected to another origin. Enter the canonical origin directly.",
        ));
    }
    if status.is_server_error() {
        return Err(RemoteConnectionError::transient(
            "REMOTE_UNREACHABLE",
            "The remote Worktable health service is temporarily unavailable.",
        ));
    }
    if !status.is_success() {
        return Err(RemoteConnectionError::permanent(
            "REMOTE_NOT_WORKTABLE",
            "That address did not expose the public Worktable health marker.",
        ));
    }
    Ok(())
}

fn classify_response_body_error(
    error: ResponseBodyError,
    invalid_code: &'static str,
    invalid_message: &str,
) -> RemoteConnectionError {
    match error {
        ResponseBodyError::Transport => RemoteConnectionError::transient(
            "REMOTE_UNREACHABLE",
            "The remote Worktable response was interrupted. Check the network and try again.",
        ),
        ResponseBodyError::TooLarge | ResponseBodyError::InvalidJson => {
            RemoteConnectionError::permanent(invalid_code, format!("{invalid_message} {error}"))
        }
    }
}

async fn read_bounded_json<T: for<'de> Deserialize<'de>>(
    mut response: Response,
) -> Result<T, ResponseBodyError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_REMOTE_RESPONSE_BYTES as u64)
    {
        return Err(ResponseBodyError::TooLarge);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| ResponseBodyError::Transport)?
    {
        append_bounded_response_chunk(&mut bytes, chunk.as_ref())?;
    }
    serde_json::from_slice(&bytes).map_err(|_| ResponseBodyError::InvalidJson)
}

fn append_bounded_response_chunk(
    bytes: &mut Vec<u8>,
    chunk: &[u8],
) -> Result<(), ResponseBodyError> {
    if bytes.len().saturating_add(chunk.len()) > MAX_REMOTE_RESPONSE_BYTES {
        return Err(ResponseBodyError::TooLarge);
    }
    bytes.extend_from_slice(chunk);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_supported_origins() {
        for (input, expected) in [
            (" https://Example.COM/ ", "https://example.com/"),
            (
                "https://BÜCHER.example:443",
                "https://xn--bcher-kva.example/",
            ),
            ("http://localhost:9000", "http://localhost:9000/"),
            ("https://127.0.0.1:443/", "https://127.0.0.1/"),
            ("http://[::1]:8080", "http://[::1]:8080/"),
        ] {
            assert_eq!(normalize_remote_origin(input).unwrap().as_str(), expected);
        }
    }

    #[test]
    fn rejects_unsafe_or_non_origin_inputs() {
        for input in [
            "example.com",
            "ftp://example.com",
            "https://user:pass@example.com",
            "https://example.com/path",
            "https://example.com/?q=1",
            "https://example.com/#fragment",
            "https://*.example.com",
            "http://0.0.0.0:9000",
            "http://[::]:9000",
            WORKTABLE_CLOUD_ORIGIN,
        ] {
            assert!(normalize_remote_origin(input).is_err(), "accepted {input}");
        }
    }

    #[test]
    fn requires_http_acknowledgement() {
        assert_eq!(
            validate_remote_origin("http://localhost:9000", false)
                .unwrap_err()
                .code,
            "INSECURE_HTTP_CONFIRMATION_REQUIRED"
        );
        assert!(validate_remote_origin("http://localhost:9000", true).is_ok());
        assert!(validate_remote_origin("https://example.com", false).is_ok());
    }

    #[test]
    fn builds_only_the_worktable_session_cookie() {
        assert_eq!(
            session_cookie_header("signed.value").unwrap(),
            "wt_session=signed.value"
        );
        for invalid in ["", "bad;cookie", "bad\nvalue", "bad value"] {
            assert!(session_cookie_header(invalid).is_err());
        }
    }

    #[test]
    fn canonical_origin_normalization_is_idempotent_across_ports() {
        for port in [1, 80, 443, 1024, 17480, 65535] {
            let input = format!("https://EXAMPLE.test:{port}/");
            let first = normalize_remote_origin(&input).unwrap();
            let second = normalize_remote_origin(&remote_origin_string(&first)).unwrap();
            assert_eq!(first, second);
        }
    }

    #[test]
    fn validates_health_protocol_and_provider_markers() {
        let payload = |protocol_version, provider: &str| RemoteHealthPayload {
            ok: true,
            service: "worktable".into(),
            desktop_connection: Some(DesktopConnectionMarker {
                protocol_version,
                provider: provider.into(),
            }),
        };
        assert!(validate_health_payload(payload(1, "selfHosted")).is_ok());
        assert_eq!(
            validate_health_payload(payload(2, "selfHosted"))
                .unwrap_err()
                .code,
            "REMOTE_PROTOCOL_UNSUPPORTED"
        );
        assert_eq!(
            validate_health_payload(payload(1, "cloud"))
                .unwrap_err()
                .code,
            "REMOTE_PROVIDER_MISMATCH"
        );
        assert_eq!(
            validate_health_payload(RemoteHealthPayload {
                ok: true,
                service: "worktable".into(),
                desktop_connection: None,
            })
            .unwrap_err()
            .code,
            "REMOTE_PROTOCOL_UNSUPPORTED"
        );
    }

    #[test]
    fn enforces_the_one_mibibyte_response_limit_across_chunks() {
        let mut bytes = Vec::new();
        append_bounded_response_chunk(&mut bytes, &vec![0; MAX_REMOTE_RESPONSE_BYTES]).unwrap();
        assert!(append_bounded_response_chunk(&mut bytes, &[0]).is_err());
    }

    #[test]
    fn classifies_redirects_and_http_failures_deterministically() {
        for status in [
            StatusCode::MOVED_PERMANENTLY,
            StatusCode::FOUND,
            StatusCode::TEMPORARY_REDIRECT,
            StatusCode::PERMANENT_REDIRECT,
        ] {
            assert_eq!(
                classify_health_status(status).unwrap_err().code,
                "REMOTE_REDIRECTED"
            );
            assert_eq!(
                classify_endpoint_status(status, "workspace")
                    .unwrap_err()
                    .code,
                "REMOTE_REDIRECTED"
            );
        }

        let health_outage = classify_health_status(StatusCode::SERVICE_UNAVAILABLE).unwrap_err();
        assert_eq!(health_outage.code, "REMOTE_UNREACHABLE");
        assert!(health_outage.transient);
        assert_eq!(
            classify_health_status(StatusCode::NOT_FOUND)
                .unwrap_err()
                .code,
            "REMOTE_NOT_WORKTABLE"
        );

        let workspace_outage =
            classify_endpoint_status(StatusCode::BAD_GATEWAY, "workspace").unwrap_err();
        assert_eq!(workspace_outage.code, "REMOTE_UNREACHABLE");
        assert!(workspace_outage.transient);
        assert_eq!(
            classify_endpoint_status(StatusCode::BAD_REQUEST, "workspace")
                .unwrap_err()
                .code,
            "REMOTE_API_UNAVAILABLE"
        );
        assert!(classify_health_status(StatusCode::OK).is_ok());
        assert!(classify_endpoint_status(StatusCode::OK, "workspace").is_ok());
    }

    #[test]
    fn keeps_response_body_transport_failures_transient() {
        let transport = classify_response_body_error(
            ResponseBodyError::Transport,
            "REMOTE_NOT_WORKTABLE",
            "invalid health response",
        );
        assert_eq!(transport.code, "REMOTE_UNREACHABLE");
        assert!(transport.transient);

        for malformed in [ResponseBodyError::TooLarge, ResponseBodyError::InvalidJson] {
            let error = classify_response_body_error(
                malformed,
                "REMOTE_API_UNAVAILABLE",
                "invalid workspace response",
            );
            assert_eq!(error.code, "REMOTE_API_UNAVAILABLE");
            assert!(!error.transient);
        }
    }
}
