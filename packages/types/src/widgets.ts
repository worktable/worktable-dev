import { z } from "zod";
import { CANONICAL_ID_PATTERN } from "./constants";

export const CanonicalIdSchema = z.string().min(1).regex(CANONICAL_ID_PATTERN);

// Route suffixes under /widgets/<id>/... — forbidden as segments of NESTED ids
// so a widget id can never contain a `/records/` or `/state` boundary. Without
// this, widget `a` could reach sibling widget `a/records/b` through the
// broker's `<base>records/` prefix allow-list, and splat route parsing would be
// ambiguous. A FLAT (single-segment) id may be a reserved word: the position
// immediately after /widgets/ can never be an action, so flat reserved ids are
// unambiguous — and they were valid before path-style ids, so existing widgets
// named e.g. `state` keep working after upgrade.
export const WIDGET_RESERVED_SEGMENTS = ["records", "state", "content", "archive", "restore", "versions", "review"] as const;

const RESERVED = new Set<string>(WIDGET_RESERVED_SEGMENTS);

export function isReservedWidgetSegment(segment: string): boolean {
  return RESERVED.has(segment);
}

export function isWidgetIdSegment(segment: string): boolean {
  return CanonicalIdSchema.safeParse(segment).success;
}

// Widget ids are slash-joined canonical segments (`plans/q3-redesign`). Flat
// canonical ids remain valid (single segment, reserved words included — see
// above). Stricter than doc paths on purpose: segments stay URL-clean, so
// `..`, empty segments, spaces, and percent-encoding artifacts are all
// unrepresentable.
export const WidgetIdSchema = z
  .string()
  .min(1)
  .refine(
    (id) => {
      const segments = id.split("/");
      if (!segments.every(isWidgetIdSegment)) return false;
      return segments.length === 1 || !segments.some(isReservedWidgetSegment);
    },
    {
      message:
        "Widget id must be slash-separated segments of lowercase letters, digits, and hyphens; nested ids may not use reserved segment names (records, state, content, archive, restore, versions, review)",
    }
  );

/**
 * A UTC ISO 8601 timestamp ending in Z, with seconds and fractions optional.
 * Zod 4.4's datetime() accepted exactly this; 4.6 requires seconds, and
 * Worktable reads timestamps people and agents write by hand, so the rule
 * stays here rather than following the library.
 */
const ISO_UTC_TIMESTAMP =
  /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z))$/;

export const IsoTimestampSchema = z
  .string()
  .regex(ISO_UTC_TIMESTAMP, { error: "Invalid ISO datetime" })
  .meta({ format: "date-time" });

export const ArchiveInfoSchemaV1 = z.object({
  archivedAt: IsoTimestampSchema,
  archivedBy: z.string().min(1),
  reason: z.string().optional(),
});

export const CanonicalMetadataSchema = z.record(z.string(), z.unknown());

export const WidgetRuntimeSchema = z.object({
  type: z.literal("html"),
  entry: z.literal("index.html").default("index.html"),
});

export const WidgetRecordPermissionSchema = z.object({
  read: z.boolean().optional(),
  create: z.boolean().optional(),
  update: z.boolean().optional(),
  delete: z.boolean().optional(),
});

export const WidgetPermissionsSchema = z.object({
  network: z.boolean().default(false),
  records: z.record(z.string(), WidgetRecordPermissionSchema).default({}),
  state: z.object({ read: z.boolean().optional(), write: z.boolean().optional() }).default({ read: true, write: true }),
});

export const WidgetFileSchema = z.object({
  version: z.literal(1),
  kind: z.literal("worktable.widget"),
  id: WidgetIdSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  createdBy: z.string().min(1),
  updatedBy: z.string().min(1).optional(),
  archive: ArchiveInfoSchemaV1.nullable().optional(),
  metadata: CanonicalMetadataSchema.default({}),
  runtime: WidgetRuntimeSchema.default({ type: "html", entry: "index.html" }),
  permissions: WidgetPermissionsSchema.default({
    network: false,
    records: {},
    state: { read: true, write: true },
  }),
  /**
   * Set when the HTML Doc's latest writer could read its Space's files: a
   * person, or an agent with documents:read. Only then does its page show
   * the Space images it names, so a page can't show what its writer couldn't
   * read. Kept out of the agent tools' schemas.
   */
  spaceImages: z.literal(true).optional(),
  /**
   * Permissions an agent asked for that wait on a person. Network access an
   * agent requests stays off until someone allows it in Worktable.
   */
  requests: z
    .object({
      network: z.literal(true).optional(),
      /** The name of the agent that asked. */
      by: z.string().min(1).max(200).optional(),
    })
    .optional(),
});

export type WidgetFile = z.infer<typeof WidgetFileSchema>;
