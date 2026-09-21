import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { workspaceQueryOptions } from "./lib/queries";
import { preloadOpeningDocumentRenderer } from "./lib/document-renderers";

export function getRouter() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
  });

  // The prerendered root match can skip beforeLoad during initial hydration.
  // Start browser workspace discovery here so it overlaps document resolution.
  if (typeof window !== "undefined") {
    void queryClient.prefetchQuery(workspaceQueryOptions());
    // Execute already-downloading renderer code while path metadata is in
    // flight. Preserve the saved-content paint before scheduling this work.
    requestAnimationFrame(() => requestAnimationFrame(preloadOpeningDocumentRenderer));
  }

  const router = createRouter({
    routeTree,
    context: {
      queryClient,
    },
    defaultPreload: "intent",
    scrollRestoration: true,
  });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
