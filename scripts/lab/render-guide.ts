import type {
  AgentPreflight,
  AgentVersions,
  LabAuthMode,
  LocalLabNetwork,
  LocalSource,
  NetworkInfo,
} from "./types.ts"
import {
  fixtureReview,
  type FixtureReview,
  type ReviewCheck,
} from "./fixture-review.ts"

interface GuideOptions {
  kind: "cloud" | "local" | "openclaw" | "auth" | "client"
  name: string
  ttl: string
  versions: AgentVersions
  auth: AgentPreflight["auth"]
  authMode?: LabAuthMode
  network?: NetworkInfo
  origin?: string
  target?: string
  callbackHostPort?: number
  local?: LocalLabNetwork & {
    source: LocalSource
    fixture?: string
  }
}

export interface DesktopGuideOptions {
  name: string
  ttl: string
  root: string
  home: string
  appData: string
  defaultWorkspace: string
  fixture?: string
  fixtureWorkspace?: string
  sourceCommit: string
  stdoutLog: string
  stderrLog: string
  guide: string
  keep: boolean
}

export interface GuideSection {
  title: string
  lines: string[]
}

export interface GuideCommand {
  label: string
  command: string
}

export interface LabGuide {
  title: string
  summary: string[]
  commands: GuideCommand[]
  nextSteps: string[]
  uiReview: ReviewCheck[]
  agentReview: ReviewCheck[]
  optional: GuideSection[]
  diagnostics: GuideSection[]
  runDetails: GuideSection[]
}

function bullets(lines: string[]): string[] {
  return lines.map((line) => `• ${line}`)
}

function checks(items: ReviewCheck[]): string[] {
  return items.map((item) => `• ${item.title}: ${item.instruction}`)
}

function terminalCommands(commands: GuideCommand[]): string[] {
  return commands.flatMap((step, index) => [
    `${index + 1}. ${step.label}`,
    ...step.command.split("\n").map((line) => `   ${line}`),
    "",
  ])
}

function detailedCommands(commands: GuideCommand[]): string[] {
  return commands.flatMap((step, index) => [
    `### ${index + 1}. ${step.label}`,
    "",
    "```sh",
    step.command,
    "```",
    "",
  ])
}

export function renderTerminalGuide(guide: LabGuide): string {
  return [
    guide.title,
    "",
    ...(guide.summary.length > 0 ? [...guide.summary, ""] : []),
    "Commands in order",
    "",
    ...terminalCommands(guide.commands),
    "Flow and explanations",
    ...bullets(guide.nextSteps),
    "",
    "Review the UI",
    ...checks(guide.uiReview),
    "",
    "Review through an agent",
    ...checks(guide.agentReview),
  ].join("\n")
}

export function renderDetailedGuide(guide: LabGuide): string {
  const lines = [
    `# ${guide.title}`,
    "",
    ...guide.summary,
    "",
    "## Commands in order",
    "",
    ...detailedCommands(guide.commands),
    "## Flow and explanations",
    "",
    ...bullets(guide.nextSteps),
    "",
    "## UI review",
    "",
    ...checks(guide.uiReview),
    "",
    "## Agent and MCP review",
    "",
    ...checks(guide.agentReview),
  ]
  for (const section of [
    ...guide.optional,
    ...guide.diagnostics,
    ...guide.runDetails,
  ]) {
    lines.push("", `## ${section.title}`, "", ...section.lines)
  }
  return `${lines.join("\n").trim()}\n`
}

function fixtureAgentChecks(review: FixtureReview): ReviewCheck[] {
  return [
    {
      title: "Connect one isolated agent",
      instruction:
        "Generate a code in Settings → Agents, then follow the printed lab agent command in another terminal.",
    },
    {
      title: "Run the MCP checklist",
      instruction:
        "Ask the agent to read MCP_REVIEW.md, work one check at a time, and pause before the mutation check.",
    },
    {
      title: "Confirm the path",
      instruction:
        "Inspect agent tool activity and confirm it used Worktable tools rather than shell or direct fixture-file reads.",
    },
  ]
}

