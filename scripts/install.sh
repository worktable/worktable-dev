#!/bin/sh
set -eu

usage() {
  cat <<'EOF'
Worktable local installer

Usage:
  curl -fsSL https://worktable.dev/install | sh
  curl -fsSL https://worktable.dev/install | sh -s -- [options]

Options:
  --yes                     Accept installer/setup defaults.
  --no-setup                Install only; do not run worktable setup.
  --background              Configure Worktable as a background service during setup.
  --foreground              Configure manual foreground launch during setup.
  --workspace <path>        Workspace directory for setup.
  --port <port>             Local service port for setup.
  --host <host>             Local bind host for setup. Default: 127.0.0.1.
  --mcp <client-ids>        Comma-separated MCP clients to configure during setup.
  --no-completions          Skip installing shell completion (installed by default).
  --install-dir <dir>       Directory for the worktable launcher.
  --app-dir <dir>           App-private directory for releases and install data.
  --version <version>       Version to install. Default: latest.
  --release-base-url <url>  Base URL for release artifacts. Default: https://worktable.dev/releases.
  --dry-run                 Print resolved target, URLs, and paths without installing.
  --help                    Show this help.

Environment overrides:
  WORKTABLE_INSTALL_DIR
  WORKTABLE_APP_DIR
  WORKTABLE_VERSION
  WORKTABLE_RELEASE_BASE_URL
EOF
}

install_dir=${WORKTABLE_INSTALL_DIR:-}
app_data=${WORKTABLE_APP_DIR:-}
version=${WORKTABLE_VERSION:-latest}
base_url=${WORKTABLE_RELEASE_BASE_URL:-https://worktable.dev/releases}
dry_run=0
yes=0
no_setup=0
setup_mode=
workspace=
port=
host=
mcp_clients=
completions=1

while [ "$#" -gt 0 ]; do
  case "$1" in
    --yes)
      yes=1
      ;;
    --no-setup)
      no_setup=1
      ;;
    --background)
      setup_mode=background
      ;;
    --foreground)
      setup_mode=foreground
      ;;
    --workspace)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--workspace requires a path." >&2
        exit 1
      fi
      workspace=$1
      ;;
    --port)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--port requires a port." >&2
        exit 1
      fi
      port=$1
      ;;
    --host)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--host requires a host." >&2
        exit 1
      fi
      host=$1
      ;;
    --mcp)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--mcp requires comma-separated client ids." >&2
        exit 1
      fi
      mcp_clients=$1
      ;;
    --install-dir)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--install-dir requires a directory." >&2
        exit 1
      fi
      install_dir=$1
      ;;
    --app-dir)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--app-dir requires a directory." >&2
        exit 1
      fi
      app_data=$1
      ;;
    --version)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--version requires a version." >&2
        exit 1
      fi
      version=$1
      ;;
    --release-base-url)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--release-base-url requires a URL." >&2
        exit 1
      fi
      base_url=$1
      ;;
    --dry-run)
      dry_run=1
      ;;
    --completions)
      # Now the default; still accepted so existing automated installs keep working.
      completions=1
      ;;
    --no-completions)
      completions=0
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

os=${WORKTABLE_TEST_OS:-$(uname -s)}
arch=${WORKTABLE_TEST_ARCH:-$(uname -m)}

case "$os:$arch" in
  Darwin:arm64)
    artifact="worktable-darwin-arm64.tar.gz"
    platform="darwin"
    ;;
  Darwin:x86_64)
    artifact="worktable-darwin-x64.tar.gz"
    platform="darwin"
    ;;
  Linux:x86_64)
    artifact="worktable-linux-x64.tar.gz"
    platform="linux"
    ;;
  Linux:aarch64|Linux:arm64)
    artifact="worktable-linux-arm64.tar.gz"
    platform="linux"
    ;;
  *)
    echo "Worktable does not yet provide a local installer for $os/$arch." >&2
    exit 1
    ;;
esac

if [ "${WORKTABLE_TEST_MAP_ONLY:-}" = "1" ]; then
  echo "$artifact"
  exit 0
fi

if [ "$version" = "latest" ]; then
  url="$base_url/latest/$artifact"
else
  url="$base_url/$version/$artifact"
fi

if [ -z "$app_data" ]; then
  if [ "$platform" = "darwin" ]; then
    app_data="$HOME/Library/Application Support/Worktable"
  else
    app_data="${XDG_CONFIG_HOME:-$HOME/.config}/worktable"
  fi
fi

