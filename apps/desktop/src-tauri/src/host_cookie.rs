use tauri::{webview::Cookie, Webview};

#[cfg(target_os = "macos")]
const LEGACY_COOKIE_PURGE_VALUE: &str = "worktable-desktop-cookie-purge";

#[cfg(target_os = "macos")]
enum NativeCookiePersistence {
    ProcessLocal,
    LegacyPurgeMarker,
}

#[cfg(target_os = "macos")]
fn native_host_only_cookie(
    origin: &str,
    name: &str,
    value: &str,
    path: &str,
    persistence: NativeCookiePersistence,
) -> Result<objc2::rc::Retained<objc2_foundation::NSHTTPCookie>, String> {
    use objc2::{rc::Retained, runtime::AnyObject};
    use objc2_foundation::{
        NSHTTPCookie, NSHTTPCookieDiscard, NSHTTPCookieMaximumAge, NSHTTPCookieName,
        NSHTTPCookieOriginURL, NSHTTPCookiePath, NSHTTPCookiePropertyKey, NSHTTPCookieSecure,
        NSHTTPCookieValue, NSHTTPCookieVersion, NSMutableDictionary, NSString,
    };

    let origin = NSString::from_str(origin);
    let name = NSString::from_str(name);
    let value = NSString::from_str(value);
    let path = NSString::from_str(path);
    // SAFETY: the Foundation cookie property keys are immutable process-wide
    // constants, and every value is retained by the dictionary.
    let properties: Retained<NSMutableDictionary<NSHTTPCookiePropertyKey, AnyObject>> = unsafe {
        NSMutableDictionary::from_slices(
            &[
                NSHTTPCookieName,
                NSHTTPCookieValue,
                NSHTTPCookiePath,
                NSHTTPCookieOriginURL,
            ],
            &[&name, &value, &path, &origin],
        )
    };
    let version = NSString::from_str("1");
    let truth = NSString::from_str("TRUE");
    let maximum_age = NSString::from_str("60");
    let http_only = NSString::from_str("HttpOnly");
    let same_site = NSString::from_str("SameSite");
    let lax = NSString::from_str("lax");
    // SAFETY: the Foundation cookie property keys are immutable process-wide
    // constants, and the dictionary retains all inserted values.
    unsafe {
        properties.insert(NSHTTPCookieVersion, &*version);
        properties.insert(NSHTTPCookieSecure, &*truth);
        match persistence {
            NativeCookiePersistence::ProcessLocal => {
                properties.insert(NSHTTPCookieDiscard, &*truth);
            }
            NativeCookiePersistence::LegacyPurgeMarker => {
                properties.insert(NSHTTPCookieMaximumAge, &*maximum_age);
            }
        }
    }
    properties.insert(&*http_only, &*truth);
    properties.insert(&*same_site, &*lax);

    // SAFETY: all required NSHTTPCookie properties are retained by the
    // dictionary for the duration of the native constructor call.
    let native_cookie = unsafe { NSHTTPCookie::cookieWithProperties(&properties) }
        .ok_or_else(|| "WebKit rejected the host-only Desktop cookie".to_string())?;
    match persistence {
        // Max-Age remains host-owned renewal metadata. Giving it to WebKit
        // makes the credential persistent in the app's binary cookie store.
        NativeCookiePersistence::ProcessLocal
            if !native_cookie.isSessionOnly() || native_cookie.expiresDate().is_some() =>
        {
            Err("WebKit did not create a session-only Desktop cookie".into())
        }
        NativeCookiePersistence::LegacyPurgeMarker
            if native_cookie.isSessionOnly() || native_cookie.expiresDate().is_none() =>
        {
            Err("WebKit did not create the Desktop cookie cleanup marker".into())
        }
        _ => Ok(native_cookie),
    }
}

