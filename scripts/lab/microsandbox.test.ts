import { describe, expect, test } from "bun:test"
import {
  createAgentSandbox,
  interactiveExitSucceeded,
  makeSandboxName,
  originWithHost,
  ownedSandboxNames,
  preflightMicrosandbox,
  preflightMicrosandboxCleanup,
  removeOwnedSandboxes,
  type SandboxSystem,
} from "./microsandbox.ts"

function fakeSystem(outputs: string[] = []): {
  system: SandboxSystem
  calls: string[][]
} {
  const calls: string[][] = []
  return {
    calls,
    system: {
      owner: () => "atlas-code",
      run(command, args) {
        calls.push([command, ...args])
        return outputs.shift() ?? ""
      },
    },
  }
}

describe("owned sandbox lifecycle", () => {
  test("treats a normal shell exit and an interactive Ctrl+C as successful cleanup", () => {
    expect(interactiveExitSucceeded(0, null)).toBeTrue()
    expect(interactiveExitSucceeded(130, null)).toBeTrue()
    expect(interactiveExitSucceeded(null, "SIGINT")).toBeTrue()
    expect(interactiveExitSucceeded(1, null)).toBeFalse()
  })

  test("preflights the installed canonical lifecycle and creation capabilities", () => {
    const { system, calls } = fakeSystem([
      "msb 0.5.7\n",
      "      --label <LABEL>\n      --max-duration <DURATION>\n      --mount-named <VOLUME>\n      --net-default <ACTION>\n      --net-rule <RULE>\n      --oci-upper-size <SIZE>\n      --on-secret-violation <ACTION>\n      --port <PORT>\n      --secret <SECRET>\n      --tmpfs <TMPFS>",
      "  -q, --quiet",
      "      --label <LABEL>\n      --stopped\n  -q, --quiet",
      "  -f, --force",
    ])
    expect(preflightMicrosandbox({ requireCopy: true }, system)).toBe(
      "msb 0.5.7"
    )
    expect(calls).toEqual([
      ["msb", "--version"],
      ["msb", "create", "--help"],
      ["msb", "copy", "--help"],
      ["msb", "ls", "--help"],
      ["msb", "rm", "--help"],
    ])
  })

  test("does not require copy support when a lab stages no files", () => {
    const { system, calls } = fakeSystem([
      "msb 0.5.7\n",
      "      --label <LABEL>\n      --max-duration <DURATION>\n      --mount-named <VOLUME>\n      --net-default <ACTION>\n      --net-rule <RULE>\n      --oci-upper-size <SIZE>\n      --on-secret-violation <ACTION>\n      --port <PORT>\n      --secret <SECRET>\n      --tmpfs <TMPFS>",
      "      --label <LABEL>\n      --stopped\n  -q, --quiet",
      "  -f, --force",
    ])
    expect(preflightMicrosandbox({}, system)).toBe("msb 0.5.7")
    expect(calls.some((call) => call[1] === "copy")).toBeFalse()
  })

  test("cleanup preflight requires only lifecycle capabilities", () => {
    const { system, calls } = fakeSystem([
      "msb 0.5.7\n",
      "      --label <LABEL>\n      --stopped\n  -q, --quiet",
      "  -f, --force",
    ])
    expect(preflightMicrosandboxCleanup(system)).toBe("msb 0.5.7")
    expect(calls).toEqual([
      ["msb", "--version"],
      ["msb", "ls", "--help"],
      ["msb", "rm", "--help"],
    ])
  })

  test("cleanup preflight rejects a build without stopped filtering", () => {
    const { system } = fakeSystem([
      "msb 0.5.7\n",
      "      --label <LABEL>\n  -q, --quiet",
      "  -f, --force",
    ])
    expect(() => preflightMicrosandboxCleanup(system)).toThrow("--stopped")
  })

  test("rejects a Microsandbox build missing required capabilities", () => {
    const { system } = fakeSystem([
      "msb 0.4.0\n",
      "      --label <LABEL>",
      "  -q, --quiet",
      "      --label <LABEL>\n      --quiet",
      "      --force",
    ])
    expect(() => preflightMicrosandbox({}, system)).toThrow(
      "lacks required lab capabilities"
    )
  })

  test("does not confuse a suffixed network flag with the required exact flag", () => {
    const { system } = fakeSystem([
      "msb 0.5.7\n",
      "      --label <LABEL>\n      --max-duration <DURATION>\n      --net-default-egress <ACTION>\n      --net-rule <RULE>\n      --oci-upper-size <SIZE>\n      --on-secret-violation <ACTION>\n      --port <PORT>\n      --secret <SECRET>\n      --tmpfs <TMPFS>",
      "  -q, --quiet",
      "      --label <LABEL>\n      --stopped\n  -q, --quiet",
      "  -f, --force",
    ])
    expect(() => preflightMicrosandbox({}, system)).toThrow("--net-default")
  })

  test("lists only the complete ownership label set", () => {
    const { system, calls } = fakeSystem(["one\ntwo\n"])
    expect(ownedSandboxNames("stopped", system)).toEqual(["one", "two"])
    expect(calls[0]).toEqual([
      "msb",
      "ls",
      "-q",
      "--label",
      "app=worktable",
      "--label",
      "purpose=manual-lab",
      "--label",
      "owner=atlas-code",
      "--stopped",
    ])
  })

  test("dry-run never invokes remove", () => {
    const { system, calls } = fakeSystem(["mine\n"])
    expect(removeOwnedSandboxes({ dryRun: true }, system)).toEqual(["mine"])
    expect(calls).toHaveLength(1)
  })

  test("stopped cleanup uses enumerated owned names rather than a broad label deletion", () => {
    const { system, calls } = fakeSystem(["one\ntwo\n", ""])
    removeOwnedSandboxes({ state: "stopped" }, system)
    expect(calls[0]).toContain("--stopped")
    expect(calls[1]).toEqual(["msb", "rm", "--force", "one", "two"])
  })

  test("generated names are unique and recognizable", () => {
    expect(makeSandboxName("cloud")).toMatch(
      /^worktable-cloud-\d{14}-[a-f0-9]{6}$/
    )
    expect(makeSandboxName("client", "my-lab")).toBe("my-lab")
    expect(makeSandboxName("local")).toMatch(
      /^worktable-local-\d{14}-[a-f0-9]{6}$/
    )
  })

  test("rewrites only the host when deriving a guest gateway origin", () => {
    expect(originWithHost("http://192.168.1.50:17432", "172.16.0.1")).toBe(
      "http://172.16.0.1:17432"
    )
  })

  test("prints a usable guest target when LAN hairpin routing is unavailable", () => {
    const calls: { args: string[]; input?: string }[] = []
    const system: SandboxSystem = {
      owner: () => "tester",
      run(_command, args, options) {
        calls.push({ args, input: options?.input })
        if (options?.input?.includes("claude --version"))
          return "Claude 1.0.0\ncodex-cli 1.0.0\n"
        if (args.some((arg) => arg.includes("ip -4 route show default")))
          return "172.16.0.1\n"
        const url = args.at(-1)
        if (args.includes("curl") && url === "http://192.168.1.50:17432/health")
          throw new Error("no hairpin")
        return ""
      },
    }
    createAgentSandbox({
      kind: "client",
      name: "fallback-test",
      ttl: "2h",
      target: "http://192.168.1.50:17432",
      network: { lanAddress: "192.168.1.50" },
      preflight: {
        versions: { claude: "1.0.0", codex: "1.0.0" },
        auth: {
          claude: { kind: "guest-login" },
          codex: { kind: "guest-login" },
        },
      },
      system,
    })
    const fallback = calls.find((call) =>
      call.input?.includes("cat >> /home/tester/WORKTABLE_LAB_SUMMARY.txt")
    )
    expect(fallback?.input).toContain("WORKTABLE_LAB.txt")
    expect(fallback?.args).toContain("http://172.16.0.1:17432")
  })

  test("guest preparation failure removes the partially created sandbox", () => {
    const { system, calls } = fakeSystem(["", "preparation failed", ""])
    system.run = (command, args) => {
      calls.push([command, ...args])
      if (args[0] === "exec") throw new Error("preparation failed")
      return ""
    }
    expect(() =>
      createAgentSandbox({
        kind: "client",
        name: "failure-test",
        ttl: "2h",
        preflight: {
          versions: { claude: "1.0.0", codex: "1.0.0" },
          auth: {
            claude: { kind: "guest-login" },
            codex: { kind: "guest-login" },
          },
        },
        network: { lanAddress: "192.168.1.50" },
        system,
      })
    ).toThrow("preparation failed")
    expect(calls[0]).toContain("--net-default")
    expect(calls[0]).toContain("--net-rule")
    expect(calls[0]).toContain("deny@meta")
    expect(calls.at(-1)).toEqual(["msb", "rm", "--force", "failure-test"])
  })

  test("injects only named provider secrets and never their values", () => {
    const { system, calls } = fakeSystem()
    system.run = (command, args) => {
      calls.push([command, ...args])
      if (args[0] === "exec") throw new Error("stop after create")
      return ""
    }
    expect(() =>
      createAgentSandbox({
        kind: "client",
        name: "secret-test",
        ttl: "2h",
        preflight: {
          versions: { claude: "1.0.0", codex: "1.0.0" },
          auth: {
            claude: {
              kind: "secret",
              envName: "ANTHROPIC_API_KEY",
              allowedHost: "api.anthropic.com",
            },
            codex: {
              kind: "secret",
              envName: "OPENAI_API_KEY",
              allowedHost: "api.openai.com",
            },
          },
        },
        system,
      })
    ).toThrow("stop after create")
    expect(calls[0]).toContain("ANTHROPIC_API_KEY@api.anthropic.com")
    expect(calls[0]).toContain("OPENAI_API_KEY@api.openai.com")
    expect(calls[0]).toContain("block-and-terminate")
    expect(calls.flat().join(" ")).not.toContain("secret-value")
  })

  test("publishes the local Worktable port and stages manual helpers", () => {
    const { system, calls } = fakeSystem([
      "",
      "",
      "",
      "Claude 1.0.0\ncodex-cli 1.0.0\n",
      "",
    ])
    createAgentSandbox({
      kind: "local",
      name: "local-test",
      ttl: "2h",
      preflight: {
        versions: { claude: "1.0.0", codex: "1.0.0" },
        auth: {
          claude: { kind: "guest-login" },
          codex: { kind: "guest-login" },
        },
      },
      network: { lanAddress: "192.168.1.50" },
      local: {
        source: "release",
        network: {
          hostPort: 17432,
          publicHost: "192.168.1.50",
          publicOrigin: "http://192.168.1.50:17432",
          lanOrigin: "http://192.168.1.50:17432",
          loopbackOrigin: "http://127.0.0.1:17432",
        },
      },
      system,
    })
    expect(calls[0]).toContain("0.0.0.0:17432:7432")
    expect(
      calls.flat().some((value) => value.includes("http://192.168.1.50:17432"))
    ).toBeTrue()
    expect(calls.flat()).not.toContain("0.0.0.0:17432")
  })

  test("preconfigures OpenClaw to reuse the isolated Codex subscription", () => {
    const scripts: string[] = []
    const system: SandboxSystem = {
      owner: () => "tester",
      run(_command, args, options) {
        if (options?.input) scripts.push(options.input)
        if (options?.input?.includes("claude --version"))
          return "Claude 1.0.0\ncodex-cli 1.0.0\nOpenClaw 2026.7.1-2\n"
        return ""
      },
    }

    createAgentSandbox({
      kind: "auth",
      name: "openclaw-auth-test",
      ttl: "2h",
      preflight: {
        versions: {
          claude: "1.0.0",
          codex: "1.0.0",
          openclaw: "2026.7.1-2",
        },
        auth: {
          claude: { kind: "guest-login" },
          codex: { kind: "guest-login" },
        },
      },
      authMode: "ready",
      openclaw: {
        version: "2026.7.1-2",
        pluginArtifact: "/tmp/worktable-openclaw-plugin.tgz",
      },
      system,
    })

    const allScripts = scripts.join("\n")
    expect(allScripts).toContain(
      "openclaw plugins inspect worktable --runtime --json >/dev/null"
    )
    expect(allScripts).toContain(
      "openclaw config set agents.defaults.workspace /home/tester/.openclaw/workspace"
    )
    expect(allScripts).toContain(
      "export OPENCLAW_STATE_DIR=/home/tester/.openclaw"
    )
    expect(allScripts).not.toContain(
      "OPENCLAW_STATE_DIR=/run/worktable-lab-auth/openclaw"
    )
    expect(allScripts).toContain(
      "This root shell has a separate, empty agent profile"
    )
    expect(allScripts).toContain("Run: exec su - tester")
    expect(allScripts).toContain("openclaw models set openai/gpt-5.6-sol")
    expect(allScripts).toContain(
      "plugins.entries.codex.config.appServer.homeScope user"
    )
    expect(allScripts).toContain("openclaw config set gateway.mode local")
    expect(allScripts).toContain('status_line "OpenClaw Codex runtime"')
  })
})
