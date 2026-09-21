/**
 * Mermaid "Tap to Interact" Touch Handler
 *
 * Solves mobile problems:
 * 1. Scroll trap: plugin sets touch-action:none, preventing page scroll
 * 2. Keyboard popup: tapping mermaid blocks focuses ProseMirror contenteditable
 *
 * Technique:
 * - preventDefault() on touchend for ALL taps inside mermaid blocks
 * - Manually dispatch .click() on buttons so React handlers still fire
 * - Blur ProseMirror on touchstart if it already has focus (handles the case
 *   where user was editing text, then taps a mermaid block)
 * - Let CodeMirror editor (.cm-editor) receive normal touch behavior for editing
 *
 * Only active on touch devices (pointer: coarse).
 */

const ACTIVE_CLASS = 'mermaid-touch-active';
const OVERLAY_CLASS = 'mermaid-touch-overlay';
const HINT_TIMEOUT = 2000;
const TAP_MAX_DISTANCE = 15;
const TAP_MAX_DURATION = 300;

interface ManagedDiagram {
  container: HTMLElement;
  diagramArea: HTMLElement;
  overlay: HTMLElement;
  hintTimer: ReturnType<typeof setTimeout> | null;
  active: boolean;
  hintVisible: boolean;
}

const managed = new WeakMap<HTMLElement, ManagedDiagram>();

function isTouchDevice(): boolean {
  return window.matchMedia('(pointer: coarse)').matches;
}

/**
 * Find the nearest clickable element (button, link) from a touch target,
 * stopping at the mermaid block boundary.
 */
function findClickableAncestor(el: HTMLElement, boundary: Element): HTMLElement | null {
  let current: HTMLElement | null = el;
  while (current && current !== boundary) {
    const tag = current.tagName?.toLowerCase();
    if (tag === 'button' || tag === 'a') return current;
    if (current.getAttribute('role') === 'button') return current;
    if (current.getAttribute('data-content-type') === 'mermaid') break;
    current = current.parentElement;
  }
  return null;
}

/**
 * Check if the touch target is inside a collapsed mermaid card.
 */
function isInsideCollapsedCard(el: HTMLElement): boolean {
  const mermaidBlock = el.closest('[data-content-type="mermaid"]');
  if (!mermaidBlock) return false;
  return !mermaidBlock.querySelector('.mermaid-interactive-container');
}

/**
 * Check if the touch target is inside the CodeMirror code editor.
 * The code editor needs normal touch behavior to work (focus, cursor, keyboard).
 */
function isInsideCodeEditor(el: HTMLElement): boolean {
  return !!el.closest('.cm-editor');
}

function createOverlay(container: HTMLElement, diagramArea: HTMLElement): HTMLElement {
  const overlay = document.createElement('div');
  overlay.className = OVERLAY_CLASS;
  overlay.style.cssText = `
    position: absolute;
    inset: 0;
    z-index: 6;
    display: flex;
    align-items: center;
    justify-content: center;
    -webkit-tap-highlight-color: transparent;
    touch-action: auto;
  `;

  const hint = document.createElement('div');
  hint.className = 'mermaid-touch-hint';
  hint.textContent = 'Tap to interact';
  hint.style.cssText = `
    opacity: 0;
    transition: opacity 0.2s ease;
    pointer-events: none;
    padding: 8px 16px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 500;
    user-select: none;
  `;
  overlay.appendChild(hint);

  const interactiveContainer = diagramArea.closest('.mermaid-interactive-container') as HTMLElement | null;
  if (interactiveContainer) {
    interactiveContainer.style.position = 'relative';
    interactiveContainer.appendChild(overlay);
  } else {
    container.style.position = 'relative';
    container.appendChild(overlay);
  }

  return overlay;
}

function showHint(state: ManagedDiagram) {
  state.hintVisible = true;
  const hint = state.overlay.querySelector('.mermaid-touch-hint') as HTMLElement;
  if (hint) {
    hint.style.opacity = '1';
    if (state.hintTimer) clearTimeout(state.hintTimer);
    state.hintTimer = setTimeout(() => {
      hint.style.opacity = '0';
      state.hintVisible = false;
      state.hintTimer = null;
    }, HINT_TIMEOUT);
  }
}

function hideHint(state: ManagedDiagram) {
  state.hintVisible = false;
  const hint = state.overlay.querySelector('.mermaid-touch-hint') as HTMLElement;
  if (hint) hint.style.opacity = '0';
  if (state.hintTimer) {
    clearTimeout(state.hintTimer);
    state.hintTimer = null;
  }
}

function activate(state: ManagedDiagram) {
  state.active = true;
  state.hintVisible = false;
  state.overlay.style.display = 'none';
  state.container.classList.add(ACTIVE_CLASS);
}

function deactivate(state: ManagedDiagram) {
  if (!state.active) return;
  state.active = false;
  state.overlay.style.display = 'flex';
  state.container.classList.remove(ACTIVE_CLASS);
  hideHint(state);
}

function setupDiagram(container: HTMLElement) {
  if (!isTouchDevice()) return;

  const diagramArea = container.querySelector('.mermaid-diagram-area') as HTMLElement;
  if (!diagramArea || managed.has(container)) return;

  const overlay = createOverlay(container, diagramArea);

  const state: ManagedDiagram = {
    container,
    diagramArea,
    overlay,
    hintTimer: null,
    active: false,
    hintVisible: false,
  };

  managed.set(container, state);

  let touchStartX = 0;
  let touchStartY = 0;
  let touchStartTime = 0;

  overlay.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchStartTime = Date.now();
  }, { passive: true });

  overlay.addEventListener('touchend', (e) => {
    const touch = e.changedTouches[0];
    if (!touch) return;

    const dx = Math.abs(touch.clientX - touchStartX);
    const dy = Math.abs(touch.clientY - touchStartY);
    const duration = Date.now() - touchStartTime;
    const isTap = dx < TAP_MAX_DISTANCE && dy < TAP_MAX_DISTANCE && duration < TAP_MAX_DURATION;

    if (!isTap) return;

    e.preventDefault();
    e.stopPropagation();

    if (!state.hintVisible) {
      showHint(state);
    } else {
      hideHint(state);
      activate(state);
    }
  }, { passive: false });

  overlay.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
  });
}