#[cfg(target_os = "macos")]
fn native_session_cookie(
    origin: &str,
    name: &str,
    value: &str,
    path: &str,
) -> Result<objc2::rc::Retained<objc2_foundation::NSHTTPCookie>, String> {
    native_host_only_cookie(
        origin,
        name,
        value,
        path,
        NativeCookiePersistence::ProcessLocal,
    )
}

#[cfg(target_os = "macos")]
fn native_legacy_cookie_tombstone(
    origin: &str,
    name: &str,
    path: &str,
) -> Result<objc2::rc::Retained<objc2_foundation::NSHTTPCookie>, String> {
    native_host_only_cookie(
        origin,
        name,
        LEGACY_COOKIE_PURGE_VALUE,
        path,
        NativeCookiePersistence::LegacyPurgeMarker,
    )
}

#[cfg(target_os = "macos")]
pub fn set_host_only_cookie(
    webview: &Webview,
    origin: &tauri::Url,
    cookie: Cookie<'static>,
) -> Result<(), String> {
    use block2::RcBlock;
    use cookie::SameSite;
    use objc2_web_kit::WKWebView;
    use std::sync::mpsc;

    if origin.scheme() != "https"
        || origin.host_str().is_none()
        || origin.username() != ""
        || origin.password().is_some()
        || origin.port().is_some()
        || cookie.name() != "wt_session"
        || cookie.path() != Some("/")
        || cookie.domain().is_some()
        || cookie.http_only() != Some(true)
        || cookie.secure() != Some(true)
        || cookie.same_site() != Some(SameSite::Lax)
    {
        return Err("Desktop session cookie origin or attributes are invalid".into());
    }
    cookie
        .max_age()
        .map(|age| age.whole_seconds())
        .filter(|seconds| *seconds > 0)
        .ok_or_else(|| "Desktop session cookie lifetime is invalid".to_string())?;
    let origin = origin.as_str().to_string();
    let name = cookie.name().to_string();
    let value = cookie.value().to_string();
    let path = cookie.path().unwrap_or("/").to_string();
    let (sender, receiver) = mpsc::channel::<Result<(), String>>();

    webview
        // SAFETY: Tauri exposes a WKWebView from this macOS-only callback.
        // Every Objective-C value is retained for the native call, and the
        // completion block owns the sender until WebKit finishes the insert.
        .with_webview(move |platform| unsafe {
            let view: &WKWebView = &*platform.inner().cast();
            let native_cookie = match native_session_cookie(&origin, &name, &value, &path) {
                Ok(cookie) => cookie,
                Err(message) => {
                    let _ = sender.send(Err(message));
                    return;
                }
            };
            let store = view.configuration().websiteDataStore().httpCookieStore();
            store.setCookie_completionHandler(
                &native_cookie,
                Some(&RcBlock::new(move || {
                    let _ = sender.send(Ok(()));
                })),
            );
        })
        .map_err(|error| format!("failed to access the Desktop WebKit cookie store: {error}"))?;

    // Do not release the caller's serialized cookie-operation lock while a
    // native write can still complete. WKHTTPCookieStore has no cancellation
    // primitive, so a timeout here could let sign-out delete the old cookie
    // before this pending write installs a new one.
    receiver
        .recv()
        .map_err(|_| "WebKit did not confirm the Desktop session cookie".to_string())?
}

