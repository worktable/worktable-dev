import { randomBytes } from "node:crypto"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { userInfo } from "node:os"
import type { AgentPreflight, NetworkInfo, SandboxDescriptor } from "./types.ts"
import type { LabAuthMode, LocalLabNetwork, LocalSource } from "./types.ts"
import { authStorageArgs } from "./auth-profile.ts"
import { stageLocalWorktable } from "./local-worktable.ts"
import { renderGuide, renderGuideSummary } from "./render-guide.ts"

const LABELS = {
  app: "app=worktable",
  purpose: "purpose=manual-lab",
}
const IMAGE = "ubuntu:24.04"
const AUTH_ROOT = "/run/worktable-lab-auth"
const OPENCLAW_PLUGIN_GUEST_PATH = "/tmp/worktable-openclaw-plugin.tgz"
const OPENCLAW_RUNTIME_GUEST_PATH = "/tmp/openclaw-source.tgz"

export interface SandboxSystem {
  run(
    command: string,
    args: string[],
    options?: { input?: string; inherit?: boolean }
  ): string
  owner(): string
}

export const realSystem: SandboxSystem = {
  run(command, args, options = {}) {
    if (options.inherit) {
      const result = spawnSync(command, args, { stdio: "inherit" })
      if (result.error) throw result.error
      if (result.status !== 0)
        throw new Error(
          `${command} exited with status ${result.status ?? "unknown"}`
        )
      return ""
    }
    return execFileSync(command, args, {
      encoding: "utf8",
      input: options.input,
      stdio:
        options.input === undefined
          ? ["ignore", "pipe", "pipe"]
          : ["pipe", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    })
  },
  owner: () => userInfo().username,
}

function labels(owner: string): string[] {
  return [LABELS.app, LABELS.purpose, `owner=${owner}`]
}

function runMsb(args: string[], system: SandboxSystem, input?: string): string {
  return system.run("msb", args, input === undefined ? {} : { input })
}

function advertisedFlags(help: string): Set<string> {
  const flags = new Set<string>()
  for (const line of help.split("\n")) {
    const match = line.match(
      /^\s*(?:-[A-Za-z0-9],\s+)?(--[a-z0-9][a-z0-9-]*)(?:\s|$)/i
    )
    if (match?.[1]) flags.add(match[1])
  }
  return flags
}

function preflightMicrosandboxCapabilities(
  system: SandboxSystem,
  requireCreate: boolean,
  requireCopy: boolean,
  requireStopped: boolean
): string {
  let version: string
  try {
    version = runMsb(["--version"], system).trim()
  } catch {
    throw new Error(
      "Microsandbox (`msb`) is not installed or cannot run. Install it before starting a lab."
    )
  }
  if (!/^msb \d+\.\d+\.\d+/.test(version)) {
    throw new Error(`Could not parse Microsandbox version from: ${version}`)
  }
  const createHelp = requireCreate ? runMsb(["create", "--help"], system) : ""
  const copyHelp = requireCopy ? runMsb(["copy", "--help"], system) : ""
  const listHelp = runMsb(["ls", "--help"], system)
  const removeHelp = runMsb(["rm", "--help"], system)
  const createFlags = advertisedFlags(createHelp)
  const copyFlags = advertisedFlags(copyHelp)
  const listFlags = advertisedFlags(listHelp)
  const removeFlags = advertisedFlags(removeHelp)
  const requiredCreateFlags = [
    "--label",
    "--max-duration",
    "--mount-named",
    "--net-default",
    "--net-rule",
    "--oci-upper-size",
    "--on-secret-violation",
    "--port",
    "--secret",
    "--tmpfs",
  ]
  const missing = [
    ...(requireCreate
      ? requiredCreateFlags.filter((flag) => !createFlags.has(flag))
      : []),
    ...(requireCopy && !copyFlags.has("--quiet") ? ["copy --quiet"] : []),
    ...[
      "--label",
      "--quiet",
      ...(requireCreate || requireStopped ? ["--stopped"] : []),
    ].filter((flag) => !listFlags.has(flag)),
    ...["--force"].filter((flag) => !removeFlags.has(flag)),
  ]
  if (missing.length > 0) {
    throw new Error(
      `Installed ${version} lacks required lab capabilities: ${[...new Set(missing)].join(", ")}`
    )
  }
  return version
}

export function preflightMicrosandbox(
  options: { requireCopy?: boolean } = {},
  system: SandboxSystem = realSystem
): string {
  return preflightMicrosandboxCapabilities(
    system,
    true,
    options.requireCopy ?? false,
    true
  )
}

export function preflightMicrosandboxCleanup(
  system: SandboxSystem = realSystem
): string {
  return preflightMicrosandboxCapabilities(system, false, false, true)
}

export function ownedSandboxNames(
  state: "running" | "stopped" | "all",
  system: SandboxSystem = realSystem
): string[] {
  const ownerLabels = labels(system.owner())
  const args = [
    "ls",
    "-q",
    ...ownerLabels.flatMap((label) => ["--label", label]),
  ]
  if (state !== "all")
    args.push(state === "running" ? "--running" : "--stopped")
  const output = runMsb(args, system)
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
}

export function removeOwnedSandboxes(
  options: { state?: "running" | "stopped" | "all"; dryRun?: boolean } = {},
  system: SandboxSystem = realSystem
): string[] {
  const names = ownedSandboxNames(options.state ?? "all", system)
  if (names.length === 0 || options.dryRun) return names
  runMsb(["rm", "--force", ...names], system)
  return names
}

export function makeSandboxName(
  kind: "cloud" | "local" | "openclaw" | "auth" | "client",
  requested?: string
): string {
  if (requested) return requested
  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14)
  return `worktable-${kind}-${stamp}-${randomBytes(3).toString("hex")}`
}

