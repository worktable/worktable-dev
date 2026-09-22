import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { CanonicalIdSchema, documentReferenceHref } from "@worktable/types"
import { z } from "zod"
import { blocksToMarkdownSafe } from "../markdown.ts"
import { readDocumentWithView } from "../document-query.ts"
import { analyzeDocumentPath } from "../document-path.ts"
import { readRecord, readRecordCollectionSchema } from "../record-store.ts"
import {
  extractBlockNoteText,
  extractMarkdownTitle,
  extractTitle,
  recordTitle,
  search as searchWorkspace,
} from "../search-index.ts"
import {
  getDocArchiveInfo,
  getSpaceArchiveInfo,
  readDoc,
  readSpace,
  sanitizeDocPath,
} from "../store.ts"
import { hasScope } from "../token-store.ts"
import { docUrlToSendInChat, recordUrlToSendInChat, mcpContentUrl } from "./chat-links.ts"
import { mkAuthErr, mkErr, ok } from "./helpers.ts"
import { oauthToolMetadata } from "./openai-tool-auth.ts"

const SearchInput = z
  .object({
    query: z
      .string()
      .min(1)
      .describe("Natural-language or keyword query to search in Worktable."),
  })
  .strict()

const SearchResult = z
  .object({
    id: z.string(),
    title: z.string(),
    url: z.string().url(),
  })
  .strict()

const SearchOutput = z
  .object({
    results: z.array(SearchResult),
  })
  .strict()

const FetchInput = z
  .object({
    id: z.string().min(1).describe("Opaque result ID returned by search."),
  })
  .strict()

