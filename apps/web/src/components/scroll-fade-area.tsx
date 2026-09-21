import { useEffect, useRef, useCallback } from "react";
import { ScrollArea } from "@worktable/ui/components/scroll-area";

/**
 * ScrollArea with scroll-aware fade masks at top/bottom edges.
 * Drop-in replacement for ScrollArea.
 * 
 * Applies .scroll-fade class + data-scroll-top/bottom attributes
 * to the internal viewport element for CSS mask-image fading.
 */
export function ScrollFadeArea({
  children,
  fadeSize,
  ...props
}: React.ComponentProps<typeof ScrollArea> & { fadeSize?: number }) {
  const sentinelRef = useRef<HTMLSpanElement>(null);
  const rafRef = useRef(0);
  const threshold = 8;

  const update = useCallback((viewport: HTMLElement) => {
    const { scrollTop, scrollHeight, clientHeight } = viewport;
    const atTop = scrollTop <= threshold;
    const atBottom = scrollTop + clientHeight >= scrollHeight - threshold;

    if (atTop) delete viewport.dataset.scrollTop;
    else viewport.dataset.scrollTop = "true";

    if (atBottom) delete viewport.dataset.scrollBottom;
    else viewport.dataset.scrollBottom = "true";
  }, []);

  useEffect(() => {
    // Walk up from sentinel to find the viewport
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const viewport = sentinel.closest<HTMLElement>(
      '[data-slot="scroll-area-viewport"]'
    );
    if (!viewport) return;

    // Apply scroll-fade class and custom size
    viewport.classList.add("scroll-fade");
    if (fadeSize) {
      viewport.style.setProperty("--sf-size", `${fadeSize}px`);
    }

    // Initial state
    update(viewport);

    const onScroll = () => {
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        update(viewport);
        rafRef.current = 0;
      });
    };

    viewport.addEventListener("scroll", onScroll, { passive: true });

    // Observe viewport + visible content children for size changes.
    // The sentinel is hidden, so skip it and observe actual content.
    const ro = new ResizeObserver(() => update(viewport));
    ro.observe(viewport);
    for (const child of viewport.children) {
      if (child !== sentinel) {
        ro.observe(child);
        break;
      }
    }

    return () => {
      viewport.removeEventListener("scroll", onScroll);
      viewport.classList.remove("scroll-fade");
      if (fadeSize) viewport.style.removeProperty("--sf-size");
      ro.disconnect();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [update, fadeSize]);

  return (
    <ScrollArea {...props}>
      <span ref={sentinelRef} className="hidden" aria-hidden />
      {children}
    </ScrollArea>
  );
}
