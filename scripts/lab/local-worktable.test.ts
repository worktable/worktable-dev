import { describe, expect, test } from "bun:test"
import {
  artifactMayBeReused,
  artifactNameForArch,
  dirtyBuildMarker,
  stageLocalWorktable,
} from "./local-worktable.ts"
import type { SandboxSystem } from "./microsandbox.ts"

describe("local Worktable staging", () => {
  test("maps only supported Linux architectures", () => {
    expect(artifactNameForArch("x64")).toBe("worktable-linux-x64.tar.gz")
    expect(artifactNameForArch("aarch64")).toBe("worktable-linux-arm64.tar.gz")
    expect(() => artifactNameForArch("riscv64")).toThrow("Unsupported")
  })

  test("never reuses an artifact built from a dirty checkout", () => {
    expect(dirtyBuildMarker("/tmp/releases/worktable.tar.gz")).toBe(
      "/tmp/.worktable.tar.gz.worktable-lab-dirty"
    )
    expect(
      artifactMayBeReused({
        sourceDirty: false,
        dirtyBuildMarkerExists: true,
        sourceCommitMatches: true,
      })
    ).toBeFalse()
    expect(
      artifactMayBeReused({
        sourceDirty: false,
        dirtyBuildMarkerExists: false,
        sourceCommitMatches: true,
      })
    ).toBeTrue()
  })

  test("release helper keeps installation and setup manual", () => {
    const inputs: string[] = []
    const calls: string[][] = []
    const system: SandboxSystem = {
      owner: () => "tester",
      run(command, args, options) {
        calls.push([command, ...args])
        if (options?.input) inputs.push(options.input)
        return ""
      },
    }
    stageLocalWorktable({
      sandbox: "local-test",
      source: "release",
      system,
    })
    const script = inputs.join("\n")
    expect(script).toContain("https://worktable.dev/install")
    expect(script).not.toContain("WORKTABLE_PUBLIC_URL")
    expect(script).toContain("--foreground")
    expect(script).toContain("--host 0.0.0.0")
    expect(script).toContain("--port 7432")
    expect(script).not.toContain("--yes")
    expect(script).not.toContain("--no-setup")
    expect(script).toContain(
      "install -d -o tester -g tester -m 700 /home/tester/.worktable-lab/evidence"
    )
    expect(script.indexOf("/home/tester/.worktable-lab/evidence")).toBeLessThan(
      script.indexOf("/home/tester/bin/lab-evidence baseline")
    )
    expect(calls.every((call) => Array.isArray(call))).toBeTrue()
  })

  test("checkout source requires an explicitly prepared artifact", () => {
    const system: SandboxSystem = {
      owner: () => "tester",
      run: () => "",
    }
    expect(() =>
      stageLocalWorktable({
        sandbox: "local-test",
        source: "checkout",
        system,
      })
    ).toThrow("prepared release artifact")
  })

  test("checkout stages the prepared host-architecture artifact", () => {
    const calls: string[][] = []
    const system: SandboxSystem = {
      owner: () => "tester",
      run(command, args) {
        calls.push([command, ...args])
        return ""
      },
    }
    stageLocalWorktable({
      sandbox: "checkout-test",
      source: "checkout",
      checkoutArtifacts: ["/tmp/worktable-linux-x64.tar.gz"],
      system,
    })
    expect(calls.flat()).toContain("/tmp/worktable-linux-x64.tar.gz")
    expect(calls.flat()).toContain("worktable-linux-x64.tar.gz")
  })
})
