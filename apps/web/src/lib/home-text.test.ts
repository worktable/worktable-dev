import { expect, it } from "bun:test"
import { plainText, readableAgentName } from "./home-text"

it("names an agent by what it is, not the machine or service running it", () => {
  expect(readableAgentName("claude-code@work-laptop")).toBe("Claude Code")
  expect(readableAgentName("managed:claude-code")).toBe("Claude Code")
  expect(readableAgentName("codex@home-desktop")).toBe("Codex")
  expect(readableAgentName("openclaw@cloud-box")).toBe("OpenClaw")
  // Names an agent was given stay as they are.
  expect(readableAgentName("Sage (Claude)")).toBe("Sage (Claude)")
  expect(readableAgentName("ChatGPT")).toBe("ChatGPT")
})

it("reads an agent's Markdown as plain text", () => {
  expect(
    plainText("**Ticket 42 grooming:** Hi _Sam_, see [the plan](plan).\n- one\n- `two`")
  ).toBe("Ticket 42 grooming: Hi Sam, see the plan. one two")
  // Snake case and arithmetic aren't emphasis.
  expect(plainText("set max_retries to 2 * 3")).toBe("set max_retries to 2 * 3")
})