function guestScript(
  name: string,
  script: string,
  args: string[],
  system: SandboxSystem
): string {
  return runMsb(["exec", name, "--", "sh", "-s", "--", ...args], system, script)
}

export function originWithHost(origin: string, host: string): string {
  const url = new URL(origin)
  url.hostname = host
  return url.origin
}

function probeClientTarget(
  sandbox: string,
  target: string,
  network: NetworkInfo | undefined,
  system: SandboxSystem
): void {
  const health = `${target}/health`
  try {
    runMsb(
      ["exec", sandbox, "--", "curl", "-fsS", "--max-time", "5", health],
      system
    )
    console.log(`[lab] target is reachable: ${target}`)
    return
  } catch {
    // Only this host's LAN address can use the guest-to-host fallback below.
  }

  const targetUrl = new URL(target)
  if (!network || targetUrl.hostname !== network.lanAddress) {
    console.warn(
      `[lab] target did not answer at ${health}; continuing for manual diagnosis`
    )
    return
  }

  let gateway: string
  try {
    gateway = runMsb(
      [
        "exec",
        sandbox,
        "--",
        "sh",
        "-c",
        "ip -4 route show default | awk 'NR == 1 { print $3 }'",
      ],
      system
    ).trim()
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(gateway)) throw new Error()
  } catch {
    console.warn(
      `[lab] target did not answer at ${health}, and no guest host-gateway address was available`
    )
    return
  }

  const guestOrigin = originWithHost(target, gateway)
  try {
    runMsb(
      [
        "exec",
        sandbox,
        "--",
        "curl",
        "-fsS",
        "--max-time",
        "5",
        `${guestOrigin}/health`,
      ],
      system
    )
    guestScript(sandbox, APPEND_GUEST_TARGET, [target, guestOrigin], system)
    console.warn(
      `[lab] LAN hairpin unavailable; agents inside this guest should use ${guestOrigin} while the Mac continues using ${target}`
    )
  } catch {
    console.warn(
      `[lab] target did not answer through either ${target} or guest gateway ${guestOrigin}`
    )
  }
}

