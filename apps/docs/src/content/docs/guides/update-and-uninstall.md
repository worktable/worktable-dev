---
title: Updates
description: Update Worktable, upgrade workspace storage, or remove the installation.
---

These controls apply to Desktop, local and self-hosted Worktable. Worktable
Cloud updates automatically.

## Update Desktop

Desktop checks for signed releases at startup and every six hours, even with
its window closed. It downloads updates in the background and installs them
when you quit, or right away when you restart to update.

- With a local workspace open, **Settings → System → Software update** shows
  progress and **Restart to update**.
- **Worktable → Check for Updates…** checks now. When an update is ready, it
  reads **Restart to Update…**.

If updating needs an administrator password, quitting won't install it; restart
to update instead. If installation fails, Desktop keeps the current app and
offers the signed DMG. If **Check for Updates…** is missing, install the latest
DMG once.

Desktop only installs a release that is still offered, and keeps the current
app if it can't reach the release server. Updates keep workspace files, saved
connections and local settings. A local host Desktop started stops for the
restart; a CLI or managed service keeps running. See the
[Desktop reference](/reference/desktop/).

## Update a service

For a local or self-hosted service, open **Settings → System → Software update**.
It checks for a release, downloads it and restarts into it. You can keep
working until the restart. A dot on **Settings** shows when an update is
available.

## CLI updates

```sh
worktable update --check   # is there a newer release?
worktable update           # download and switch to it
worktable update v0.1.23   # install a particular version
```

`worktable status` also reports available updates. Turn off
**Check for updates automatically** in **Settings → System**, or see the
[configuration reference](/reference/configuration/) for managed installs.

If Worktable can't reach the release server, the installed version stays in
place. When releases are paused, no new version is offered.

## Release channels

A local or self-hosted service follows **stable**. To try changes early,
switch to **beta**:

```sh
worktable update --channel beta     # follow beta and update now
worktable update --channel stable   # return to stable releases
```

Beta builds come from every change to the
[public source](https://github.com/worktable/worktable-dev), are versioned like
`0.1.24-dev.131+8737f53`, and are published for Linux x64. They are tested but
not released, so expect rough edges. On beta you get the newest beta or stable
release, whichever is newer. After switching back, you keep your beta until a
newer stable release ships.

**Settings → System → About** shows the channel and commit.

Desktop follows stable unless you turn on **Settings → System → Beta updates**,
or **Worktable → Beta Updates** with a self-hosted or Cloud connection. Turning
beta off drops a beta update that isn't installed yet.

See [What's new](/whats-new/) for release notes.

## Workspace upgrades

Since 0.1.13, an older workspace upgrades automatically when the updated server
starts. You don't need to export or import.

While it runs you see **Upgrading your workspace**, and editing and agents
wait. A large workspace can take several minutes. It only happens once.

Documents, history and share links are kept. Annotations on documents that no
longer exist are not carried over.

The original workspace is kept as a rollback copy beside the workspace folder.
It contains private data; keep it until you've checked the upgraded workspace.

If you see **Workspace upgrade needs attention**, the owner should check the
server logs, fix the issue and choose **Retry upgrade**. Don't run an older
release against upgraded files; rolling back needs the original copy.

## Uninstall

```sh
worktable uninstall
```

The command lists what it will remove (launcher, releases, app data, shell
completions, managed agent registrations and installed skills) and asks you to
confirm. Use `--yes` to skip the prompt. Skill files you changed are kept.

Your workspace folder stays, so a later installation can reopen it. To delete
it too:

```sh
worktable uninstall --purge
```

Export anything you need first and check the paths shown. Worktable history
cannot recover a purged workspace.

To remove Desktop, quit it and delete it from Applications. This doesn't delete
your workspace folder. To cancel Cloud, see [Cloud account](/guides/cloud-account/).
