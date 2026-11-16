// Skills over MCP (the io.modelcontextprotocol/skills extension, SEP-2640),
// preview only.
//
// An app that supports the extension lists the team's Library skills with
// its own and loads one when it applies, without the model having to call a
// tool first. Each skill an agent's libraries hold is one SKILL.md: its name
// and when to use it as frontmatter, then its live version. The URI says
// which library it is in, so a name two libraries share stays two skills:
//   skill://worktable/<name>/SKILL.md
//   skill://space/<spaceId>/<name>/SKILL.md
//   skill://yours/<name>/SKILL.md
// The skills worktable_skills_read lists are the same ones, read the same way.

import { createHash } from "node:crypto"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { McpError } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { liveSkillText, skillsForAgent, type AgentSkill, type SkillReader } from "../skill-libraries.ts"

export const SKILLS_EXTENSION = "io.modelcontextprotocol/skills"

/** The JSON-RPC code for a skill or resource this server doesn't serve. */
const INVALID_PARAMS = -32602

export function skillUri(skill: AgentSkill): string {
  const { library, name } = skill.entry
  const prefix =
    library.kind === "space" ? `space/${encodeURIComponent(library.spaceId)}` : library.kind === "agent" ? "yours" : "worktable"
  return `skill://${prefix}/${name}/SKILL.md`
}

function frontmatter(skill: AgentSkill) {
  return { name: skill.entry.name, description: skill.entry.description.replace(/\s+/g, " ").trim() }
}

/** A skill's SKILL.md: its frontmatter, then its live version. */
async function skillFile(skill: AgentSkill): Promise<string> {
  const { name, description } = frontmatter(skill)
  // A JSON string is a YAML double-quoted scalar, so any description parses back as itself.
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${await liveSkillText(skill)}`
}

async function entryOf(skill: AgentSkill) {
  const uri = skillUri(skill)
  const bytes = Buffer.from(await skillFile(skill), "utf8")
  return {
    uri,
    frontmatter: frontmatter(skill),
    resources: [{ uri, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, size: bytes.length }],
  }
}

async function skillAt(reader: SkillReader, uri: unknown): Promise<AgentSkill> {
  const { live } = await skillsForAgent(reader)
  const skill = typeof uri === "string" ? live.find((candidate) => skillUri(candidate) === uri) : undefined
  if (!skill) throw new SkillsError(`No skill at ${String(uri)} applies to you.`)
  return skill
}

export class SkillsError extends Error {
  readonly code = INVALID_PARAMS
}

/** The extension's methods, as the agent the reader stands for. */
export function skillsMethods(reader: () => Promise<SkillReader>) {
  return {
    async list() {
      const { live } = await skillsForAgent(await reader())
      return { resultType: "complete", skills: await Promise.all(live.map(entryOf)) }
    },
    async get(params: { uri?: unknown } | undefined) {
      return { resultType: "complete", skill: await entryOf(await skillAt(await reader(), params?.uri)) }
    },
    async resources() {
      const { live } = await skillsForAgent(await reader())
      return {
        resources: live.map((skill) => ({
          uri: skillUri(skill),
          name: skill.entry.name,
          description: frontmatter(skill).description,
          mimeType: "text/markdown",
        })),
      }
    },
    async read(params: { uri?: unknown } | undefined) {
      const skill = await skillAt(await reader(), params?.uri)
      return { contents: [{ uri: skillUri(skill), mimeType: "text/markdown", text: await skillFile(skill) }] }
    },
  }
}

const Params = z.looseObject({ uri: z.unknown().optional() }).optional()
const method = (name: string) => z.object({ method: z.literal(name), params: Params })

/** Serve the extension on a server whose capabilities declare it and resources. */
export function registerSkillsExtension(server: McpServer, reader: () => Promise<SkillReader>): void {
  const methods = skillsMethods(reader)
  const answer = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run()
    } catch (error) {
      if (error instanceof SkillsError) throw new McpError(error.code, error.message)
      throw error
    }
  }
  const low = server.server
  low.setRequestHandler(method("skills/list"), () => answer(() => methods.list()) as never)
  low.setRequestHandler(method("skills/get"), (request) => answer(() => methods.get(request.params)) as never)
  low.setRequestHandler(method("resources/list"), () => answer(() => methods.resources()) as never)
  low.setRequestHandler(method("resources/read"), (request) => answer(() => methods.read(request.params)) as never)
}