function prepareGuest(
  descriptor: SandboxDescriptor,
  preflight: AgentPreflight,
  guide: string,
  summary: string,
  network: NetworkInfo | undefined,
  openclaw:
    | {
        version: string
        pluginArtifact?: string
        runtimeArtifact?: string
      }
    | undefined,
  system: SandboxSystem
): void {
  if (openclaw?.pluginArtifact)
    runMsb(
      [
        "copy",
        "--quiet",
        openclaw.pluginArtifact,
        `${descriptor.name}:${OPENCLAW_PLUGIN_GUEST_PATH}`,
      ],
      system
    )
  if (openclaw?.runtimeArtifact)
    runMsb(
      [
        "copy",
        "--quiet",
        openclaw.runtimeArtifact,
        `${descriptor.name}:${OPENCLAW_RUNTIME_GUEST_PATH}`,
      ],
      system
    )
  console.log("[lab] installing guest prerequisites")
  guestScript(
    descriptor.name,
    PREPARE_GUEST,
    [
      preflight.versions.claude,
      preflight.versions.codex,
      openclaw?.version ?? "",
      openclaw?.pluginArtifact ? OPENCLAW_PLUGIN_GUEST_PATH : "",
      openclaw?.runtimeArtifact ? OPENCLAW_RUNTIME_GUEST_PATH : "",
    ],
    system
  )

  if (descriptor.callbackHostPort && !network) {
    throw new Error("Cloud callback setup requires host network information")
  }
  const callbackUrl = descriptor.callbackHostPort
    ? `http://${network!.lanAddress}:${descriptor.callbackHostPort}/callback`
    : ""
  guestScript(
    descriptor.name,
    CONFIGURE_GUEST,
    [
      guide,
      summary,
      callbackUrl,
      preflight.auth.codex.kind,
      descriptor.name,
      openclaw?.version ? "yes" : "no",
      openclaw?.pluginArtifact ? "yes" : "no",
      descriptor.worktableHostPort ? "yes" : "no",
    ],
    system
  )

  const versions = guestScript(
    descriptor.name,
    VERIFY_GUEST,
    [openclaw?.version ?? "", openclaw?.pluginArtifact ? "yes" : "no"],
    system
  )
  if (
    !versions.includes(preflight.versions.claude) ||
    !versions.includes(preflight.versions.codex)
  ) {
    throw new Error(`Guest agent version verification failed:\n${versions}`)
  }
}

export function createAgentSandbox(options: {
  kind: "cloud" | "local" | "openclaw" | "auth" | "client"
  name: string
  ttl: string
  callbackHostPort?: number
  preflight: AgentPreflight
  network?: NetworkInfo
  origin?: string
  target?: string
  authMode?: LabAuthMode
  openclaw?: {
    version: string
    pluginArtifact?: string
    runtimeArtifact?: string
  }
  local?: {
    source: LocalSource
    fixture?: string
    network: LocalLabNetwork
    checkoutArtifacts?: string[]
  }
  system?: SandboxSystem
}): SandboxDescriptor {
  const system = options.system ?? realSystem
  const owner = system.owner()
  const descriptor: SandboxDescriptor = {
    name: options.name,
    owner,
    ...(options.callbackHostPort
      ? { callbackHostPort: options.callbackHostPort }
      : {}),
    ...(options.local
      ? { worktableHostPort: options.local.network.hostPort }
      : {}),
  }
  const createArgs = [
    "create",
    IMAGE,
    "--name",
    descriptor.name,
    "--cpus",
    "2",
    "--memory",
    "4G",
    "--oci-upper-size",
    "4G",
    ...authStorageArgs(options.authMode ?? "clean"),
    "--max-duration",
    options.ttl,
    "--net-default",
    "allow",
    "--net-rule",
    "deny@meta",
    ...labels(owner).flatMap((label) => ["--label", label]),
  ]
  const secretAuth = Object.values(options.preflight.auth).filter(
    (auth) => auth.kind === "secret"
  )
  for (const auth of secretAuth) {
    if (auth.kind === "secret")
      createArgs.push("--secret", `${auth.envName}@${auth.allowedHost}`)
  }
  if (secretAuth.length > 0)
    createArgs.push("--on-secret-violation", "block-and-terminate")
  if (options.callbackHostPort)
    createArgs.push("--port", `0.0.0.0:${options.callbackHostPort}:5555`)
  if (options.local)
    createArgs.push("--port", `0.0.0.0:${options.local.network.hostPort}:7432`)

  console.log(`[lab] creating ${descriptor.name}`)
  runMsb(createArgs, system)
  try {
    const guide = renderGuide({
      kind: options.kind,
      name: descriptor.name,
      ttl: options.ttl,
      versions: options.preflight.versions,
      auth: options.preflight.auth,
      authMode: options.authMode ?? "clean",
      ...(options.network ? { network: options.network } : {}),
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.target ? { target: options.target } : {}),
      ...(options.callbackHostPort
        ? { callbackHostPort: options.callbackHostPort }
        : {}),
      ...(options.local
        ? {
            local: {
              ...options.local.network,
              source: options.local.source,
              ...(options.local.fixture
                ? { fixture: options.local.fixture }
                : {}),
            },
          }
        : {}),
    })
    const summary = renderGuideSummary({
      kind: options.kind,
      name: descriptor.name,
      ttl: options.ttl,
      versions: options.preflight.versions,
      auth: options.preflight.auth,
      authMode: options.authMode ?? "clean",
      ...(options.network ? { network: options.network } : {}),
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.target ? { target: options.target } : {}),
      ...(options.callbackHostPort
        ? { callbackHostPort: options.callbackHostPort }
        : {}),
      ...(options.local
        ? {
            local: {
              ...options.local.network,
              source: options.local.source,
              ...(options.local.fixture
                ? { fixture: options.local.fixture }
                : {}),
            },
          }
        : {}),
    })
    prepareGuest(
      descriptor,
      options.preflight,
      guide,
      summary,
      options.network,
      options.openclaw,
      system
    )

    if (options.local) {
      stageLocalWorktable({
        sandbox: descriptor.name,
        source: options.local.source,
        ...(options.local.fixture ? { fixture: options.local.fixture } : {}),
        ...(options.local.checkoutArtifacts
          ? { checkoutArtifacts: options.local.checkoutArtifacts }
          : {}),
        system,
      })
    }

    if (options.target)
      probeClientTarget(
        descriptor.name,
        options.target,
        options.network,
        system
      )
  } catch (error) {
    try {
      runMsb(["rm", "--force", descriptor.name], system)
    } catch (cleanupError) {
      console.error(
        `[lab] failed to remove partially prepared sandbox ${descriptor.name}: ${String(cleanupError)}`
      )
    }
    throw error
  }
  return descriptor
}

