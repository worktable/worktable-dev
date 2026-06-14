#!/bin/sh
set -eu

usage() {
  cat <<'EOF'
Worktable local installer

Usage:
  curl -fsSL https://worktable.dev/install | sh
  curl -fsSL https://worktable.dev/install | sh -s -- [options]

Options:
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

while [ "$#" -gt 0 ]; do
  case "$1" in
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
    app_data="${XDG_DATA_HOME:-$HOME/.local/share}/worktable"
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
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$url" -o "$archive"
elif command -v wget >/dev/null 2>&1; then
  wget -q "$url" -O "$archive"
else
  echo "Worktable installer requires curl or wget." >&2
  exit 1
fi

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
rm -rf "$release_dir"
mv "$staging_dir" "$release_dir"

mkdir -p "$install_dir"
launcher="$install_dir/worktable"
cat > "$launcher" <<EOF
#!/bin/sh
export WORKTABLE_RELEASE_DIR="$release_dir"
export WORKTABLE_STATIC_DIR="$release_dir/web"
export WORKTABLE_VERSION="$installed_version"
exec "$release_dir/bin/worktable" "\$@"
EOF
chmod +x "$launcher"
chmod +x "$release_dir/bin/worktable"

echo
echo "Worktable $installed_version installed."
echo "Launcher: $launcher"

case ":$PATH:" in
  *":$install_dir:"*) ;;
  *)
    echo
    echo "$install_dir is not on your PATH."
    echo "For zsh, add this line to ~/.zprofile:"
    echo "  export PATH=\"$install_dir:\$PATH\""
    ;;
esac

echo
echo "Next:"
echo "  worktable"