function desktopGuide(options: DesktopGuideOptions): LabGuide {
  const review = fixtureReview(options.fixture)
  const namedFixture =
    options.fixture && options.fixture !== "empty" ? options.fixture : undefined
  const nextSteps = namedFixture
    ? [
        "Worktable is opening.",
        "Click “Open an existing workspace.”",
        `Choose “${namedFixture}”; the picker opens in the correct location.`,
        "Continue through Worktable normally and quit it when the review is complete.",
      ]
    : [
        "Worktable is opening.",
        "Click “Create a new workspace.”",
        "The proposed location is isolated from your normal Worktable data.",
        "Continue through Worktable normally and quit it when the review is complete.",
      ]
  const exactAgentCommand = `bun run lab -- agent codex --name ${options.name}`
  const restartCommand = [
    "bun run lab -- desktop",
    `  --name ${options.name}`,
    ...(options.fixture ? [`  --fixture ${options.fixture}`] : []),
    "  --keep",
  ].join(" \\\n")
  return {
    title: `Desktop lab: ${namedFixture ?? (options.fixture === "empty" ? "empty workspace" : "first run")}`,
    summary: [
      `Run: ${options.name}`,
      `Purpose: ${review.purpose}`,
      `Detailed guide and logs: ${options.guide}`,
    ],
    commands: [
      {
        label:
          "After generating a pairing code, launch the isolated agent in another host terminal",
        command: exactAgentCommand,
      },
    ],
    nextSteps,
    uiReview: review.uiChecks,
    agentReview: [
      {
        title: "Generate a pairing code",
        instruction:
          "In Worktable, open Settings → Agents and generate a code for Codex, Claude Code, or OpenCode.",
      },
      {
        title: "Launch the isolated agent",
        instruction:
          "Use the isolated agent command listed above. Replace Codex with Claude Code or OpenCode when needed, then paste the pairing code.",
      },
      ...fixtureAgentChecks(review).slice(1),
    ],
    optional: [
      {
        title: "Restart and recovery",
        lines: [
          "Use a named retained run when the review must span application launches:",
          "",
          "```sh",
          restartCommand,
          "```",
          "",
          "Quit Worktable and run the same command again. The same isolated Desktop profile and workspace state will be reused.",
        ],
      },
      {
        title: "Agent authentication",
        lines: [
          "Worktable pairing and provider authentication are separate.",
          "The lab never reads your normal agent login cache, so the isolated Codex, Claude Code, or OpenCode process may ask you to sign in.",
          "Exit the agent before quitting Worktable when possible. If Worktable exits first, the lab launcher stops the isolated agent.",
        ],
      },
    ],
    diagnostics: [
      {
        title: "Diagnostics",
        lines: [
          `Desktop stdout: ${options.stdoutLog}`,
          `Desktop stderr: ${options.stderrLog}`,
          "A failure retains the run for diagnosis.",
        ],
      },
    ],
    runDetails: [
      {
        title: "Run details and isolation",
        lines: [
          `Lifetime: ${options.ttl}`,
          `Source commit: ${options.sourceCommit}`,
          `Lab root: ${options.root}`,
          `Isolated HOME: ${options.home}`,
          `Desktop data: ${options.appData}`,
          `Default workspace: ${options.defaultWorkspace}`,
          ...(options.fixtureWorkspace
            ? [`Fixture workspace: ${options.fixtureWorkspace}`]
            : []),
          "The harness does not set the ephemeral workspace override. Onboarding, profile persistence, and sidecar ownership are the real packaged paths.",
          options.keep
            ? "This run is retained after exit because --keep is set."
            : "A successful normal exit removes this run. Failures retain it for diagnosis.",
        ],
      },
    ],
  }
}

export function renderDesktopGuide(options: DesktopGuideOptions): string {
  return renderDetailedGuide(desktopGuide(options))
}

export function renderDesktopGuideSummary(
  options: DesktopGuideOptions
): string {
  const guide = desktopGuide(options)
  return `${renderTerminalGuide({ ...guide, summary: [] })}\n\nDetailed guide and logs: ${options.guide}`
}

