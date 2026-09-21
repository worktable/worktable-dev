// Shell completions, powered by @bomb.sh/tab over the Commander tree.
//
// Verified against a compiled single-file Bun binary:
//  - We serve our own `completion <shell>` and pass the on-PATH name `worktable` to
//    tab.setup(); passing process.execPath would leak Bun's /$bunfs/ virtual path and
//    the launcher is rewritten on every `worktable update`.
//  - The tab Commander adapter MUST be attached at top level (before parse) so the
//    runtime `complete -- <words>` command exists; otherwise completion silently dies.
//  - The adapter's own script-gen command leaks /$bunfs/, so we hide it and serve ours.
//  - Dynamic value completion (live agent ids) is wired straight onto the tab-core
//    command, which fires for both single (`mcp remove`) and variadic (`mcp setup`)
//    positionals — the Commander adapter alone only wires static choices.
import { mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Command } from "@commander-js/extra-typings"
import { Argument } from "@commander-js/extra-typings"
import type { Command as CommanderCommand } from "commander"
import tabCommander from "@bomb.sh/tab/commander"
import tabRoot from "@bomb.sh/tab"
import { CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS, readConfig } from "./config.ts"
import { detectInstalledClients, listClients } from "./mcp.ts"
import { UsageError } from "./style.ts"

const SHELLS = ["bash", "zsh", "fish", "powershell"] as const
// Shells `completion install` can place files for. PowerShell is print-only:
// it has no drop-in completions directory, only profile edits we won't make.
const INSTALLABLE_SHELLS = ["bash", "zsh", "fish"] as const
type InstallableShell = (typeof INSTALLABLE_SHELLS)[number]
// On-PATH binary names we can emit completion for: the canonical `worktable` and
// the short `wtb` alias (install.sh writes both launchers).
const COMPLETION_NAMES = ["worktable", "wtb"] as const
const DEFAULT_COMPLETION_NAME = "worktable"
const INTERNAL_SCRIPT_COMMAND = "__completion_internal"

type Complete = (value: string, description: string) => void

interface TabArgCommand {
  argument(
    name: string,
    handler: (complete: Complete) => void,
    variadic?: boolean
  ): unknown
}

interface TabRoot {
  commands: Map<string, TabArgCommand>
  setup(name: string, executable: string, shell: string): void
}

/**
 * Where each shell auto-loads a completion file for a command name. Also the
 * paths scripts/install.sh writes — keep the two in sync (install.sh cannot
 * delegate here because `--version` may pin a release predating this command).
 */
function completionFilePath(shell: InstallableShell, name: string): string {
  const xdgData =
    process.env["XDG_DATA_HOME"]?.trim() || join(homedir(), ".local", "share")
  const xdgConfig =
    process.env["XDG_CONFIG_HOME"]?.trim() || join(homedir(), ".config")
  switch (shell) {
    case "bash":
      return join(xdgData, "bash-completion", "completions", name)
    case "zsh":
      return join(xdgData, "zsh", "site-functions", `_${name}`)
    case "fish":
      return join(xdgConfig, "fish", "completions", `${name}.fish`)
  }
}

/**
 * Every completion file `completion install` or install.sh may have written,
 * for both command names. Uninstall teardown attempts all of them — a stale
 * completion for a removed binary is just litter, and rm is a no-op when absent.
 */
export function completionPaths(): string[] {
  return INSTALLABLE_SHELLS.flatMap((shell) =>
    COMPLETION_NAMES.map((name) => completionFilePath(shell, name))
  )
}

function detectInstallableShell(): InstallableShell | undefined {
  const base = (process.env["SHELL"] ?? "").split("/").pop() ?? ""
  return (INSTALLABLE_SHELLS as readonly string[]).includes(base)
    ? (base as InstallableShell)
    : undefined
}

/**
 * tab's setup() only prints to stdout; capture it so `completion install` can
 * write files. The plain `completion <shell>` printing path shares this too.
 */
function generateScript(shell: string, name: string): string {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "))
  }
  try {
    ;(tabRoot as unknown as TabRoot).setup(name, name, shell)
  } finally {
    console.log = original
  }
  return `${lines.join("\n")}\n`
}

