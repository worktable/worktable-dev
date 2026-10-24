import type { Annotation, PassVisitorCommentInput, VisitorCommentsResponse } from "@worktable/types"
import { fetchJSON } from "./http"

export { visitorCommentsQueryKey } from "./visitor-comment-events"
const base = (spaceId: string) => `/api/spaces/${encodeURIComponent(spaceId)}/visitor-comments`
/** The latest 100. */
export function getVisitorComments(spaceId: string, documentId: string): Promise<VisitorCommentsResponse> {
  return fetchJSON(`${base(spaceId)}?${new URLSearchParams({documentId})}`)
}
export function replyToVisitor(spaceId: string, id: string, body: string): Promise<{ok: true}> {
  return fetchJSON(`${base(spaceId)}/${encodeURIComponent(id)}/replies`, {method: "POST", body: JSON.stringify({body})})
}
export function finishVisitorComment(spaceId: string, id: string, remove: boolean): Promise<{ok: true}> {
  return fetchJSON(`${base(spaceId)}/${encodeURIComponent(id)}${remove ? "" : "/done"}`, {method: remove ? "DELETE" : "POST"})
}
export function passVisitorToTeam(spaceId: string, id: string, input: PassVisitorCommentInput): Promise<{annotation: Annotation; created: boolean}> {
  return fetchJSON(`${base(spaceId)}/${encodeURIComponent(id)}/pass`, {method: "POST", body: JSON.stringify(input)})
}
