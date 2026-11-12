import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core"
import { OWNER_NAMING_WORKTABLE_VERSION } from "./src/access.js"
import {
  pairWorktableChannel,
  requestWorktablePairing,
  type PairedWorktable,
} from "./src/pairing.js"
import { worktableChannel } from "./src/channel.js"
import { setWorktableRuntime } from "./src/runtime.js"

/** Say what was connected and who it now takes direction from. */
function reportPaired(result: PairedWorktable): void {
  const participant = result.participantName
    ? ` as ${result.participantName}`
    : ""
  console.log(`Configured Worktable ${result.workspaceName}${participant}.`)
  if (!result.access.ownerMemberId) {
    console.error(
      `This Worktable did not say who approved the connection, so OpenClaw will refuse thread messages. Update Worktable to ${OWNER_NAMING_WORKTABLE_VERSION} or later, then run this command again.`
    )
  } else {
    const others = [
      result.access.trustAllMembers ? "all members" : "",
      result.access.trustAllAgents ? "all agents" : "",
    ].filter(Boolean)
    console.log(
      others.length > 0
        ? `It takes direction from the person who approved it and, as set before, ${others.join(" and ")}.`
        : "It takes direction from the person who approved it. Everyone else is refused."
    )
  }
  console.log(
    "Start or restart the OpenClaw Gateway to verify and start the channel."
  )
}

export default defineChannelPluginEntry({
  id: "worktable",
  name: "Worktable",
  description:
    "Connect OpenClaw to a persistent workspace shared with your agents—local, self-hosted, or in the cloud.",
  plugin: worktableChannel,
  setRuntime: setWorktableRuntime,
  registerCliMetadata(api) {
    api.registerCli(
      ({ program }) => {
        program
          .command("worktable")
          .description("Manage the Worktable channel")
          .command("connect")
          .description(
            "Connect Worktable: approve this installation there, or use a pairing code"
          )
          .requiredOption("--server <url>", "Worktable server origin")
          .option("--pairing-code <code>", "Single-use Worktable pairing code")
          .option("--participant-name <name>", "Worktable participant name")
          .option(
            "--agent-registration",
            "No longer supported; approve the connection in Worktable instead"
          )
          .action(
            async (options: {
              server: string
              pairingCode?: string
              participantName?: string
              agentRegistration?: boolean
            }) => {
              // OpenClaw reports a rejected command without its reason, so
              // say why here.
              try {
                if (options.agentRegistration) {
                  // That sign-up could not say who connected OpenClaw.
                  throw new Error(
                    "Agent Registration is no longer supported. Run this command without --agent-registration and approve the connection in Worktable."
                  )
                }
                if (options.pairingCode) {
                  reportPaired(
                    await pairWorktableChannel({
                      server: options.server,
                      pairingCode: options.pairingCode,
                    })
                  )
                  return
                }
                // Ask Worktable; its owner approves this installation there.
                reportPaired(
                  await requestWorktablePairing({
                    server: options.server,
                    participantName: options.participantName,
                    onApprovalNeeded({ code, approvalUrl }) {
                      // Written directly: OpenClaw masks token-like console text.
                      process.stdout.write(
                        `Approve this OpenClaw in Worktable:\n${approvalUrl}\nCheck that Worktable shows ${code}. Waiting for approval…\n`
                      )
                    },
                  })
                )
              } catch (error) {
                console.error(
                  error instanceof Error ? error.message : String(error)
                )
                process.exitCode = 1
              }
            }
          )
      },
      {
        descriptors: [
          {
            name: "worktable",
            description: "Manage the Worktable channel",
            hasSubcommands: true,
          },
        ],
      }
    )
  },
})