/** Live ids the user has connected — useful for `mcp remove <TAB>`. */
function completeConfiguredClients(complete: Complete): void {
  try {
    const config = readConfig()
    const labels = new Map(listClients(true).map((c) => [c.id, c.label]))
    for (const id of CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS) {
      if (config.mcp.clients[id]?.desired)
        complete(id, labels.get(id) ?? "configured")
    }
  } catch {
    // Completion is best-effort; never throw into the shell.
  }
}

/** Detected agent CLIs/configs — useful for `mcp setup <TAB>`. */
function completeDetectedClients(complete: Complete): void {
  try {
    const labels = new Map(listClients(true).map((c) => [c.id, c.label]))
    for (const id of detectInstalledClients())
      complete(id, labels.get(id) ?? "detected")
  } catch {
    // Completion is best-effort; never throw into the shell.
  }
}

export function registerCompletion(program: Command): void {
  // Register our own script generator BEFORE walking the tree so it is itself
  // completable. On-PATH name only — never process.execPath (see file header).
  const completion = program
    .command("completion")
    .description("Set up shell tab completion")
    .addArgument(
      new Argument("<shell>", "shell to print a completion script for").choices(
        [...SHELLS]
      )
    )
    // Optional binary name so the same generator serves both the canonical
    // `worktable` and the short `wtb` alias (both on-PATH, same binary). The
    // generated script binds this name AND uses it as the executable that serves
    // `complete` — never process.execPath (see file header).
    .addArgument(
      new Argument("[name]", "binary name to complete")
        .choices([...COMPLETION_NAMES])
        .default(DEFAULT_COMPLETION_NAME)
    )
    .action((shell, name) => {
      process.stdout.write(generateScript(shell, name))
    })

  // `completion install` places the files where the shell auto-loads them —
  // the primary path for users; the printing form above stays for CI, dotfile
  // managers, and packagers. Commander dispatches the subcommand before the
  // parent's <shell> choices are validated, so the two coexist.
  completion
    .command("install")
    .description("Install completion for your shell (worktable and wtb)")
    .addArgument(
      new Argument("[shell]", "shell to target; default: detect from $SHELL")
        .choices([...INSTALLABLE_SHELLS])
    )
    .action((shellArg) => {
      const shell = shellArg ?? detectInstallableShell()
      if (!shell) {
        throw new UsageError(
          "Could not detect a supported shell from $SHELL. Pass one explicitly: worktable completion install <bash|zsh|fish>"
        )
      }
      const written: string[] = []
      for (const name of COMPLETION_NAMES) {
        const path = completionFilePath(shell, name)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, generateScript(shell, name))
        written.push(path)
      }
      console.log(`Installed ${shell} completion:`)
      for (const path of written) console.log(`  ${path}`)
      if (shell === "zsh") {
        console.log("If completions do not load, add to ~/.zshrc:")
        console.log(
          `  fpath=(${dirname(written[0]!)} $fpath) && autoload -Uz compinit && compinit`
        )
      } else if (shell === "bash") {
        console.log("Restart your shell to activate (requires bash-completion).")
      }
    })

  // Attach the tab adapter at top level: registers the runtime `complete` command
  // and walks the command tree for static completion.
  tabCommander(program as unknown as CommanderCommand, {
    completionCommandName: INTERNAL_SCRIPT_COMMAND,
  })
  const tab = tabRoot as unknown as TabRoot

  // Drop the adapter's auto script-gen command (it leaks /$bunfs/ under --compile;
  // we serve our own `completion`). tabCommander already snapshotted the tree into
  // tab-core's own registry, so hiding it from Commander's --help is not enough —
  // it must also be removed from tab-core, or `worktable <TAB>` would suggest it.
  const internal = program.commands.find(
    (command) => command.name() === INTERNAL_SCRIPT_COMMAND
  )
  if (internal) (internal as unknown as { _hidden: boolean })._hidden = true
  tab.commands.delete(INTERNAL_SCRIPT_COMMAND)

  // Wire dynamic live-id completion onto the tab-core commands.
  tab.commands.get("mcp remove")?.argument("client", completeConfiguredClients, false)
  tab.commands.get("mcp setup")?.argument("clients", completeDetectedClients, true)
}
