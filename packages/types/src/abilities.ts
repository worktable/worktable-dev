import type { CollectionGrant, LinkGrant } from "./link-grants"
import type { RecordPredicate, RecordPredicateOp } from "./records"

// Plain sentences about what a tool or a share link can do. The share dialog,
// "Use as a view" and approving a tool's permissions all use this generator,
// so the same grant always reads the same way.

const RECORD_ACTIONS = ["read", "create", "update", "delete"] as const
type RecordAction = (typeof RECORD_ACTIONS)[number]

/** An HTML Doc's record permissions, keyed by collection id or `*`. A specific entry replaces `*`. */
export type WidgetRecordPermissions = Record<
  string,
  Partial<Record<RecordAction, boolean>>
>

export interface AbilityCollection {
  name: string
  fields: Record<string, { name?: string; type: string }>
}

export interface DescribeAbilitiesInput {
  audience: "tool" | "link"
  /** Read for the tool audience. */
  permissions?: { network?: boolean; records?: WidgetRecordPermissions }
  /** Read for the link audience: the effective grant. */
  grant?: LinkGrant
  /** Names and fields of the collections involved, keyed by collection id. */
  collections: Record<string, AbilityCollection>
  /** Rows the link shows, keyed by collection id. */
  counts?: Record<string, number>
  /** Words for a value in a condition, such as a related record's title. */
  describeValue?: (
    collectionId: string,
    field: string,
    value: unknown
  ) => string
}

export interface AbilityDescription {
  sentences: string[]
  text: string
}

/** Longer conditions are summarised as a count. */
export const ABILITY_CONDITION_MAX_LENGTH = 160

const LIST_MAX_ITEMS = 10
const LINK_SUBJECT = "Anyone with this link can"

export function describeAbilities(
  input: DescribeAbilitiesInput
): AbilityDescription {
  const sentences =
    input.audience === "tool" ? toolSentences(input) : linkSentences(input)
  return { sentences, text: sentences.join(" ") }
}

/**
 * Record permissions that allow exactly what both `requested` and `ceiling`
 * allow, under the HTML Doc rule that a collection's own entry replaces `*`.
 */
export function intersectRecordPermissions(
  requested: WidgetRecordPermissions | undefined,
  ceiling: WidgetRecordPermissions | undefined
): WidgetRecordPermissions {
  const req = requested ?? {}
  const cap = ceiling ?? {}
  const wildcard = allowedBoth(req["*"], cap["*"])
  const entries: [string, Partial<Record<RecordAction, boolean>>][] = []
  if (wildcard) entries.push(["*", wildcard])
  const ids = new Set([...Object.keys(req), ...Object.keys(cap)])
  ids.delete("*")
  for (const id of ids) {
    const entry = allowedBoth(ownEntry(req, id), ownEntry(cap, id)) ?? {}
    // An entry equal to `*` is redundant; an empty one still blocks `*`.
    if (
      wildcard ? !sameActions(entry, wildcard) : Object.keys(entry).length > 0
    )
      entries.push([id, entry])
  }
  // fromEntries defines own keys, so an id such as "__proto__" stays data.
  return Object.fromEntries(entries)
}

function ownEntry(
  records: WidgetRecordPermissions,
  id: string
): Partial<Record<RecordAction, boolean>> | undefined {
  return Object.hasOwn(records, id) ? records[id] : records["*"]
}

function allowedBoth(
  a: Partial<Record<RecordAction, boolean>> | undefined,
  b: Partial<Record<RecordAction, boolean>> | undefined
): Partial<Record<RecordAction, boolean>> | null {
  const out: Partial<Record<RecordAction, boolean>> = {}
  for (const action of RECORD_ACTIONS)
    if (a?.[action] === true && b?.[action] === true) out[action] = true
  return Object.keys(out).length > 0 ? out : null
}

function sameActions(
  a: Partial<Record<RecordAction, boolean>>,
  b: Partial<Record<RecordAction, boolean>>
): boolean {
  return RECORD_ACTIONS.every(
    (action) => Boolean(a[action]) === Boolean(b[action])
  )
}

// ---- Tools ---------------------------------------------------------------

const TOOL_VERBS: Record<RecordAction, string> = {
  read: "Reads",
  create: "Adds to",
  update: "Changes",
  delete: "Deletes from",
}