export function interactiveExitSucceeded(
  code: number | null,
  signal: NodeJS.Signals | null
): boolean {
  return (
    code === 0 || code === 130 || signal === "SIGINT" || signal === "SIGTERM"
  )
}

export function attachSandbox(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "msb",
      [
        "exec",
        "--tty",
        "--user",
        "tester",
        name,
        "--",
        "bash",
        "-lc",
        'source "$HOME/.worktable-lab-env"; cat "$HOME/WORKTABLE_LAB_SUMMARY.txt"; "$HOME/bin/lab-status"; cd; exec bash -l',
      ],
      { stdio: "inherit" }
    )
    const forwardSignal = (signal: NodeJS.Signals): void => {
      child.kill(signal)
    }
    process.once("SIGINT", forwardSignal)
    process.once("SIGTERM", forwardSignal)
    child.once("error", (error) => {
      process.off("SIGINT", forwardSignal)
      process.off("SIGTERM", forwardSignal)
      reject(error)
    })
    child.once("close", (code, signal) => {
      process.off("SIGINT", forwardSignal)
      process.off("SIGTERM", forwardSignal)
      if (interactiveExitSucceeded(code, signal)) resolve()
      else
        reject(
          new Error(
            `msb interactive session exited with status ${code ?? "unknown"}`
          )
        )
    })
  })
}

export function removeSandbox(
  name: string,
  system: SandboxSystem = realSystem
): void {
  runMsb(["rm", "--force", name], system)
}

