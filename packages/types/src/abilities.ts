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
      ? `every collection except ${listNames(except)}`
      : "every collection"
  }
  const allowed = ids
    .filter((id) => records[id]?.[action])
    .map((id) => collectionName(collections, id))
  return allowed.length > 0 ? listNames(allowed) : null
}

// ---- Links ---------------------------------------------------------------

function linkSentences(input: DescribeAbilitiesInput): string[] {
  const granted = Object.entries(input.grant?.collections ?? {})
  const sentences =
    granted.length > 0
      ? granted.flatMap(([id, grant]) => collectionSentences(id, grant, input))
      : ["Anyone with this link can't see any Records."]
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
  const { shown, hidden } = fieldLists(id, grant, input.collections)
  const listed = shown.length > 0 ? `: ${listFields(shown)}` : ""
  const sentences = [
    `${LINK_SUBJECT} see ${countedRecordsName(name, own(input.counts ?? {}, id), grant.rows !== null)}${condition}${listed}.`,
  ]
  if (hidden.length > 0) sentences.push(`Hidden: ${listFields(hidden)}.`)
  return sentences
}

/** A collection's rows as a link shows them: "all 42 Deals", "3 Deals", "1 record in Deals". */
export function countedRecordsName(
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

/** Data fields in schema order, then the record's times, named as record pages name them. */
function fieldLists(
  id: string,
  grant: CollectionGrant,
  collections: Record<string, AbilityCollection>
): { shown: string[]; hidden: string[] } {
  const schema = own(collections, id)?.fields
  const shown: string[] = schema ? [] : [...grant.fields]
  const hidden: string[] = []
  const granted = new Set(grant.fields)
  for (const [key, field] of Object.entries(schema ?? {}))
    (granted.has(key) ? shown : hidden).push(field.name ?? key)
  const times = grant.timestamps ? shown : hidden
  times.push("Created", "Updated")
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
        ? `${LINK_SUBJECT} change ${listNames(fields)} on ${name}.`
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
  const text = conditionWords(collectionId, rows, input)
  if (text !== null) return ` where ${text}`
  const count = countLeaves(rows)
  return ` that match ${count} ${count === 1 ? "condition" : "conditions"}`
}

/** The conditions in words, or null once they can't be said within the length limit. */
function conditionWords(
  collectionId: string,
  rows: RecordPredicate,
  input: DescribeAbilitiesInput
): string | null {
  const leaves = conjunction(rows)
  if (!leaves) return null
  let text = ""
  for (const leaf of leaves) {
    const words = describeLeaf(collectionId, leaf, input)
    if (words === null) return null
    text = text ? `${text} and ${words}` : words
    if (text.length > ABILITY_CONDITION_MAX_LENGTH) return null
  }
  return text
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
  const op: RecordPredicateOp = leaf.op
  if (op === "isEmpty")
    return leaf.value === false ? `${field} is not empty` : `${field} is empty`
  const raw = op === "in" ? leaf.value : [leaf.value]
  // Comparing with null or "" matches only that exact value, which reads
  // the same as `isEmpty` in words, so such leaves are only counted.
  if (!Array.isArray(raw) || raw.length === 0 || raw.some(isBlank)) return null
  // Each value takes at least three characters with its separator, so a
  // longer list can't fit; skip naming thousands of values to find that out.
  if (raw.length > ABILITY_CONDITION_MAX_LENGTH / 3) return null
  const values = raw.map(
    (value) =>
      input.describeValue?.(collectionId, leaf.field, value) ??
      plainValue(value)
  )
  const value = values[0]
  switch (op) {
    case "eq":
      return `${field} is ${value}`
    case "neq":
      return `${field} is not ${value}`
    case "in":
      return `${field} is ${joinWords(values, "or")}`
    case "has":
      return `${field} includes ${value}`
    case "contains":
      return `${field} contains ${value}`
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const type = fieldSpec(input.collections, collectionId, leaf.field)?.type
      const words = RANGE_WORDS[op]
      return `${field} ${type === "date" || type === "datetime" ? words.time : words.value} ${value}`
    }
  }
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || value === ""
}

function plainValue(value: unknown): string {
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

// Lists in sentences stop after LIST_MAX_ITEMS names, then say "and 3 more".
function listNames(items: string[]): string {
  return items.length <= LIST_MAX_ITEMS
    ? joinWords(items, "and")
    : listOverflow(items)
}

/** Fields after a colon: "Name, Stage, Amount". */
function listFields(items: string[]): string {
  return items.length <= LIST_MAX_ITEMS ? items.join(", ") : listOverflow(items)
}

function listOverflow(items: string[]): string {
  return `${items.slice(0, LIST_MAX_ITEMS).join(", ")} and ${items.length - LIST_MAX_ITEMS} more`
}
