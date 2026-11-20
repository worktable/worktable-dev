import type { QueryClient } from "@tanstack/react-query"
import type { Annotation } from "@worktable/types"
import {
  ANNOTATION_SENT_TO_KEY,
  annotationSentTo,
  type SentCommentRef,
} from "@worktable/types/constants"

/**
 * A thread's delivery moved on: comments sent in it show the new state at
 * once, without reading their list again.
 */
export function applySentCommentActivity(
  queryClient: QueryClient,
  threadId: string,
  activity: { messageId: string; state: NonNullable<SentCommentRef["state"]> }
): void {
  for (const query of queryClient.getQueryCache().findAll({ queryKey: ["annotations"] })) {
    const data = query.state.data as { annotations?: Annotation[] } | undefined;
    if (!data?.annotations?.some((annotation) => {
      const sent = annotationSentTo(annotation);
      return sent?.threadId === threadId && sent.messageId === activity.messageId;
    })) continue;
    queryClient.setQueryData(query.queryKey, {
      ...data,
      annotations: data.annotations.map((annotation) => {
        const sent = annotationSentTo(annotation);
        return sent?.threadId === threadId && sent.messageId === activity.messageId
          ? { ...annotation, metadata: { ...annotation.metadata, [ANNOTATION_SENT_TO_KEY]: { ...sent, state: activity.state } } }
          : annotation;
      }),
    });
  }
}
