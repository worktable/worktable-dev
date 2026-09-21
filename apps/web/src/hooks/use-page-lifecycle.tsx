/**
 * Page Lifecycle State Persistence
 *
 * Saves critical app state (route, timestamp) on page hide/freeze
 * and restores it on page load if the page was discarded by the browser.
 *
 * This makes mobile page-discard/reload seamless: the user returns
 * to the same page they were on, with a brief "Reconnecting..." state
 * instead of the full loading screen.
 */

import { useEffect, useState } from "react";
import type { AnyRouter } from "@tanstack/react-router";

const LIFECYCLE_KEY = "worktable-page-lifecycle";

interface LifecycleState {
  route: string;
  timestamp: number;
}

/**
 * Save the current route to sessionStorage on page hide/freeze.
 * Should be called once in the root layout.
 */
export function usePageLifecyclePersistence(router: AnyRouter) {
  useEffect(() => {
    const saveState = () => {
      try {
        const state: LifecycleState = {
          route: router.state.location.pathname,
          timestamp: Date.now(),
        };
        sessionStorage.setItem(LIFECYCLE_KEY, JSON.stringify(state));
      } catch {
        // sessionStorage may be full or unavailable
      }
    };

    // Save on visibility change (covers most mobile scenarios)
    const handleVisibility = () => {
      if (document.hidden) {
        saveState();
      }
    };

    // Save on freeze (Page Lifecycle API for aggressive discards)
    const handleFreeze = () => {
      saveState();
    };

    document.addEventListener("visibilitychange", handleVisibility);
    document.addEventListener("freeze", handleFreeze);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      document.removeEventListener("freeze", handleFreeze);
    };
  }, [router]);
}

/**
 * On page load, check if the page was discarded and restore the route.
 * Returns { wasDiscarded, restoredRoute } so the UI can show appropriate state.
 */
export function useDiscardRecovery(): {
  wasDiscarded: boolean;
  reconnecting: boolean;
} {
  const [reconnecting, setReconnecting] = useState(false);

  // Check once on mount
  const [wasDiscarded] = useState(() => {
    // SSR guard — document doesn't exist on the server
    if (typeof document === "undefined") return false;
    // document.wasDiscarded is true if the browser discarded the page
    const discarded = (document as unknown as { wasDiscarded?: boolean }).wasDiscarded === true;

    if (discarded) {
      try {
        const raw = sessionStorage.getItem(LIFECYCLE_KEY);
        if (raw) {
          const state: LifecycleState = JSON.parse(raw);
          const age = Date.now() - state.timestamp;
          // Only restore if saved within last 30 minutes
          if (age < 30 * 60 * 1000 && state.route !== window.location.pathname) {
            // Navigate to the saved route
            window.history.replaceState(null, "", state.route);
          }
        }
      } catch {
        // Ignore parse errors
      }
    }

    return discarded;
  });

  useEffect(() => {
    if (wasDiscarded) {
      setReconnecting(true);
      // Auto-clear reconnecting state after connections are likely restored
      const timer = setTimeout(() => setReconnecting(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [wasDiscarded]);

  return { wasDiscarded, reconnecting };
}

/**
 * Reconnecting overlay component for use in root layout.
 * Shows a subtle overlay when the page was discarded and is recovering.
 */
export function ReconnectingOverlay({ show }: { show: boolean }) {
  if (!show) return null;

  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        <p className="text-sm font-medium text-muted-foreground">
          Reconnecting...
        </p>
      </div>
    </div>
  );
}
