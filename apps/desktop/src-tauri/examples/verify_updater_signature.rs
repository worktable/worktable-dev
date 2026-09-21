use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};
use std::{env, fs, path::PathBuf, process};

fn verify_signature(
    bundle: &[u8],
    encoded_signature: &str,
    encoded_public_key: &str,
) -> Result<(), String> {
    // Tauri stores both the complete Minisign public-key document and detached
    // signature document as base64. Decode and verify them exactly as the
    // updater plugin will before accepting an installation.
    let public_key_document = STANDARD
        .decode(encoded_public_key.trim())
        .map_err(|error| format!("updater public key is not valid base64: {error}"))?;
    let public_key_document = std::str::from_utf8(&public_key_document)
        .map_err(|error| format!("updater public key is not UTF-8: {error}"))?;
    let public_key = PublicKey::decode(public_key_document)
        .map_err(|error| format!("updater public key is invalid: {error}"))?;

    let signature_document = STANDARD
        .decode(encoded_signature.trim())
        .map_err(|error| format!("updater signature is not valid base64: {error}"))?;
    let signature_document = std::str::from_utf8(&signature_document)
        .map_err(|error| format!("updater signature is not UTF-8: {error}"))?;
    let signature = Signature::decode(signature_document)
        .map_err(|error| format!("updater signature is invalid: {error}"))?;

    public_key
        .verify(bundle, &signature, true)
        .map_err(|error| format!("updater signature verification failed: {error}"))
}

fn run() -> Result<(), String> {
    let mut arguments = env::args_os().skip(1);
    let bundle_path = arguments
        .next()
        .map(PathBuf::from)
        .ok_or_else(|| "updater bundle path is required".to_string())?;
    let signature_path = arguments
        .next()
        .map(PathBuf::from)
        .ok_or_else(|| "updater signature path is required".to_string())?;
    if arguments.next().is_some() {
        return Err("unexpected updater signature verifier argument".into());
    }

    let encoded_public_key = env::var("WORKTABLE_UPDATER_PUBLIC_KEY")
        .map_err(|_| "WORKTABLE_UPDATER_PUBLIC_KEY is required".to_string())?;
    let encoded_signature = fs::read_to_string(&signature_path).map_err(|error| {
        format!(
            "failed to read updater signature {}: {error}",
            signature_path.display()
        )
    })?;
    let bundle = fs::read(&bundle_path).map_err(|error| {
        format!(
            "failed to read updater bundle {}: {error}",
            bundle_path.display()
        )
    })?;
    verify_signature(&bundle, &encoded_signature, &encoded_public_key)?;
    println!(
        "Verified Desktop updater signature for {}",
        bundle_path.display()
    );
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PUBLIC_KEY_DOCUMENT: &str = "untrusted comment: minisign public key E7620F1842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    const SIGNATURE_DOCUMENT: &str = "untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==";

    #[test]
    fn verifies_tauri_encoded_minisign_documents() {
        let encoded_public_key = STANDARD.encode(PUBLIC_KEY_DOCUMENT);
        let encoded_signature = STANDARD.encode(SIGNATURE_DOCUMENT);
        verify_signature(b"test", &encoded_signature, &encoded_public_key).unwrap();
        assert!(verify_signature(b"tampered", &encoded_signature, &encoded_public_key).is_err());
    }
}
