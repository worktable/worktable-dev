import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core"
import { createInterface } from "node:readline/promises"
import {
  pairWorktableChannel,
  registerWorktableAgent,
  requestWorktablePairing,
} from "./src/pairing.js"
import { worktableChannel } from "./src/channel.js"
import { setWorktableRuntime } from "./src/runtime.js"

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
          .option(
            "--agent-registration",
            "Register this OpenClaw installation with Worktable Cloud"
          )
          .option("--email <email>", "Worktable Cloud account email")
          .option("--participant-name <name>", "Worktable participant name")
          .action(
            async (options: {
              server: string
              pairingCode?: string
              agentRegistration?: boolean
              email?: string
              participantName?: string
            }) => {
              if (options.pairingCode && options.agentRegistration) {
                throw new Error(
                  "Choose one of --pairing-code or --agent-registration"
                )
              }
              if (!options.pairingCode && !options.agentRegistration) {
                // Ask Worktable; its owner approves this installation there.
                const result = await requestWorktablePairing({
                  server: options.server,
                  participantName: options.participantName,
                  onApprovalNeeded({ code, approvalUrl }) {
                    // Written directly: OpenClaw masks token-like console text.
                    process.stdout.write(
                      `Approve this OpenClaw in Worktable:\n${approvalUrl}\nCheck that Worktable shows ${code}. Waiting for approval…\n`
                    )
                  },
                })
                const participant = result.participantName
                  ? ` as ${result.participantName}`
                  : ""
                console.log(
                  `Configured Worktable ${result.workspaceName}${participant}.`
                )
                console.log(
                  "Start or restart the OpenClaw Gateway to verify and start the channel."
                )
                return
              }
              if (options.agentRegistration) {
                const prompt = createInterface({
                  input: process.stdin,
                  output: process.stdout,
                })
                try {
                  const email =
                    options.email ??
                    (await prompt.question("Worktable Cloud email: "))
                  const participantName =
                    options.participantName ??
                    (await prompt.question(
                      "Participant name: "
                    ))
                  const result = await registerWorktableAgent({
                    server: options.server,
                    email,
                    participantName,
                    async readUserCode(verificationUri) {
                      // OpenClaw masks token-like text in console output, which
                      // would make the claim link unusable.
                      process.stdout.write(
                        `Open this URL, sign in, and view the claim code:\n${verificationUri}\n`
                      )
                      return prompt.question("Claim code: ")
                    },
                  })
                  console.log(
                    `Configured Worktable Cloud as ${result.participantName}.`
                  )
                  console.log(
                    "Start or restart the OpenClaw Gateway to start the channel."
                  )
                  return
                } finally {
                  prompt.close()
                }
              }
              const result = await pairWorktableChannel({
                server: options.server,
                pairingCode: options.pairingCode!,
              })
              const participant = result.participantName
                ? ` as ${result.participantName}`
                : ""
              console.log(
                `Configured Worktable ${result.workspaceName}${participant}.`
              )
              console.log(
                "Start or restart the OpenClaw Gateway to verify and start the channel."
              )
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