if [ -z "$install_dir" ]; then
  if [ -d /opt/homebrew/bin ] && [ -w /opt/homebrew/bin ]; then
    install_dir=/opt/homebrew/bin
  elif [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
    install_dir=/usr/local/bin
  else
    install_dir="$HOME/.local/bin"
  fi
fi

if [ "$dry_run" = "1" ]; then
  cat <<EOF
Worktable install dry run
OS: $os
Arch: $arch
Artifact: $artifact
Version: $version
Release base URL: $base_url
Download URL: $url
App-private dir: $app_data
Install dir: $install_dir
Run setup: $([ "$no_setup" = "1" ] && echo "no" || echo "yes")
Setup mode: ${setup_mode:-default}
Workspace: ${workspace:-default}
Host: ${host:-default}
Port: ${port:-default}
MCP clients: ${mcp_clients:-default}
Shell completions: $([ "$completions" = "1" ] && echo "yes" || echo "no")
EOF
  exit 0
fi

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/worktable-install.XXXXXX")
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT INT TERM

archive="$tmp_dir/$artifact"
extract_dir="$tmp_dir/extract"
mkdir -p "$extract_dir"

echo "Downloading Worktable from $url"
case "$url" in
  file://*)
    # Local artifact (offline/airgapped install, sandbox labs): no curl needed.
    local_artifact=${url#file://}
    if [ ! -f "$local_artifact" ]; then
      echo "Local release artifact not found: $local_artifact" >&2
      exit 1
    fi
    cp "$local_artifact" "$archive"
    ;;
  *)
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL "$url" -o "$archive"
    elif command -v wget >/dev/null 2>&1; then
      wget -q "$url" -O "$archive"
    else
      echo "Worktable installer requires curl or wget." >&2
      exit 1
    fi
    ;;
esac

tar -xzf "$archive" -C "$extract_dir"

if [ ! -x "$extract_dir/bin/worktable" ]; then
  echo "Downloaded Worktable archive is missing bin/worktable." >&2
  exit 1
fi

if [ ! -d "$extract_dir/web" ]; then
  echo "Downloaded Worktable archive is missing web assets." >&2
  exit 1
fi

installed_version=$version
if [ -f "$extract_dir/manifest.json" ]; then
  parsed_version=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$extract_dir/manifest.json" | head -n 1)
  if [ -n "$parsed_version" ]; then
    installed_version=$parsed_version
  fi
fi

release_dir="$app_data/releases/$installed_version"
staging_dir="$release_dir.tmp.$$"
mkdir -p "$app_data/releases"
rm -rf "$staging_dir"
mv "$extract_dir" "$staging_dir"
chmod +x "$staging_dir/bin/worktable"

if ! WORKTABLE_RELEASE_DIR="$staging_dir" \
  WORKTABLE_STATIC_DIR="$staging_dir/web" \
  WORKTABLE_APP_DIR="$app_data" \
  WORKTABLE_VERSION="$installed_version" \
  "$staging_dir/bin/worktable" --version >/dev/null; then
  echo "Downloaded Worktable binary failed its startup check." >&2
  rm -rf "$staging_dir"
  exit 1
fi

rm -rf "$release_dir"
mv "$staging_dir" "$release_dir"

mkdir -p "$install_dir"
launcher="$install_dir/worktable"
cat > "$launcher" <<EOF
#!/bin/sh
export WORKTABLE_RELEASE_DIR="$release_dir"
export WORKTABLE_STATIC_DIR="$release_dir/web"
export WORKTABLE_APP_DIR="$app_data"
export WORKTABLE_INSTALL_DIR="$install_dir"
export WORKTABLE_LAUNCHER="$launcher"
export WORKTABLE_VERSION="$installed_version"
exec "$release_dir/bin/worktable" "\$@"
EOF
chmod +x "$launcher"
chmod +x "$release_dir/bin/worktable"

# Short alias `wtb` → same launcher. WORKTABLE_LAUNCHER stays the canonical
# `worktable` path so service-install / self-update self-references are stable.
alias_launcher="$install_dir/wtb"
cat > "$alias_launcher" <<EOF
#!/bin/sh
export WORKTABLE_RELEASE_DIR="$release_dir"
export WORKTABLE_STATIC_DIR="$release_dir/web"
export WORKTABLE_APP_DIR="$app_data"
export WORKTABLE_INSTALL_DIR="$install_dir"
export WORKTABLE_LAUNCHER="$launcher"
export WORKTABLE_VERSION="$installed_version"
exec "$release_dir/bin/worktable" "\$@"
EOF
chmod +x "$alias_launcher"

echo
echo "Worktable $installed_version installed."
echo "Launcher: $launcher (alias: wtb)"

case ":$PATH:" in
  *":$install_dir:"*) ;;
  *)
    echo
    echo "$install_dir is not on your PATH."
    echo "For zsh, add this line to ~/.zprofile:"
    echo "  export PATH=\"$install_dir:\$PATH\""
    ;;