function toolSentences(input: DescribeAbilitiesInput): string[] {
  const records = input.permissions?.records ?? {}
  const sentences: string[] = []
  for (const action of RECORD_ACTIONS) {
    const reach = collectionsAllowing(records, action, input.collections)
    if (reach) sentences.push(`${TOOL_VERBS[action]} ${reach}.`)
  }
  sentences.push(
    input.permissions?.network
      ? "Can send data outside this Worktable."
      : "Can't send anything outside this Worktable."
  )
  return sentences
}

function collectionsAllowing(
  records: WidgetRecordPermissions,
  action: RecordAction,
  collections: Record<string, AbilityCollection>
): string | null {
  const ids = Object.keys(records).filter((id) => id !== "*")
  if (records["*"]?.[action]) {
    const except = ids
      .filter((id) => !records[id]?.[action])
      .map((id) => collectionName(collections, id))
    return except.length > 0
      ? `every collection except ${joinWords(except, "and")}`
      : "every collection"
  }
  const allowed = ids
    .filter((id) => records[id]?.[action])
    .map((id) => collectionName(collections, id))
  return allowed.length > 0 ? joinWords(allowed, "and") : null
}

// ---- Links ---------------------------------------------------------------

function linkSentences(input: DescribeAbilitiesInput): string[] {
  const granted = Object.entries(input.grant?.collections ?? {})
  if (granted.length === 0)
    return ["Anyone with this link can't see any Records."]
  const sentences = granted.flatMap(([id, grant]) =>
    collectionSentences(id, grant, input)
  )
  if (input.grant?.state === "team-read")
    sentences.push(`${LINK_SUBJECT} see what your team saved in this HTML Doc.`)
  return sentences
}

function collectionSentences(
  id: string,
  grant: CollectionGrant,
  input: DescribeAbilitiesInput
): string[] {
  const name = collectionName(input.collections, id)
  return [
    ...readSentences(id, name, grant, input),
    ...writeSentences(id, name, grant, input.collections),
  ]
}

function readSentences(
  id: string,
  name: string,
  grant: CollectionGrant,
  input: DescribeAbilitiesInput
): string[] {
  const condition = describeRows(id, grant.rows, input)
  if (grant.mode === "summaries") {
    const groups = (grant.summaries?.groupBy ?? []).map((field) =>
      fieldName(input.collections, id, field)
    )
    const by = groups.length > 0 ? ` by ${joinWords(groups, "and")}` : ""
    return [
      `${LINK_SUBJECT} see totals of ${name}${by}${condition}, never individual records.`,
    ]
  }
  const { shown, hidden } = fieldLists(id, grant, input.collections)
  const listed = shown.length > 0 ? `: ${listFields(shown)}` : ""
  const reads = grant.fixed?.length ?? 0
  const saved = reads === 1 ? "the read" : `the ${reads} reads`
  const sentences = [
    grant.mode === "fixed"
      ? `${LINK_SUBJECT} see ${name}${condition} only through ${saved} saved with this link${listed}.`
      : `${LINK_SUBJECT} see ${countedName(name, own(input.counts ?? {}, id), grant.rows !== null)}${condition}${listed}.`,
  ]
  if (hidden.length > 0) sentences.push(`Hidden: ${listFields(hidden)}.`)
  return sentences
}

function countedName(
  name: string,
  count: number | undefined,
  filtered: boolean
): string {
  if (count === undefined) return filtered ? name : `all ${name}`
  if (count === 1) return `1 record in ${name}`
  const formatted = count.toLocaleString("en-US")
  return filtered || count === 0
    ? `${formatted} ${name}`
    : `all ${formatted} ${name}`
}

function fieldLists(
  id: string,
  grant: CollectionGrant,
  collections: Record<string, AbilityCollection>
): { shown: string[]; hidden: string[] } {
  const schema = own(collections, id)?.fields
  if (!schema) return { shown: grant.fields, hidden: [] }
  const granted = new Set(grant.fields)
  const shown: string[] = []
  const hidden: string[] = []
  for (const [key, field] of Object.entries(schema))
    (granted.has(key) ? shown : hidden).push(field.name ?? key)
  return { shown, hidden }
}

function writeSentences(
  id: string,
  name: string,
  grant: CollectionGrant,
  collections: Record<string, AbilityCollection>
): string[] {
  const writes = grant.writes
  if (!writes) return []
  const sentences: string[] = []
  if (writes.create) sentences.push(`${LINK_SUBJECT} add to ${name}.`)
  if (writes.update) {
    const fields = writes.fields.map((field) =>
      fieldName(collections, id, field)
    )
    sentences.push(
      fields.length > 0
        ? `${LINK_SUBJECT} change ${joinWords(fields, "and")} on ${name}.`
        : `${LINK_SUBJECT} change ${name}.`
    )
  }
  return sentences
}

