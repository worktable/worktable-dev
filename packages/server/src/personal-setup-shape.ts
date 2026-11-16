import { z } from "zod"
import {
  HELP_EVIDENCE_IDS,
  HELP_ID_PATTERN,
  HELP_STATE_MAX,
  SETUP_ITEM_IDS,
  type PersonalSetup,
} from "@worktable/types/setup"

const EvidenceSchema = z.object({
  at: z.string().min(1).max(40),
  spaceId: z.string().min(1).max(200).optional(),
  path: z.string().min(1).max(1000).optional(),
  skipped: z.boolean().optional(),
})

const ITEM_IDS = new Set<string>(SETUP_ITEM_IDS)
const EVIDENCE_IDS = new Set<string>(HELP_EVIDENCE_IDS)

const HelpStateSchema = z.object({
  shown: z.number().int().min(0).max(10_000),
  lastShownAt: z.string().max(40).optional(),
  closedAt: z.string().max(40).optional(),
  doneAt: z.string().max(40).optional(),
  optedOut: z.boolean().optional(),
  version: z.number().int().min(0).max(1000).optional(),
})

/** Keeps only well-formed entries: a bad one is dropped, not fatal. */
function knownEntries(
  value: unknown,
  keep: (id: string) => boolean
): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([id]) => keep(id)))
    : value
}

export const PersonalSetupSchema = z.object({
  // Items a later version no longer lists are dropped, not fatal.
  items: z.preprocess(
    (value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).filter(([id]) => ITEM_IDS.has(id))
          )
        : value,
    z.partialRecord(z.enum(SETUP_ITEM_IDS), EvidenceSchema)
  ),
  hidden: z.boolean().optional(),
  welcomed: z.boolean().optional(),
  help: z
    .preprocess(
      (value) => {
        const known = knownEntries(value, (id) => HELP_ID_PATTERN.test(id))
        if (!known || typeof known !== "object") return known
        const entries = Object.entries(known).filter(
          ([, state]) => HelpStateSchema.safeParse(state).success
        )
        return Object.fromEntries(entries.slice(-HELP_STATE_MAX))
      },
      z.record(z.string(), HelpStateSchema)
    )
    .optional(),
  helpEvidence: z
    .preprocess(
      (value) => knownEntries(value, (id) => EVIDENCE_IDS.has(id)),
      z.partialRecord(z.enum(HELP_EVIDENCE_IDS), EvidenceSchema)
    )
    .optional(),
  agentsSeen: z.array(z.string().min(1).max(200)).max(5).optional(),
  tryNextHidden: z.boolean().optional(),
})

/** A stored setup, or undefined when it is missing or unreadable. */
export function parsePersonalSetup(value: unknown): PersonalSetup | undefined {
  if (value === undefined) return undefined
  const parsed = PersonalSetupSchema.safeParse(value)
  return parsed.success ? (parsed.data as PersonalSetup) : undefined
}