#[cfg(target_os = "macos")]
pub fn purge_persisted_host_only_cookie(
    webview: &Webview,
    origin: &tauri::Url,
    name: &str,
) -> Result<(), String> {
    use block2::RcBlock;
    use objc2_web_kit::WKWebView;
    use std::sync::mpsc;

    if origin.scheme() != "https"
        || origin.host_str().is_none()
        || origin.username() != ""
        || origin.password().is_some()
        || origin.port().is_some()
        || name != "wt_session"
    {
        return Err("Desktop cookie cleanup origin or name is invalid".into());
    }
    let origin = origin.as_str().to_string();
    let name = name.to_string();

    // WebKit does not enumerate an expired persistent cookie, even while its
    // credential value remains in the binary cookie file. Replace that exact
    // host/name/path identity with a non-secret persistent tombstone first.
    let (set_sender, set_receiver) = mpsc::channel::<Result<(), String>>();
    let set_origin = origin.clone();
    let set_name = name.clone();
    webview
        // SAFETY: Tauri exposes a WKWebView from this macOS-only callback.
        .with_webview(move |platform| unsafe {
            let view: &WKWebView = &*platform.inner().cast();
            let tombstone = match native_legacy_cookie_tombstone(&set_origin, &set_name, "/") {
                Ok(cookie) => cookie,
                Err(message) => {
                    let _ = set_sender.send(Err(message));
                    return;
                }
            };
            let store = view.configuration().websiteDataStore().httpCookieStore();
            store.setCookie_completionHandler(
                &tombstone,
                Some(&RcBlock::new(move || {
                    let _ = set_sender.send(Ok(()));
                })),
            );
        })
        .map_err(|error| format!("failed to access the Desktop WebKit cookie store: {error}"))?;
    set_receiver
        .recv()
        .map_err(|_| "WebKit did not confirm the Desktop cookie cleanup marker".to_string())??;

    let (delete_sender, delete_receiver) = mpsc::channel::<Result<(), String>>();
    webview
        // SAFETY: the rebuilt cookie has the same host/name/path identity as
        // the persisted tombstone written above.
        .with_webview(move |platform| unsafe {
            let view: &WKWebView = &*platform.inner().cast();
            let tombstone = match native_legacy_cookie_tombstone(&origin, &name, "/") {
                Ok(cookie) => cookie,
                Err(message) => {
                    let _ = delete_sender.send(Err(message));
                    return;
                }
            };
            let store = view.configuration().websiteDataStore().httpCookieStore();
            store.deleteCookie_completionHandler(
                &tombstone,
                Some(&RcBlock::new(move || {
                    let _ = delete_sender.send(Ok(()));
                })),
            );
        })
        .map_err(|error| format!("failed to access the Desktop WebKit cookie store: {error}"))?;
    delete_receiver
        .recv()
        .map_err(|_| "WebKit did not confirm persisted Desktop cookie cleanup".to_string())?
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::{native_legacy_cookie_tombstone, native_session_cookie, LEGACY_COOKIE_PURGE_VALUE};

    #[test]
    fn native_cloud_cookie_is_process_local() {
        let cookie =
            native_session_cookie("https://staging.example.test", "wt_session", "sealed", "/")
                .unwrap();

        assert!(cookie.isSessionOnly());
        assert!(cookie.expiresDate().is_none());
        assert!(cookie.isSecure());
        assert!(cookie.isHTTPOnly());
        assert_eq!(cookie.name().to_string(), "wt_session");
        assert_eq!(cookie.path().to_string(), "/");
        assert_eq!(cookie.domain().to_string(), "staging.example.test");
    }

    #[test]
    fn legacy_cookie_tombstone_contains_no_credential() {
        let cookie =
            native_legacy_cookie_tombstone("https://staging.example.test", "wt_session", "/")
                .unwrap();

        assert!(!cookie.isSessionOnly());
        assert!(cookie.expiresDate().is_some());
        assert!(cookie.isSecure());
        assert!(cookie.isHTTPOnly());
        assert_eq!(cookie.value().to_string(), LEGACY_COOKIE_PURGE_VALUE);
    }
}

#[cfg(not(target_os = "macos"))]
pub fn set_host_only_cookie(
    _webview: &Webview,
    _origin: &tauri::Url,
    _cookie: Cookie<'static>,
) -> Result<(), String> {
    Err("host-only Desktop session cookies require macOS WebKit".into())
}

#[cfg(not(target_os = "macos"))]
pub fn purge_persisted_host_only_cookie(
    _webview: &Webview,
    _origin: &tauri::Url,
    _name: &str,
) -> Result<(), String> {
    Err("persisted Desktop session cookie cleanup requires macOS WebKit".into())
}