const PREPARE_GUEST = String.raw`set -eu
claude_version=$1
codex_version=$2
openclaw_version=$3
openclaw_plugin=$4
openclaw_runtime=$5
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends bash ca-certificates curl iproute2 nodejs npm tar xz-utils
if [ -n "$openclaw_version" ]; then
  case "$(uname -m)" in
    x86_64) node_arch=x64 ;;
    aarch64|arm64) node_arch=arm64 ;;
    *) echo "Unsupported OpenClaw lab architecture: $(uname -m)" >&2; exit 1 ;;
  esac
  node_version=22.22.3
  curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v$node_version/node-v$node_version-linux-$node_arch.tar.xz"
  tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
  rm -f /tmp/node.tar.xz
fi
id tester >/dev/null 2>&1 || useradd -m -s /bin/bash tester
mkdir -p /run/worktable-lab-auth/claude /run/worktable-lab-auth/codex /home/tester/.openclaw/workspace
chown -R tester:tester /run/worktable-lab-auth /home/tester/.openclaw
chmod 700 /run/worktable-lab-auth /run/worktable-lab-auth/claude /run/worktable-lab-auth/codex /home/tester/.openclaw /home/tester/.openclaw/workspace
npm install -g "@anthropic-ai/claude-code@$claude_version" "@openai/codex@$codex_version"
if [ -n "$openclaw_version" ]; then
  if [ -n "$openclaw_runtime" ]; then
    npm install -g "$openclaw_runtime"
  else
    npm install -g "openclaw@$openclaw_version"
  fi
  if [ -n "$openclaw_plugin" ]; then
    su tester -s /bin/sh -c 'HOME=/home/tester OPENCLAW_STATE_DIR=/home/tester/.openclaw openclaw plugins install "npm-pack:$1" --force --pin' sh "$openclaw_plugin"
  fi
  su tester -s /bin/sh -c 'HOME=/home/tester CODEX_HOME=/run/worktable-lab-auth/codex OPENCLAW_STATE_DIR=/home/tester/.openclaw openclaw models set openai/gpt-5.6-sol'
  su tester -s /bin/sh -c 'HOME=/home/tester OPENCLAW_STATE_DIR=/home/tester/.openclaw openclaw config set agents.defaults.workspace /home/tester/.openclaw/workspace'
  su tester -s /bin/sh -c 'HOME=/home/tester OPENCLAW_STATE_DIR=/home/tester/.openclaw openclaw config set plugins.entries.codex.config.appServer.homeScope user'
  su tester -s /bin/sh -c 'HOME=/home/tester OPENCLAW_STATE_DIR=/home/tester/.openclaw openclaw config set gateway.mode local'
fi
`

