import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AnnotationCategory, AnnotationTarget } from "@worktable/types";
import { createAnnotation, listAnnotations, replyAnnotation, resolveAnnotation, reopenAnnotation } from "./annotations-api";

export const annotationQueryKeys = {
  doc: (spaceId: string, docPath: string, includeResolved = false) => ["annotations", spaceId, docPath, includeResolved] as const,
  // The "@widget" segment keeps widget keys from colliding with any docPath,
  // while still sitting under the ["annotations", spaceId] prefix that the WS
  // subscription and mutations invalidate.
  widget: (spaceId: string, widgetId: string, includeResolved = false) => ["annotations", spaceId, "@widget", widgetId, includeResolved] as const,
  space: (spaceId: string) => ["annotations", spaceId, "@space"] as const,
};

export interface AttentionSignal {
  /** Exact open count — the server's filtered total, immune to pagination. */
  count: number;
  /** Doc path of the newest matching annotation, for deep-linking to a doc. */
  newestDocPath: string | null;
  /** Widget id of the newest matching annotation, for deep-linking to an HTML doc. */
  newestWidgetId: string | null;
}

/**
 * Space-wide attention counts for Space Home. Counting happens on the server
 * (filtered `total` with limit=1), so the chips stay exact no matter how many
 * open annotations a space accumulates.
 */
export function useSpaceAttention(spaceId: string) {
  return useQuery(
    queryOptions({
      queryKey: annotationQueryKeys.space(spaceId),
      queryFn: async (): Promise<{ instructions: AttentionSignal; lint: AttentionSignal }> => {
        const toSignal = (result: { annotations: { target: unknown }[]; total: number }): AttentionSignal => {
          const target = result.annotations[0]?.target;
          const isObject = target && typeof target === "object";
          return {
            count: result.total,
            newestDocPath:
              isObject && "docPath" in target
                ? (target as { docPath: string }).docPath
                : null,
            newestWidgetId:
              isObject && "widgetId" in target
                ? (target as { widgetId: string }).widgetId
                : null,
          };
        };
        const [instructions, lint] = await Promise.all([
          listAnnotations(spaceId, { category: ["instruction"], limit: 1 }),
          listAnnotations(spaceId, { labels: ["lint"], limit: 1 }),
        ]);
        return { instructions: toSignal(instructions), lint: toSignal(lint) };
      },
    })
  );
}

export function annotationQueryOptions(spaceId: string, docPath: string, includeResolved = false) {
  return queryOptions({
    queryKey: annotationQueryKeys.doc(spaceId, docPath, includeResolved),
    queryFn: () => listAnnotations(spaceId, { docPath, includeResolved }),
  });
}

export function useDocAnnotations(spaceId: string, docPath: string, includeResolved = false) {
  return useQuery(annotationQueryOptions(spaceId, docPath, includeResolved));
}

export function widgetAnnotationQueryOptions(spaceId: string, widgetId: string, includeResolved = false) {
  return queryOptions({
    queryKey: annotationQueryKeys.widget(spaceId, widgetId, includeResolved),
    queryFn: () => listAnnotations(spaceId, { widgetId, includeResolved }),
  });
}

/**
 * HTML doc (widget) annotations. Modeled on {@link useDocAnnotations}: it stays
 * enabled so the floating button's open-count badge stays live even while the
 * panel is closed. `includeResolved` defaults to true because the panel toggles
 * resolved visibility client-side (as the doc route does).
 */
export function useWidgetAnnotations(spaceId: string, widgetId: string, includeResolved = true) {
  return useQuery(widgetAnnotationQueryOptions(spaceId, widgetId, includeResolved));
}

/** Shared mutation set — reply/resolve/reopen are target-agnostic; create takes
 *  a caller-supplied target (block for docs, `{type:"widget"}` for HTML docs). */
function useAnnotationMutationsForKey(spaceId: string, invalidateKey: readonly unknown[]) {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: invalidateKey });

  return {
    create: useMutation({
      mutationFn: (input: { target: AnnotationTarget; category: AnnotationCategory; body: string }) => createAnnotation(spaceId, input),
      onSuccess: invalidate,
    }),
    reply: useMutation({
      mutationFn: (input: { annotationId: string; body: string }) => replyAnnotation(spaceId, input.annotationId, input.body),
      onSuccess: invalidate,
    }),
    resolve: useMutation({
      mutationFn: (input: { annotationId: string; reason?: string }) => resolveAnnotation(spaceId, input.annotationId, input.reason),
      onSuccess: invalidate,
    }),
    reopen: useMutation({
      mutationFn: (annotationId: string) => reopenAnnotation(spaceId, annotationId),
      onSuccess: invalidate,
    }),
  };
}

export function useAnnotationMutations(spaceId: string, docPath: string) {
  return useAnnotationMutationsForKey(spaceId, ["annotations", spaceId, docPath]);
}

export function useWidgetAnnotationMutations(spaceId: string, widgetId: string) {
  // Prefix key (no includeResolved) so both the open and include-resolved
  // widget queries invalidate after a mutation.
  return useAnnotationMutationsForKey(spaceId, ["annotations", spaceId, "@widget", widgetId]);
}
