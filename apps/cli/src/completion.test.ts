import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCliTestWorker } from "./cli-test-harness.ts"

const CLI_HOME = mkdtempSync(join(tmpdir(), "wt-completion-cli-home-"))
const CLI_TEST_WORKER = createCliTestWorker(CLI_HOME)

afterAll(async () => {
  await CLI_TEST_WORKER.close()
  rmSync(CLI_HOME, { recursive: true, force: true })
})

function runCli(
  args: string[],
  env: Record<string, string> = {}
): {
  stdout: string
  stderr: string
  exitCode: number
} {
  return CLI_TEST_WORKER.run(args, env)
}

describe("completion command (binary name)", () => {
  it("defaults to the canonical `worktable` name", () => {
    const { stdout, exitCode } = runCli(["completion", "zsh"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("#compdef worktable")
  })

  it("emits a script bound to `wtb` when asked", () => {
    const { stdout, exitCode } = runCli(["completion", "zsh", "wtb"])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("#compdef wtb")
    expect(stdout).not.toContain("#compdef worktable")
  })

  it("the alias script invokes `wtb` (not worktable) for runtime completion", () => {
    // The generated script must call the alias binary so `wtb <TAB>` is
    // self-contained on PATH; both launchers run the same binary.
    const { stdout } = runCli(["completion", "bash", "wtb"])
    expect(stdout).toContain("complete -F __wtb_complete wtb")
    expect(stdout).toContain("wtb complete --")
  })

  it("rejects an unknown binary name", () => {
    const { stderr, exitCode } = runCli(["completion", "zsh", "bogus"])
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain("worktable, wtb")
  })
})

describe("completion install", () => {
  let sandbox: string
  let env: Record<string, string>

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "wt-completion-install-"))
    env = {
      XDG_DATA_HOME: join(sandbox, "data"),
      XDG_CONFIG_HOME: join(sandbox, "config"),
    }
  })

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  it("detects the shell from $SHELL and writes files for both binary names", () => {
    const { stdout, exitCode } = runCli(["completion", "install"], {
      ...env,
      SHELL: "/bin/bash",
    })
    expect(exitCode).toBe(0)
    const dir = join(env["XDG_DATA_HOME"]!, "bash-completion", "completions")
    expect(stdout).toContain("Installed bash completion")
    // Each file binds its own command name, so `wtb <TAB>` works standalone.
    expect(readFileSync(join(dir, "worktable"), "utf8")).toContain(
      "complete -F __worktable_complete worktable"
    )
    expect(readFileSync(join(dir, "wtb"), "utf8")).toContain(
      "complete -F __wtb_complete wtb"
    )
  })

  it("an explicit shell argument overrides $SHELL detection", () => {
    const { stdout, exitCode } = runCli(["completion", "install", "zsh"], {
      ...env,
      SHELL: "/bin/bash",
    })
    expect(exitCode).toBe(0)
    const dir = join(env["XDG_DATA_HOME"]!, "zsh", "site-functions")
    expect(existsSync(join(dir, "_worktable"))).toBe(true)
    expect(existsSync(join(dir, "_wtb"))).toBe(true)
    // zsh needs the dir on fpath; the command must say how.
    expect(stdout).toContain("fpath=(")
  })

  it("writes fish completions under XDG_CONFIG_HOME", () => {
    const { exitCode } = runCli(["completion", "install"], {
      ...env,
      SHELL: "/usr/bin/fish",
    })
    expect(exitCode).toBe(0)
    const dir = join(env["XDG_CONFIG_HOME"]!, "fish", "completions")
    expect(existsSync(join(dir, "worktable.fish"))).toBe(true)
    expect(existsSync(join(dir, "wtb.fish"))).toBe(true)
  })

  it("fails with guidance when the shell cannot be detected", () => {
    const { stderr, exitCode } = runCli(["completion", "install"], {
      ...env,
      SHELL: "/bin/nosh",
    })
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain("worktable completion install <bash|zsh|fish>")
  })

  it("rejects powershell (print-only shell)", () => {
    const { exitCode, stderr } = runCli(
      ["completion", "install", "powershell"],
      env
    )
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain("bash, zsh, fish")
  })

  it("installed files never leak Bun's /$bunfs/ virtual path", () => {
    const { exitCode } = runCli(["completion", "install", "bash"], env)
    expect(exitCode).toBe(0)
    const dir = join(env["XDG_DATA_HOME"]!, "bash-completion", "completions")
    for (const name of ["worktable", "wtb"]) {
      expect(readFileSync(join(dir, name), "utf8")).not.toContain("$bunfs")
    }
  })
})