const CONFIGURE_GUEST = String.raw`set -eu
guide=$1
summary=$2
callback_url=$3
codex_auth=$4
lab_name=$5
has_openclaw=$6
has_worktable_plugin=$7
has_worktable=$8
if [ -n "$callback_url" ]; then
  cat > /run/worktable-lab-auth/codex/config.toml <<EOF
mcp_oauth_callback_port = 5555
mcp_oauth_callback_url = "$callback_url"
EOF
  chown tester:tester /run/worktable-lab-auth/codex/config.toml
  chmod 600 /run/worktable-lab-auth/codex/config.toml
fi
cat > /home/tester/.worktable-lab-env <<'EOF'
export CLAUDE_CONFIG_DIR=/run/worktable-lab-auth/claude
export CODEX_HOME=/run/worktable-lab-auth/codex
export OPENCLAW_STATE_DIR=/home/tester/.openclaw
EOF
mkdir -p /home/tester/bin
cat > /home/tester/bin/lab-status <<'EOF'
#!/bin/sh
set -u
. "$HOME/.worktable-lab-env"

status_line() {
  label=$1
  attempt=1
  while [ "$attempt" -le 2 ]; do
    if timeout 20s sh -c "$2" >/dev/null 2>&1; then
      printf '• %s: ready\n' "$label"
      return
    fi
    attempt=$((attempt + 1))
  done
  printf '• %s: needs authentication or setup\n' "$label"
}

claude_status() {
  attempt=1
  while [ "$attempt" -le 2 ]; do
    if timeout 20s claude auth status 2>/dev/null |
      grep -Eq '"loggedIn"[[:space:]]*:[[:space:]]*true'; then
      printf '• Claude Code: ready\n'
      return
    fi
    attempt=$((attempt + 1))
  done
  printf '• Claude Code: needs authentication or setup\n'
}

printf '\nCurrent readiness\n'
claude_status
status_line "Codex" 'codex login status'
if [ "$WORKTABLE_LAB_HAS_OPENCLAW" = "yes" ]; then
  status_line "OpenClaw Codex runtime" 'codex login status && test "$(openclaw config get agents.defaults.model.primary | tail -n 1)" = "openai/gpt-5.6-sol" && test "$(openclaw config get plugins.entries.codex.config.appServer.homeScope | tail -n 1)" = "user" && openclaw plugins inspect codex --runtime --json'
fi
if [ "$WORKTABLE_LAB_HAS_WORKTABLE_PLUGIN" = "yes" ]; then
  status_line "Worktable OpenClaw plugin" 'openclaw plugins inspect worktable --runtime --json'
fi
if [ "$WORKTABLE_LAB_HAS_WORKTABLE" = "yes" ]; then
  printf '• Worktable runtime: installed; start it with the command in WORKTABLE_LAB.txt\n'
fi
printf '• Worktable pairing: verify after the Worktable runtime is started\n'
EOF
cat >> /home/tester/.worktable-lab-env <<EOF
export WORKTABLE_LAB_NAME='$lab_name'
export WORKTABLE_LAB_HAS_OPENCLAW='$has_openclaw'
export WORKTABLE_LAB_HAS_WORKTABLE_PLUGIN='$has_worktable_plugin'
export WORKTABLE_LAB_HAS_WORKTABLE='$has_worktable'
EOF
printf '%s' "$guide" > /home/tester/WORKTABLE_LAB.txt
printf '%s\n' "$summary" > /home/tester/WORKTABLE_LAB_SUMMARY.txt
cat >> /home/tester/.bashrc <<'EOF'
source "$HOME/.worktable-lab-env"
EOF
cat > /home/tester/.bash_profile <<'EOF'
if [ -f "$HOME/.bashrc" ]; then
  source "$HOME/.bashrc"
fi
EOF
cat > /etc/profile.d/worktable-lab-user.sh <<'EOF'
if [ "$(id -u)" -eq 0 ] && [ -t 1 ]; then
  cat >&2 <<'MESSAGE'
[lab] This root shell has a separate, empty agent profile.
[lab] OpenClaw, Codex, and Claude lab state belongs to the tester account.
[lab] Run: exec su - tester
MESSAGE
fi
EOF
chown -R tester:tester /home/tester/bin
chown tester:tester /home/tester/.worktable-lab-env /home/tester/WORKTABLE_LAB.txt /home/tester/WORKTABLE_LAB_SUMMARY.txt /home/tester/.bashrc /home/tester/.bash_profile
chmod 700 /home/tester/bin /home/tester/bin/lab-status
chmod 600 /home/tester/.worktable-lab-env /home/tester/WORKTABLE_LAB.txt /home/tester/WORKTABLE_LAB_SUMMARY.txt /home/tester/.bash_profile
chmod 644 /etc/profile.d/worktable-lab-user.sh
if [ "$codex_auth" = "secret" ]; then
  su --preserve-environment tester -s /bin/sh -c 'HOME=/home/tester; export HOME; . "$HOME/.worktable-lab-env"; test -n "$OPENAI_API_KEY"; printf "%s" "$OPENAI_API_KEY" | codex login --with-api-key >/dev/null'
fi
`

const VERIFY_GUEST = String.raw`set -eu
expected_openclaw=$1
has_worktable_plugin=$2
su - tester -c '. "$HOME/.worktable-lab-env"; claude --version; codex --version; if command -v openclaw >/dev/null 2>&1; then openclaw --version; fi'
if [ -n "$expected_openclaw" ]; then
  su - tester -c '. "$HOME/.worktable-lab-env"; openclaw --version | grep -F "$1" >/dev/null' sh "$expected_openclaw"
fi
if [ "$has_worktable_plugin" = "yes" ]; then
  su - tester -c '. "$HOME/.worktable-lab-env"; openclaw plugins inspect worktable --runtime --json >/dev/null'
fi
`

const APPEND_GUEST_TARGET = String.raw`set -eu
mac_origin=$1
guest_origin=$2
cat >> /home/tester/WORKTABLE_LAB.txt <<EOF

Network fallback
----------------
Mac / LAN origin:       $mac_origin
Agent guest origin:     $guest_origin

This host does not support LAN hairpin routing from the sandbox. Use the guest
origin only inside this sandbox; continue using the Mac / LAN origin elsewhere.
EOF
cat >> /home/tester/WORKTABLE_LAB_SUMMARY.txt <<EOF

Network fallback
• Inside this guest, use $guest_origin.
• On the Mac, continue using $mac_origin.
EOF
`
