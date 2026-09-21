import { useEffect } from "react";

const KEYBOARD_THRESHOLD_PX = 80;

function getViewportMetrics() {
  const visualViewport = window.visualViewport;
  const layoutHeight = document.documentElement.clientHeight || window.innerHeight;
  const visualHeight = visualViewport?.height ?? window.innerHeight;
  const visualOffsetTop = visualViewport?.offsetTop ?? 0;
  const visualOffsetLeft = visualViewport?.offsetLeft ?? 0;
  const visualWidth = visualViewport?.width ?? window.innerWidth;
  const rawKeyboardHeight = layoutHeight - visualHeight - visualOffsetTop;
  const keyboardHeight = Math.max(0, Math.round(rawKeyboardHeight));
  const keyboardOpen = keyboardHeight >= KEYBOARD_THRESHOLD_PX;

  return {
    keyboardHeight: keyboardOpen ? keyboardHeight : 0,
    keyboardOpen,
    visualHeight: Math.round(visualHeight),
    visualWidth: Math.round(visualWidth),
    visualOffsetTop: Math.round(visualOffsetTop),
    visualOffsetLeft: Math.round(visualOffsetLeft),
  };
}

function applyViewportVars() {
  const root = document.documentElement;
  const body = document.body;
  const metrics = getViewportMetrics();

  root.style.setProperty("--app-visual-viewport-height", `${metrics.visualHeight}px`);
  root.style.setProperty("--app-visual-viewport-width", `${metrics.visualWidth}px`);
  root.style.setProperty("--app-visual-viewport-offset-top", `${metrics.visualOffsetTop}px`);
  root.style.setProperty("--app-visual-viewport-offset-left", `${metrics.visualOffsetLeft}px`);
  root.style.setProperty("--app-keyboard-height", `${metrics.keyboardHeight}px`);
  root.style.setProperty("--app-mobile-toolbar-bottom", `${metrics.keyboardHeight}px`);
  body.toggleAttribute("data-keyboard-open", metrics.keyboardOpen);
}

/**
 * Keeps Worktable layout tied to the visible viewport on mobile Safari/WebView.
 *
 * iOS exposes a layout viewport and a visual viewport. The keyboard shrinks the
 * visual viewport, while fixed elements and nested scroll containers often keep
 * using the layout viewport. These vars give the app one shared source of truth
 * for keyboard-aware editor chrome.
 */
export function useMobileVisualViewport(enabled = true) {
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;

    let frame = 0;
    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(applyViewportVars);
    };

    schedule();

    const visualViewport = window.visualViewport;
    window.addEventListener("resize", schedule, { passive: true });
    window.addEventListener("orientationchange", schedule, { passive: true });
    visualViewport?.addEventListener("resize", schedule, { passive: true });
    visualViewport?.addEventListener("scroll", schedule, { passive: true });
    visualViewport?.addEventListener("scrollend", schedule, { passive: true });

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      visualViewport?.removeEventListener("resize", schedule);
      visualViewport?.removeEventListener("scroll", schedule);
      visualViewport?.removeEventListener("scrollend", schedule);
      document.body.removeAttribute("data-keyboard-open");
    };
  }, [enabled]);
}