function providerStatus(options: GuideOptions): string[] {
  const claude =
    options.auth.claude.kind === "secret"
      ? `Claude Code can use ephemeral ${options.auth.claude.envName}.`
      : "The reusable profile may already contain Claude Code authentication; the readiness check reports when login is needed."
  const codex =
    options.auth.codex.kind === "secret"
      ? `Codex can use ephemeral ${options.auth.codex.envName}.`
      : "The reusable profile may already contain Codex authentication; the readiness check reports when login is needed."
  const profile =
    options.authMode === "ready"
      ? "Reusable lab authentication is mounted. Logins completed here remain available to later ready labs."
      : "Clean mode is active. Provider logins are discarded with this sandbox."
  const openclaw = options.versions.openclaw
    ? "OpenClaw is preconfigured to use its Codex harness against the isolated lab Codex profile. Run agent commands as `tester`; root has a separate empty OpenClaw state. `~/bin/lab-status` verifies the complete route."
    : undefined
  return [profile, claude, codex, ...(openclaw ? [openclaw] : [])]
}

function sandboxGuide(options: GuideOptions): LabGuide {
  if (options.callbackHostPort && !options.network)
    throw new Error("Cloud callback guide requires host network information")
  if (options.kind === "auth") {
    return {
      title: "Reusable agent authentication setup",
      summary: providerStatus(options),
      commands: [
        { label: "Check Claude Code", command: "claude auth status" },
        {
          label: "Only when Claude Code is not ready",
          command: "claude auth login",
        },
        { label: "Check Codex", command: "codex login status" },
        {
          label: "Only when Codex is not ready",
          command: "codex login --device-auth",
        },
        {
          label: "Check the complete lab profile",
          command: "~/bin/lab-status",
        },
        { label: "Finish and retain the reusable login", command: "exit" },
      ],
      nextSteps: [
        "Check each provider first and authenticate only the provider that is not ready.",
        ...(options.versions.openclaw
          ? [
              "OpenClaw is ready when both Codex and the OpenClaw Codex runtime report ready.",
            ]
          : []),
        "Exiting removes the setup guest but retains the reusable provider login volume.",
      ],
      uiReview: [],
      agentReview: [],
      optional: [],
      diagnostics: [],
      runDetails: [
        {
          title: "Credential boundary",
          lines: [
            "This setup writes only to the reusable Worktable lab auth volume.",
            "It does not modify the workspace or personal OpenClaw state.",
            "Only one ready lab may mount the profile at a time.",
          ],
        },
      ],
    }
  }
  const review = options.local
    ? fixtureReview(options.local.fixture)
    : undefined
  const isOpenClaw = options.kind === "openclaw"
  const destination =
    options.kind === "cloud"
      ? `Cloud staging: ${options.origin}`
      : options.kind === "client"
        ? `Target: ${options.target ?? "choose or paste a Worktable invitation"}`
        : `Mac URL: ${options.local!.publicOrigin}`
  const uiReview: ReviewCheck[] = options.local
    ? [
        {
          title: "Install and set up Worktable",
          instruction:
            "Inspect ./install-worktable.sh, run it, choose an owner password, and complete the real setup flow.",
        },
        {
          title: "Review from the Mac",
          instruction: `Open ${options.local.publicOrigin}, sign in, and inspect navigation, Settings, and the prepared workspace.`,
        },
        ...(isOpenClaw
          ? [
              {
                title: "Pair OpenClaw",
                instruction:
                  "In Settings → Agents, open Always-on agents, keep OpenClaw as the participant name, and run the displayed OpenClaw pairing command inside this lab. No Space selection is required.",
              },
            ]
          : []),
        ...(review?.uiChecks ?? []),
      ]
    : [
        {
          title: "Open Worktable",
          instruction: `Open ${options.kind === "cloud" ? options.origin : (options.target ?? "the invitation target")} on the Mac and complete the visible user flow.`,
        },
        {
          title: "Inspect the result",
          instruction:
            "Check navigation, content, Settings → Agents, and any attribution created during the agent pass.",
        },
      ]
  const agentReview: ReviewCheck[] = isOpenClaw
    ? [
        {
          title: "Verify the packaged channel",
          instruction:
            "The packaged-channel command above should report that the Worktable channel is loaded. A root shell intentionally sees a separate empty OpenClaw profile.",
        },
        {
          title: "Authenticate OpenClaw",
          instruction:
            "Run `~/bin/lab-status`. OpenClaw reuses the isolated lab Codex subscription through the supported Codex harness; no second provider login is needed when Codex reports ready.",
        },
        {
          title: "Pair and start the Gateway",
          instruction:
            "Use the connection and second-shell commands above, then keep the foreground Gateway visible while testing.",
        },
        {
          title: "Prove thread continuity",
          instruction:
            "Start a general Worktable thread with OpenClaw and a contextual Space thread, wait for replies, then follow up in the same threads and confirm native conversation context is retained.",
        },
        {
          title: "Probe recovery when relevant",
          instruction:
            "When delivery, channel, or Gateway behavior changed, stop the Gateway with a message pending, restart it, and confirm one reply without duplicate agent runs.",
        },
      ]
    : review
      ? [
          {
            title: "Choose one agent",
            instruction:
              "Connect either Claude Code or Codex during setup (or with `worktable mcp setup <client>`), and use that client for the primary pass.",
          },
          ...review.mcpChecks.map((check) => ({
            title: check.title,
            instruction: check.instruction,
          })),
          {
            title: "Confirm the path",
            instruction:
              "Inspect agent tool activity and confirm it used Worktable tools rather than direct workspace-file reads.",
          },
        ]
      : [
          {
            title: "Choose one agent",
            instruction:
              "Use either Claude Code or Codex for the primary pass; repeat with the other only when useful.",
          },
          {
            title: "Connect through Worktable",
            instruction:
              "Open Settings → Agents at the target and follow the selected agent’s displayed connection flow.",
          },
          {
            title: "Prove MCP behavior",
            instruction:
              "Run discovery, read, and one visible writeback through Worktable tools, then inspect the result and attribution in the UI.",
          },
        ]
  const nextSteps = isOpenClaw
    ? [
        "Confirm readiness first; authenticate Codex only if the reusable Codex profile is not ready.",
        "Inspect the generated installer before running it.",
        "Complete Worktable setup and open the printed Mac URL.",
        "In Settings → Agents, create the OpenClaw connection and paste its displayed command into the first lab shell.",
        "Keep the Gateway running in the second shell while exercising one new thread plus a follow-up.",
      ]
    : options.local
      ? [
          "Check readiness, choose one primary agent, and authenticate only that provider if needed.",
          "Inspect the generated installer before running it.",
          "Complete Worktable setup and open the printed Mac URL.",
          "Work through the UI and agent review lanes below.",
        ]
      : [
          "Check readiness, choose Claude Code or Codex for the primary pass, and authenticate only that provider if needed.",
          "Open Worktable Settings → Agents at the target and follow its connection flow.",
          "Complete one real MCP read and one visible writeback.",
        ]
  const commands: GuideCommand[] = isOpenClaw
    ? [
        { label: "Check lab readiness", command: "~/bin/lab-status" },
        {
          label: "Only if Codex is not ready",
          command: "codex login --device-auth",
        },
        {
          label: "Verify the packaged Worktable channel",
          command: "openclaw plugins inspect worktable --runtime --json",
        },
        {
          label: "Inspect the Worktable installer",
          command: "cat ~/install-worktable.sh",
        },
        {
          label: "Install and start Worktable",
          command: "./install-worktable.sh",
        },
        {
          label: "Connect OpenClaw after creating the connection in Worktable",
          command:
            "# Paste the `openclaw worktable connect ...` command shown in Settings → Agents",
        },
        {
          label: "In a second host terminal, enter this lab as tester",
          command: `msb exec --tty --user tester ${options.name} -- bash -l`,
        },
        {
          label: "Inside that second lab shell, start the Gateway",
          command: "openclaw gateway run",
        },
        {
          label: "After the conversation review, capture sanitized evidence",
          command: "~/bin/lab-evidence",
        },
      ]
    : options.local
      ? [
          { label: "Check lab readiness", command: "~/bin/lab-status" },
          {
            label: "Only if Claude Code is the chosen agent and is not ready",
            command: "claude auth login",
          },
          {
            label: "Only if Codex is the chosen agent and is not ready",
            command: "codex login --device-auth",
          },
          {
            label: "Inspect the Worktable installer",
            command: "cat ~/install-worktable.sh",
          },
          {
            label: "Install and start Worktable",
            command: "./install-worktable.sh",
          },
          {
            label:
              "Connect the chosen agent after creating its connection in Worktable",
            command:
              "# Paste the connection command shown in Settings → Agents",
          },
          {
            label: "After the review, capture sanitized evidence",
            command: "~/bin/lab-evidence",
          },
        ]
      : [
          { label: "Check lab readiness", command: "~/bin/lab-status" },
          {
            label: "Only if Claude Code is the chosen agent and is not ready",
            command: "claude auth login",
          },
          {
            label: "Only if Codex is the chosen agent and is not ready",
            command: "codex login --device-auth",
          },
          {
            label: "Connect the chosen agent from Worktable",
            command:
              "# Paste the connection command shown in Settings → Agents",
          },
        ]
  return {
    title: `Worktable ${options.kind} lab`,
    summary: [
      `Sandbox: ${options.name}`,
      destination,
      ...(options.local
        ? [
            "Security: the Mac / LAN HTTP endpoint is cleartext. Use it only on a trusted network; passwords, cookies, and MCP credentials are not encrypted in transit.",
          ]
        : []),
      "The harness has not connected Worktable; pairing remains part of the real user journey.",
    ],
    commands,
    nextSteps,
    uiReview,
    agentReview,
    optional: [
      {
        title: "Agent login status",
        lines: [
          ...providerStatus(options),
          "Useful checks: `claude auth status`, `codex login status`, and `~/bin/lab-status`.",
          isOpenClaw
            ? "Claude Code and Codex are also installed for cross-agent exploration, but they are not required for the OpenClaw acceptance path."
            : "Both clients are installed, but one complete primary pass is enough unless comparison is the goal.",
        ],
      },
    ],
    diagnostics: [
      {
        title: "Diagnostics",
        lines: options.local
          ? [
              "Use `worktable doctor`, `worktable status`, and `worktable paths`.",
              "Run `~/bin/lab-evidence` after the review for a body-free report of workspace changes, thread envelopes, delivery states, and Gateway outcomes.",
              "If setup exits without leaving Worktable running, use `./launch-worktable.sh`.",
            ]
          : ["The full guide remains available at ~/WORKTABLE_LAB.txt."],
      },
    ],
    runDetails: [
      {
        title: "Run details and isolation",
        lines: [
          `Lifetime: ${options.ttl}`,
          `Claude Code: ${options.versions.claude}`,
          `Codex: ${options.versions.codex}`,
          ...(options.versions.openclaw
            ? [`OpenClaw: ${options.versions.openclaw}`]
            : []),
          ...(options.callbackHostPort && options.network
            ? [
                `Codex callback: http://${options.network.lanAddress}:${options.callbackHostPort}/callback`,
              ]
            : []),
          ...(options.local
            ? [
                `Source: ${options.local.source}`,
                `Fixture: ${options.local.fixture ?? "none"}`,
                `Inside guest: http://127.0.0.1:7432`,
                `Linux host: ${options.local.loopbackOrigin}`,
                `Mac / LAN: ${options.local.lanOrigin}`,
                `MCP endpoint: ${options.local.publicOrigin}/mcp`,
              ]
            : []),
          options.authMode === "ready"
            ? "Provider logins live in the dedicated reusable lab profile, never in the workspace or personal OpenClaw state."
            : "Clean mode keeps provider state in disposable memory and removes it with the sandbox.",
        ],
      },
    ],
  }
}

export function renderGuide(options: GuideOptions): string {
  return renderDetailedGuide(sandboxGuide(options))
}

export function renderGuideSummary(options: GuideOptions): string {
  const guide = sandboxGuide(options)
  return `${renderTerminalGuide(guide)}\n\nFull guide: ~/WORKTABLE_LAB.txt`
}
