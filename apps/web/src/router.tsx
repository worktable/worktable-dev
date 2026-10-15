import { RUNTIME_BASE_PATH } from "./lib/runtime-path"
import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { startWorkspaceQueries } from "./lib/boot-facts";
import { preloadOpeningDocumentRenderer } from "./lib/document-renderers";
import { claimServerBuildReload, reloadWhenChunksAreGone } from "./lib/build-version";
import { installTrace } from "./lib/trace";

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
  // Start browser workspace discovery here so it overlaps document resolution;
  // a signed-in page already carries it.
  if (typeof window !== "undefined") {
    startWorkspaceQueries(queryClient);
    // Execute already-downloading renderer code while path metadata is in
    // flight. Preserve the saved-content paint before scheduling this work.
    requestAnimationFrame(() => requestAnimationFrame(preloadOpeningDocumentRenderer));
  }

  const router = createRouter({
    routeTree,
    // Start replaces basepath during hydration. Keep the selected Worktable
    // in the router's bidirectional rewrite, which hydration preserves.
    rewrite: RUNTIME_BASE_PATH
      ? {
          input: ({ url }) => {
            if (
              url.pathname === RUNTIME_BASE_PATH ||
              url.pathname.startsWith(`${RUNTIME_BASE_PATH}/`)
            ) {
              url.pathname = url.pathname.slice(RUNTIME_BASE_PATH.length) || "/";
            }
            return url;
          },
          output: ({ url }) => {
            if (
              url.pathname !== RUNTIME_BASE_PATH &&
              !url.pathname.startsWith(`${RUNTIME_BASE_PATH}/`)
            ) {
              url.pathname = `${RUNTIME_BASE_PATH}${url.pathname}`;
            }
            return url;
          },
        }
      : undefined,
    context: {
      queryClient,
    },
    defaultPreload: "intent",
    scrollRestoration: true,
  });
  installTrace(
    queryClient,
    () => router.state.matches.at(-1)?.routeId ?? "unknown"
  );

  if (typeof window !== "undefined") {
    reloadWhenChunksAreGone();
    // After an update, the next navigation loads the new build in full.
    router.subscribe("onBeforeNavigate", ({ toLocation }) => {
      if (claimServerBuildReload()) window.location.assign(toLocation.href);
    });
  }

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
