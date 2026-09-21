import { describe, expect, it } from "bun:test"
import fc from "fast-check"
import {
  classifyRuntimeReadiness,
  describeRuntimeReadinessFailure,
  planLocalAuthority,
  resolveReachability,
  runtimeProvesWorkspaceEndpoint,
  type ExactRuntimeReadinessFailure,
  type LocalAuthorityPlanInput,
} from "./local-authority-plan.ts"

function input(
  overrides: Partial<LocalAuthorityPlanInput> = {}
): LocalAuthorityPlanInput {
  return {
    operation: "setup",
    desired: {
      workspaceId: "workspace-a",
      workspacePath: "/tmp/workspace-a",
      host: "127.0.0.1",
      port: 7480,
      background: true,
      noLaunch: false,
      changesDurableState: false,
    },
    runtime: {
      processAlive: true,
      endpointVerified: true,
      workspaceId: "workspace-a",
      workspacePath: "/tmp/workspace-a",
      host: "127.0.0.1",
      port: 7480,
    },
    service: {
      platform: "systemd",
      state: "running",
      installed: true,
      startsAtLogin: true,
    },
    lock: { state: "owned", exactOwnership: true },
    journal: { state: "none" },
    ...overrides,
  }
}

describe("local authority transition plan", () => {
  it.each([
    {
      name: "explicitly reachable",
      opts: { reachable: true },
      current: false,
      acknowledged: false,
      currentHost: "",
      expected: { reachable: true, host: "0.0.0.0", needsAck: true },
    },
    {
      name: "reachable alias already acknowledged",
      opts: { bind: true },
      current: false,
      acknowledged: true,
      currentHost: "",
      expected: { reachable: true, host: "0.0.0.0", needsAck: false },
    },
    {
      name: "explicit loopback host",
      opts: { reachable: true, host: "127.0.0.1" },
      current: false,
      acknowledged: false,
      currentHost: "",
      expected: {
        reachable: false,
        host: "127.0.0.1",
        needsAck: false,
      },
    },
    {
      name: "persisted custom host",
      opts: {},
      current: true,
      acknowledged: true,
      currentHost: "192.168.1.5",
      expected: {
        reachable: true,
        host: "192.168.1.5",
        needsAck: false,
      },
    },
    {
      name: "default loopback posture",
      opts: {},
      current: false,
      acknowledged: false,
      currentHost: "",
      expected: {
        reachable: false,
        host: "127.0.0.1",
        needsAck: false,
      },
    },
  ])(
    "resolves the $name network posture",
    ({ opts, current, acknowledged, currentHost, expected }) => {
      expect(
        resolveReachability(opts, current, acknowledged, currentHost)
      ).toEqual(expected)
    }
  )

  it.each([
    {
      name: "foreign lock",
      overrides: {
        lock: { state: "foreign", exactOwnership: false } as const,
      },
      code: "LOCK_NOT_OWNED",
    },
    {
      name: "owned lock without exact operation ownership",
      overrides: {
        // The discriminated union prevents this for typed callers. Keep the
        // planner fail-closed if an untyped runtime boundary supplies a
        // contradictory ownership proof.
        lock: {
          state: "owned",
          exactOwnership: false,
        } as unknown as LocalAuthorityPlanInput["lock"],
      },
      code: "LOCK_NOT_OWNED",
    },
    {
      name: "foreign lock carrying a stale exact-ownership proof",
      overrides: {
        lock: {
          state: "foreign",
          exactOwnership: true,
        } as unknown as LocalAuthorityPlanInput["lock"],
      },
      code: "LOCK_NOT_OWNED",
    },
    {
      name: "recoverable journal",
      overrides: { journal: { state: "recoverable" } as const },
      code: "ACTIVATION_RECOVERY_REQUIRED",
    },
    {
      name: "blocked journal",
      overrides: { journal: { state: "blocked" } as const },
      code: "ACTIVATION_RECOVERY_REQUIRED",
    },
    {
      name: "unknown installed service during a durable change",
      overrides: {
        desired: { ...input().desired, changesDurableState: true },
        service: {
          ...input().service,
          state: "unknown" as const,
        },
      },
      code: "SERVICE_STATE_UNKNOWN",
    },
  ])("refuses $name before selecting an action", ({ overrides, code }) => {
    expect(planLocalAuthority(input(overrides))).toMatchObject({
      action: "refuse",
      code,
    })
  })

  it.each([
    {
      name: "unknown service not installed",
      desired: { ...input().desired, changesDurableState: true },
      service: {
        ...input().service,
        state: "unknown" as const,
        installed: false,
      },
    },
    {
      name: "unknown installed service for a read-only operation",
      desired: { ...input().desired, changesDurableState: false },
      service: {
        ...input().service,
        state: "unknown" as const,
        installed: true,
      },
    },
    {
      name: "known installed service during a durable change",
      desired: { ...input().desired, changesDurableState: true },
      service: {
        ...input().service,
        state: "stopped" as const,
        installed: true,
      },
    },
  ])("does not over-refuse a $name", ({ desired, service }) => {
    expect(planLocalAuthority(input({ desired, service }))).toMatchObject({
      action: "proceed",
    })
  })

  it.each([
    {
      background: true,
      state: "running" as const,
      installed: true,
      startsAtLogin: true,
      action: "install",
      restart: true,
    },
    {
      background: false,
      state: "running" as const,
      installed: true,
      startsAtLogin: true,
      action: "uninstall",
      restart: false,
    },
    {
      background: false,
      state: "not-installed" as const,
      installed: false,
      startsAtLogin: false,
      action: "none",
      restart: false,
    },
  ])(
    "selects the setup service transition for $state/background=$background",
    ({ background, state, installed, startsAtLogin, action, restart }) => {
      const desired = { ...input().desired, background }
      expect(
        planLocalAuthority(
          input({
            desired,
            service: {
              platform: "systemd",
              state,
              installed,
              startsAtLogin,
            },
          })
        )
      ).toMatchObject({
        action: "proceed",
        serviceAction: action,
        restartRunningService: restart,
      })
    }
  )

  it.each([
    {
      operation: "service-attach" as const,
      state: "running" as const,
      background: false,
      action: "restart",
    },
    {
      operation: "restore" as const,
      state: "stopped" as const,
      background: false,
      action: "start",
    },
    {
      operation: "launch" as const,
      state: "not-installed" as const,
      background: true,
      action: "install",
    },
    {
      operation: "launch" as const,
      state: "running" as const,
      background: false,
      action: "none",
    },
  ])(
    "selects $action for $operation with $state/background=$background",
    ({ operation, state, background, action }) => {
      expect(
        planLocalAuthority(
          input({
            operation,
            desired: { ...input().desired, background },
            service: {
              ...input().service,
              state,
              installed: state !== "not-installed",
            },
          })
        )
      ).toMatchObject({
        action: "proceed",
        serviceAction: action,
      })
    }
  )

  it.each([
    {
      name: "missing listener and lease",
      runtime: null,
      endpointState: "unreachable" as const,
      worktableWithoutLiveLease: false,
      expected: { action: "retry", reason: "pending" },
    },
    {
      name: "responsive Worktable without a live lease",
      runtime: null,
      endpointState: "unreachable" as const,
      worktableWithoutLiveLease: true,
      expected: { action: "reject", reason: "unproven-endpoint" },
    },
    {
      name: "temporarily unreachable compatible runtime",
      runtime: { ...input().runtime!, endpointVerified: false },
      endpointState: "unreachable" as const,
      worktableWithoutLiveLease: false,
      expected: { action: "retry", reason: "unreachable" },
    },
    {
      name: "responsive runtime rejecting the private proof",
      runtime: { ...input().runtime!, endpointVerified: false },
      endpointState: "rejected" as const,
      worktableWithoutLiveLease: false,
      expected: { action: "reject", reason: "proof-rejected" },
    },
    {
      name: "exact authenticated runtime",
      runtime: input().runtime!,
      endpointState: "verified" as const,
      worktableWithoutLiveLease: false,
      expected: { action: "ready" },
    },
    {
      name: "unreachable runtime for a different destination",
      runtime: {
        ...input().runtime!,
        endpointVerified: false,
        workspaceId: "workspace-b",
      },
      endpointState: "unreachable" as const,
      worktableWithoutLiveLease: false,
      expected: { action: "reject", reason: "destination-conflict" },
    },
  ])(
    "classifies $name during authenticated readiness",
    ({ expected, ...observation }) => {
      expect(classifyRuntimeReadiness(observation, input().desired)).toEqual(
        expected
      )
    }
  )

  it("keeps operator diagnostics distinct and secret-free", () => {
    const origin = "http://127.0.0.1:17480"
    const cases: Array<[ExactRuntimeReadinessFailure, string]> = [
      ["absent", "stopped before publishing"],
      ["pending-deadline", "did not become reachable"],
      ["unreachable-deadline", "before the readiness deadline"],
      ["unproven-endpoint", "no live local runtime lease"],
      ["proof-rejected", "rejected Worktable's authenticated"],
      ["destination-conflict", "different workspace or endpoint"],
      ["owner-conflict", "different Worktable launch mode"],
      ["manager-conflict", "not owned by the installed service manager"],
    ]
    const messages = cases.map(([reason, diagnostic]) => {
      const message = describeRuntimeReadinessFailure(reason, origin)
      expect(message).toContain(origin)
      expect(message).toContain(diagnostic)
      expect(message).not.toContain("proof-token")
      return message
    })
    expect(new Set(messages).size).toBe(cases.length)
  })

  it("requires every workspace and endpoint proof field to match", () => {
    fc.assert(
      fc.property(
        fc.record({
          workspaceId: fc.uuid(),
          workspacePath: fc
            .array(fc.string({ minLength: 1, maxLength: 8 }), {
              minLength: 1,
              maxLength: 4,
            })
            .map((parts) => `/tmp/${parts.join("/")}`),
          host: fc.oneof(
            fc.constant("127.0.0.1"),
            fc.constant("localhost"),
            fc.ipV4()
          ),
          port: fc.integer({ min: 1, max: 65_535 }),
        }),
        (expected) => {
          const proof = {
            processAlive: true,
            endpointVerified: true,
            ...expected,
          }
          expect(runtimeProvesWorkspaceEndpoint(proof, expected)).toBe(true)
          expect(
            runtimeProvesWorkspaceEndpoint(
              { ...proof, processAlive: false },
              expected
            )
          ).toBe(false)
          expect(
            runtimeProvesWorkspaceEndpoint(
              { ...proof, endpointVerified: false },
              expected
            )
          ).toBe(false)
          expect(
            runtimeProvesWorkspaceEndpoint(
              { ...proof, workspaceId: `${proof.workspaceId}-foreign` },
              expected
            )
          ).toBe(false)
          expect(
            runtimeProvesWorkspaceEndpoint(
              { ...proof, workspacePath: `${proof.workspacePath}-foreign` },
              expected
            )
          ).toBe(false)
          expect(
            runtimeProvesWorkspaceEndpoint(
              {
                ...proof,
                port: proof.port === 65_535 ? 65_534 : proof.port + 1,
              },
              expected
            )
          ).toBe(false)
        }
      )
    )
  })
})
