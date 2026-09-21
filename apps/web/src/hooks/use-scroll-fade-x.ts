import { useCallback, useEffect, useRef } from "react";

/**
 * Hook for horizontal scroll-aware fade masks.
 * 
 * Sets data attributes:
 * - data-scroll-left: "true" when scrolled away from left
 * - data-scroll-right: "true" when not at right edge
 * 
 * Use with the .scroll-fade-x CSS class.
 * Returns a callback ref.
 */
export function useScrollFadeX<T extends HTMLElement = HTMLElement>(
  threshold = 8
) {
  const rafRef = useRef(0);
  const cleanupRef = useRef<() => void>(() => {});

  const ref = useCallback((node: T | null) => {
    cleanupRef.current();
    cleanupRef.current = () => {};
    if (!node) return;

    const update = () => {
      const { scrollLeft, scrollWidth, clientWidth } = node;
      const atLeft = scrollLeft <= threshold;
      const atRight = scrollLeft + clientWidth >= scrollWidth - threshold;

      if (atLeft) delete node.dataset.scrollLeft;
      else node.dataset.scrollLeft = "true";

      if (atRight) delete node.dataset.scrollRight;
      else node.dataset.scrollRight = "true";
    };

    const onScroll = () => {
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        update();
        rafRef.current = 0;
      });
    };

    update();

    node.addEventListener("scroll", onScroll, { passive: true });

    const ro = new ResizeObserver(() => update());
    ro.observe(node);
    if (node.firstElementChild) {
      ro.observe(node.firstElementChild);
    }

    cleanupRef.current = () => {
      node.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    };
  }, [threshold]);

  useEffect(() => () => cleanupRef.current(), []);

  return ref;
}