const FetchOutput = z
  .object({
    id: z.string(),
    title: z.string(),
    text: z.string(),
    url: z.string().url(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

const DocFetchTarget = z
  .object({
    kind: z.literal("doc"),
    spaceId: CanonicalIdSchema,
    docPath: z
      .string()
      .min(1)
      .refine(
        (path) =>
          sanitizeDocPath(path) === path &&
          !path.includes("\\") &&
          !path.includes("\0"),
        "Invalid document path"
      ),
  })
  .strict()

const CommonDocumentFetchTarget = z
  .object({
    kind: z.literal("document"),
    spaceId: CanonicalIdSchema,
    path: z
      .string()
      .min(1)
      .refine(
        (path) => analyzeDocumentPath(path).safe,
        "Invalid document path"
      ),
  })
  .strict()

const RecordFetchTarget = z
  .object({
    kind: z.literal("record"),
    spaceId: CanonicalIdSchema,
    collectionId: CanonicalIdSchema,
    recordId: CanonicalIdSchema,
  })
  .strict()

const FetchTarget = z.discriminatedUnion("kind", [
  DocFetchTarget,
  CommonDocumentFetchTarget,
  RecordFetchTarget,
])

export type CompanyKnowledgeFetchTarget = z.infer<typeof FetchTarget>

const FETCH_ID_PREFIX = "wt1."

export function encodeCompanyKnowledgeId(
  target: CompanyKnowledgeFetchTarget
): string {
  const parsed = FetchTarget.parse(target)
  return `${FETCH_ID_PREFIX}${Buffer.from(JSON.stringify(parsed)).toString("base64url")}`
}

function encodeFetchableCompanyKnowledgeId(target: unknown): string | null {
  const parsed = FetchTarget.safeParse(target)
  return parsed.success ? encodeCompanyKnowledgeId(parsed.data) : null
}

export function decodeCompanyKnowledgeId(
  id: string
): CompanyKnowledgeFetchTarget {
  if (!id.startsWith(FETCH_ID_PREFIX)) {
    throw new Error("Unknown Worktable result ID")
  }
  const encoded = id.slice(FETCH_ID_PREFIX.length)
  if (
    !encoded ||
    Buffer.from(encoded, "base64url").toString("base64url") !== encoded
  ) {
    throw new Error("Malformed Worktable result ID")
  }
  try {
    return FetchTarget.parse(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))
    )
  } catch {
    throw new Error("Malformed Worktable result ID")
  }
}

function requireScope(
  scopes: string[],
  scope: string,
  urlOrigin: string,
  message: string
) {
  return hasScope(scopes, scope) ? null : mkAuthErr(message, urlOrigin, scope)
}

async function ensureVisibleSpace(spaceId: string): Promise<string | null> {
  const { data: space, error } = await readSpace(spaceId)
  if (error || !space) return error ?? `Space not found: ${spaceId}`
  if (getSpaceArchiveInfo(space)) return `Space is archived: ${spaceId}`
  return null
}

function spaceUrlToSendInChat(origin: string, spaceId: string): string {
  return mcpContentUrl(origin, `/spaces/${encodeURIComponent(spaceId)}`)
}

function commonDocumentUrl(
  origin: string,
  spaceId: string,
  path: string
): string {
  return mcpContentUrl(origin, documentReferenceHref(spaceId, path))
}

export function registerCompanyKnowledgeTools(
  server: McpServer,
  options: { scopes: string[]; urlOrigin: string }
): void {
  server.registerTool(
    "search",
    {
      title: "Search Worktable",
      description:
        "Search Worktable documents and records for matching knowledge.",
      inputSchema: SearchInput,
      outputSchema: SearchOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      ...oauthToolMetadata(),
    },
    async ({ query }) => {
      const denied = requireScope(
        options.scopes,
        "search:read",
        options.urlOrigin,
        "Searching Worktable requires the search:read scope."
      )
      if (denied) return denied
      try {
        const commonDocuments = hasScope(options.scopes, "documents:read")
        const hits = await searchWorkspace(query, {
          maxResults: 50,
          includeArchived: false,
          documentAccess: commonDocuments ? "common" : "legacy",
        })
        return ok({
          results: hits.flatMap((hit) => {
            if (hit.type === "doc" && hit.path) {
              if (hit.documentKind) {
                const id = encodeFetchableCompanyKnowledgeId({
                  kind: "document",
                  spaceId: hit.spaceId,
                  path: hit.path,
                })
                if (!id) return []
                return [
                  {
                    id,
                    title: hit.title,
                    url: commonDocumentUrl(
                      options.urlOrigin,
                      hit.spaceId,
                      hit.path
                    ),
                  },
                ]
              }
              const id = encodeFetchableCompanyKnowledgeId({
                kind: "doc",
                spaceId: hit.spaceId,
                docPath: hit.path,
              })
              if (!id) return []
              return [
                {
                  id,
                  title: hit.title,
                  url: docUrlToSendInChat(
                    options.urlOrigin,
                    hit.spaceId,
                    hit.path
                  ),
                },
              ]
            }
            if (hit.type === "record" && hit.collectionId && hit.recordId) {
              const id = encodeFetchableCompanyKnowledgeId({
                kind: "record",
                spaceId: hit.spaceId,
                collectionId: hit.collectionId,
                recordId: hit.recordId,
              })
              if (!id) return []
              return [
                {
                  id,
                  title: hit.title,
                  url: recordUrlToSendInChat(
                    options.urlOrigin,
                    hit.spaceId,
                    hit.collectionId,
                    hit.recordId
                  ),
                },
              ]
            }
            return []
          }),
        })
      } catch (error) {
        return mkErr(error instanceof Error ? error.message : String(error))
      }
    }
  )

  server.registerTool(
    "fetch",
    {
      title: "Fetch Worktable item",
      description:
        "Fetch the full text and URL of one Worktable document or record by opaque result ID.",
      inputSchema: FetchInput,
      outputSchema: FetchOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      ...oauthToolMetadata(),
    },
    async ({ id }) => {
      try {
        const target = decodeCompanyKnowledgeId(id)
        const requiredScope =
          target.kind === "document"
            ? "documents:read"
            : target.kind === "doc"
              ? "docs:read"
              : "records:read"
        const denied = requireScope(
          options.scopes,
          requiredScope,
          options.urlOrigin,
          `Fetching this Worktable ${target.kind} requires the ${requiredScope} scope.`
        )
        if (denied) return denied

        const spaceError = await ensureVisibleSpace(target.spaceId)
        if (spaceError) return mkErr(spaceError)

        if (target.kind === "doc") {
          if (await getDocArchiveInfo(target.spaceId, target.docPath)) {
            return mkErr(`Doc is archived: ${target.docPath}`)
          }
          const result = await readDoc(target.spaceId, target.docPath)
          if (result.error || result.data === null) {
            return mkErr(result.error ?? `Doc not found: ${target.docPath}`)
          }
          const title =
            typeof result.data === "string"
              ? extractMarkdownTitle(result.data, target.docPath)
              : extractTitle(result.data, target.docPath)
          const text =
            typeof result.data === "string"
              ? result.data
              : ((await blocksToMarkdownSafe(result.data)) ??
                extractBlockNoteText(result.data))
          return ok({
            id,
            title,
            text,
            url: docUrlToSendInChat(
              options.urlOrigin,
              target.spaceId,
              target.docPath
            ),
          })
        }

        if (target.kind === "document") {
          const commonRead = await readDocumentWithView({
            spaceId: target.spaceId,
            path: target.path,
          })
          const { result } = commonRead
          if (result.kind === "conflict") {
            return ok({
              id,
              title: extractTitle([], result.conflict.pathKey),
              text: `Path: ${result.conflict.pathKey}\nStatus: ambiguous`,
              url: spaceUrlToSendInChat(options.urlOrigin, target.spaceId),
              metadata: {
                documentKind: "conflict",
                health: result.conflict.health,
              },
            })
          }

          const { document, projection } = result
          const projectedTitle =
            projection.kind !== "text"
              ? undefined
              : document.format.id === "worktable.markdown"
                ? extractMarkdownTitle(projection.text, document.path)
                : document.format.id !== "worktable.html"
                  ? projection.headings[0]?.trim()
                  : undefined
          const title = projectedTitle || document.title
          const text =
            projection.kind === "text"
              ? projection.text
              : [
                  `Path: ${document.path}`,
                  `Format: ${document.format.id}`,
                  `Status: ${document.health}`,
                  `Text projection: ${projection.reason}`,
                ].join("\n")
          return ok({
            id,
            title,
            text,
            url: commonDocumentUrl(
              options.urlOrigin,
              target.spaceId,
              document.path
            ),
            metadata: {
              documentKind: "document",
              format: document.format,
              health: document.health,
              ...(projection.kind === "metadata-only"
                ? { projectionReason: projection.reason }
                : {}),
            },
          })
        }

        const result = await readRecord(
          target.spaceId,
          target.collectionId,
          target.recordId
        )
        if (result.error || !result.data) {
          return mkErr(result.error ?? `Record not found: ${target.recordId}`)
        }
        if (result.data.archive) {
          return mkErr(`Record is archived: ${target.recordId}`)
        }
        const collection = await readRecordCollectionSchema(
          target.spaceId,
          target.collectionId
        )
        const collectionName = collection.data?.name ?? target.collectionId
        return ok({
          id,
          title: recordTitle(result.data, collectionName),
          text: JSON.stringify(result.data.data, null, 2),
          url: recordUrlToSendInChat(
            options.urlOrigin,
            target.spaceId,
            target.collectionId,
            target.recordId
          ),
        })
      } catch (error) {
        return mkErr(error instanceof Error ? error.message : String(error))
      }
    }
  )
}