esac

# Shell completions: installed by default (--no-completions skips). Written by
# redirecting `completion <shell>` rather than delegating to the newer
# `worktable completion install` because --version may pin a release that
# predates it. Paths must stay in sync with apps/cli/src/completion.ts
# (completionFilePath), which uninstall teardown also mirrors.
wt_shell=
case "${SHELL:-}" in
  */zsh) wt_shell=zsh ;;
  */bash) wt_shell=bash ;;
  */fish) wt_shell=fish ;;
esac

# write_completion <shell> <name> <dest> — best-effort under set -e: a
# completion-generation failure must not abort an otherwise-successful install,
# and a truncated file left behind would shadow a later working install.
write_completion() {
  if ! "$launcher" completion "$1" "$2" > "$3" 2>/dev/null; then
    rm -f "$3"
    return 1
  fi
}

echo
completion_failed=0
if [ "$completions" = "1" ] && [ -n "$wt_shell" ]; then
  # Install completion for both the canonical `worktable` and the `wtb` alias.
  # Each shell binds completion to the file's command name, so the alias needs
  # its own file generated for `wtb`.
  case "$wt_shell" in
    bash)
      comp_dir="${XDG_DATA_HOME:-$HOME/.local/share}/bash-completion/completions"
      mkdir -p "$comp_dir"
      if write_completion bash worktable "$comp_dir/worktable" \
        && write_completion bash wtb "$comp_dir/wtb"; then
        echo "Installed bash completion: $comp_dir/worktable, $comp_dir/wtb (restart your shell)"
      else
        completion_failed=1
      fi
      ;;
    fish)
      comp_dir="${XDG_CONFIG_HOME:-$HOME/.config}/fish/completions"
      mkdir -p "$comp_dir"
      if write_completion fish worktable "$comp_dir/worktable.fish" \
        && write_completion fish wtb "$comp_dir/wtb.fish"; then
        echo "Installed fish completion: $comp_dir/worktable.fish, $comp_dir/wtb.fish"
      else
        completion_failed=1
      fi
      ;;
    zsh)
      comp_dir="${XDG_DATA_HOME:-$HOME/.local/share}/zsh/site-functions"
      mkdir -p "$comp_dir"
      if write_completion zsh worktable "$comp_dir/_worktable" \
        && write_completion zsh wtb "$comp_dir/_wtb"; then
        echo "Installed zsh completion: $comp_dir/_worktable, $comp_dir/_wtb"
        echo "If completions do not load, add to ~/.zshrc:"
        echo "  fpath=($comp_dir \$fpath) && autoload -Uz compinit && compinit"
      else
        completion_failed=1
      fi
      ;;
  esac
  if [ "$completion_failed" = "1" ]; then
    echo "Could not install shell completion (Worktable itself installed fine). Try later: worktable completion install"
  fi
elif [ -n "$wt_shell" ]; then
  echo "Skipped shell completion. Enable it later: worktable completion install"
else
  echo "Enable tab completion: worktable completion install <bash|zsh|fish>"
fi

echo
set -- setup
if [ "$yes" = "1" ]; then
  set -- "$@" --yes
fi
if [ "$setup_mode" = "background" ]; then
  set -- "$@" --background
elif [ "$setup_mode" = "foreground" ]; then
  set -- "$@" --foreground
fi
if [ -n "$workspace" ]; then
  set -- "$@" --workspace "$workspace"
fi
if [ -n "$port" ]; then
  set -- "$@" --port "$port"
fi
if [ -n "$host" ]; then
  set -- "$@" --host "$host"
fi
if [ -n "$mcp_clients" ]; then
  set -- "$@" --mcp "$mcp_clients"
fi

if [ "$no_setup" = "0" ]; then
  echo "Starting setup..."
  if [ "$yes" = "1" ] || [ -t 0 ]; then
    "$launcher" "$@"
  elif [ -r /dev/tty ]; then
    # With `curl | sh` only stdin is the pipe; stdout/stderr are still the
    # terminal. Restore stdin from /dev/tty so setup can prompt, but leave
    # stdout/stderr inherited. Reopening /dev/tty for them makes the Bun-
    # compiled binary build a TTY WriteStream over the fresh fd, which fails
    # on macOS with `EINVAL kqueue` and crashes setup before it runs.
    "$launcher" "$@" < /dev/tty
  else
    echo "Setup needs an interactive terminal."
    echo "Next:"
    echo "  worktable setup"
    echo "  worktable launch"
  fi
else
  echo "Next:"
  echo "  worktable setup"
  echo "  worktable launch"
fi
