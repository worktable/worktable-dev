fn main() {
    println!("cargo:rerun-if-env-changed=WORKTABLE_DESKTOP_STAGING_ORIGIN");
    if std::env::var_os("CARGO_FEATURE_STAGING").is_some() {
        let origin = std::env::var("WORKTABLE_DESKTOP_STAGING_ORIGIN")
            .expect("Staging builds require WORKTABLE_DESKTOP_STAGING_ORIGIN");
        let url = url::Url::parse(&origin).expect("Staging origin must be an HTTPS origin");
        assert!(
            url.scheme() == "https"
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
                && url.path() == "/"
                && url.query().is_none()
                && url.fragment().is_none()
                && url.origin().ascii_serialization() == origin
                && url.host_str().unwrap().trim_end_matches('.') != "app.worktable.cloud",
            "Staging origin must be a canonical HTTPS origin distinct from production"
        );
    }

    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "desktop_shell_identity",
            "desktop_agent_skills_status",
            "desktop_agent_skills_preview",
            "desktop_agent_skills_apply",
            "desktop_bootstrap_state",
            "desktop_updater_state",
            "desktop_mark_shell_ready",
            "desktop_check_for_updates",
            "desktop_install_update",
            "desktop_dismiss_update",
            "desktop_open_update_download",
            "desktop_select_connection_provider",
            "desktop_start_cloud_connection",
            "desktop_cancel_cloud_connection",
            "desktop_start_self_hosted_connection",
            "desktop_start_saved_connection",
            "desktop_choose_workspace_folder",
            "desktop_inspect_workspace",
            "desktop_start_local_connection",
            "desktop_use_existing_installation",
            "desktop_retry_connection",
            "desktop_restart_local_host",
            "desktop_repair_local_authority",
            "desktop_open_local_logs",
            "desktop_change_connection",
            "desktop_cloud_sign_out",
            "desktop_cloud_end_session",
            "desktop_remove_connection",
        ]),
    ))
    .expect("failed to build Worktable Desktop metadata");
}