// ---- Conditions ----------------------------------------------------------

function describeRows(
  collectionId: string,
  rows: RecordPredicate | null,
  input: DescribeAbilitiesInput
): string {
  if (!rows) return ""
  const words = conjunction(rows)?.map((leaf) =>
    describeLeaf(collectionId, leaf, input)
  )
  if (words?.every((part) => part !== null)) {
    const text = words.join(" and ")
    if (text.length <= ABILITY_CONDITION_MAX_LENGTH) return ` where ${text}`
  }
  const count = countLeaves(rows)
  return ` that match ${count} ${count === 1 ? "condition" : "conditions"}`
}

type Leaf = Extract<RecordPredicate, { field: string }>

/** The leaves of a tree made only of `and`, or null when it has `or` or `not`. */
function conjunction(node: RecordPredicate): Leaf[] | null {
  if ("or" in node || "not" in node) return null
  if (!("and" in node)) return [node]
  const leaves: Leaf[] = []
  for (const child of node.and) {
    const inner = conjunction(child)
    if (!inner) return null
    leaves.push(...inner)
  }
  return leaves
}

function countLeaves(node: RecordPredicate): number {
  if ("and" in node)
    return node.and.reduce((sum, child) => sum + countLeaves(child), 0)
  if ("or" in node)
    return node.or.reduce((sum, child) => sum + countLeaves(child), 0)
  if ("not" in node) return countLeaves(node.not)
  return 1
}

const RANGE_WORDS: Record<
  "gt" | "gte" | "lt" | "lte",
  { value: string; time: string }
> = {
  gt: { value: "is more than", time: "is after" },
  gte: { value: "is at least", time: "is on or after" },
  lt: { value: "is less than", time: "is before" },
  lte: { value: "is at most", time: "is on or before" },
}

/** Null when the leaf has no plain wording. */
function describeLeaf(
  collectionId: string,
  leaf: Leaf,
  input: DescribeAbilitiesInput
): string | null {
  const field = fieldName(input.collections, collectionId, leaf.field)
  const value = (raw: unknown): string =>
    input.describeValue?.(collectionId, leaf.field, raw) ?? plainValue(raw)
  const op: RecordPredicateOp = leaf.op
  switch (op) {
    case "eq":
      return `${field} is ${value(leaf.value)}`
    case "neq":
      return `${field} is not ${value(leaf.value)}`
    case "in":
      return Array.isArray(leaf.value) && leaf.value.length > 0
        ? `${field} is ${joinWords(leaf.value.map(value), "or")}`
        : null
    case "has":
      return `${field} includes ${value(leaf.value)}`
    case "contains":
      return `${field} contains ${value(leaf.value)}`
    case "isEmpty":
      return leaf.value === false
        ? `${field} is not empty`
        : `${field} is empty`
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const type = fieldSpec(input.collections, collectionId, leaf.field)?.type
      const words = RANGE_WORDS[op]
      return `${field} ${type === "date" || type === "datetime" ? words.time : words.value} ${value(leaf.value)}`
    }
  }
}

function plainValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "empty"
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean")
    return String(value)
  return JSON.stringify(value)
}

// ---- Words ---------------------------------------------------------------

// Ids and field keys are data: "constructor" must not find Object's.
function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

function collectionName(
  collections: Record<string, AbilityCollection>,
  id: string
): string {
  return own(collections, id)?.name ?? id
}

function fieldSpec(
  collections: Record<string, AbilityCollection>,
  collectionId: string,
  key: string
): AbilityCollection["fields"][string] | undefined {
  const fields = own(collections, collectionId)?.fields
  return fields ? own(fields, key) : undefined
}

function fieldName(
  collections: Record<string, AbilityCollection>,
  collectionId: string,
  key: string
): string {
  return (
    fieldSpec(collections, collectionId, key)?.name ??
    (key === "id" ? "ID" : key)
  )
}

/** "A", "A and B", "A, B and C". */
function joinWords(items: string[], conjunctionWord: "and" | "or"): string {
  if (items.length <= 1) return items[0] ?? ""
  return `${items.slice(0, -1).join(", ")} ${conjunctionWord} ${items[items.length - 1]}`
}

function listFields(items: string[]): string {
  if (items.length <= LIST_MAX_ITEMS) return items.join(", ")
  return `${items.slice(0, LIST_MAX_ITEMS).join(", ")} and ${items.length - LIST_MAX_ITEMS} more`
}