function deactivateAll() {
  document.querySelectorAll(`.${ACTIVE_CLASS}`).forEach((el) => {
    const state = managed.get(el as HTMLElement);
    if (state) deactivate(state);
  });
}

let globalListenersAttached = false;
let globalTouchStartX = 0;
let globalTouchStartY = 0;
let globalTouchStartTime = 0;
let syntheticClickTarget: HTMLElement | null = null;

function attachGlobalListeners() {
  if (globalListenersAttached) return;
  globalListenersAttached = true;
  if (!isTouchDevice()) return;

  document.addEventListener('touchstart', (e) => {
    const target = e.target as HTMLElement;

    if (e.touches.length === 1) {
      globalTouchStartX = e.touches[0].clientX;
      globalTouchStartY = e.touches[0].clientY;
      globalTouchStartTime = Date.now();
    }

    // If the touch lands on a mermaid block (but NOT its code editor),
    // immediately blur ProseMirror.
    const mermaidBlock = target.closest('[data-content-type="mermaid"]');
    if (mermaidBlock && !isInsideCodeEditor(target)) {
      const pm = document.querySelector('.ProseMirror[contenteditable]') as HTMLElement | null;
      if (pm && pm.contains(document.activeElement)) {
        pm.blur();
        (document.activeElement as HTMLElement)?.blur?.();
      }
    }

    // Deactivate diagrams when tapping outside
    if (!target.closest(`.${ACTIVE_CLASS}`)) {
      deactivateAll();
    }
  }, { passive: true, capture: true });

  // Block focus on taps inside mermaid blocks, then dispatch synthetic clicks
  document.addEventListener('touchend', (e) => {
    const target = e.target as HTMLElement;
    const mermaidBlock = target.closest('[data-content-type="mermaid"]');
    if (!mermaidBlock) return;

    if (target.closest(`.${OVERLAY_CLASS}`)) return;
    if (isInsideCodeEditor(target)) return;

    const touch = e.changedTouches[0];
    if (!touch) return;
    const dx = Math.abs(touch.clientX - globalTouchStartX);
    const dy = Math.abs(touch.clientY - globalTouchStartY);
    const duration = Date.now() - globalTouchStartTime;
    const isTap = dx < TAP_MAX_DISTANCE && dy < TAP_MAX_DISTANCE && duration < TAP_MAX_DURATION;

    if (!isTap) return;

    e.preventDefault();

    const clickTarget = findClickableAncestor(target, mermaidBlock);
    if (clickTarget) {
      syntheticClickTarget = clickTarget;
      clickTarget.click();
      syntheticClickTarget = null;
      return;
    }

    if (isInsideCollapsedCard(target)) {
      const wrapper = mermaidBlock.children[0] as HTMLElement | null;
      if (wrapper) {
        syntheticClickTarget = wrapper;
        wrapper.click();
        syntheticClickTarget = null;
      }
    }
  }, { passive: false, capture: true });

  // Block browser's auto-generated click (would re-focus editor)
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const mermaidBlock = target.closest('[data-content-type="mermaid"]');
    if (!mermaidBlock) return;

    if (target === syntheticClickTarget) return;
    if (target.closest(`.${OVERLAY_CLASS}`)) return;
    if (isInsideCodeEditor(target)) return;

    const active = document.activeElement as HTMLElement | null;
    if (active?.closest?.('.ProseMirror')) {
      active.blur();
    }
  }, { capture: true });

  // Deactivate on scroll
  const onScroll = () => deactivateAll();
  window.addEventListener('scroll', onScroll, { passive: true });
  setTimeout(() => {
    document.querySelectorAll('.overflow-auto').forEach((el) => {
      el.addEventListener('scroll', onScroll, { passive: true });
    });
  }, 500);
}

export function initMermaidTouchHandler(editorRoot: HTMLElement): () => void {
  if (!isTouchDevice()) {
    return () => {};
  }

  attachGlobalListeners();

  editorRoot.querySelectorAll('[data-content-type="mermaid"]').forEach((el) => {
    setupDiagram(el as HTMLElement);
  });

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches?.('[data-content-type="mermaid"]')) {
          setupDiagram(node);
        }
        node.querySelectorAll?.('[data-content-type="mermaid"]').forEach((el) => {
          setupDiagram(el as HTMLElement);
        });
      }

      if (mutation.target instanceof HTMLElement) {
        const mermaidBlock = mutation.target.closest('[data-content-type="mermaid"]');
        if (mermaidBlock && !managed.has(mermaidBlock as HTMLElement)) {
          const diagramArea = mermaidBlock.querySelector('.mermaid-diagram-area');
          if (diagramArea) {
            setupDiagram(mermaidBlock as HTMLElement);
          }
        }
      }
    }
  });

  observer.observe(editorRoot, {
    childList: true,
    subtree: true,
  });

  return () => {
    observer.disconnect();
    editorRoot.querySelectorAll('[data-content-type="mermaid"]').forEach((el) => {
      const state = managed.get(el as HTMLElement);
      if (state) {
        if (state.hintTimer) clearTimeout(state.hintTimer);
        state.overlay.remove();
        managed.delete(el as HTMLElement);
      }
    });
  };
}
