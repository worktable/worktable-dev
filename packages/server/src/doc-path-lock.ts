import { timing } from "./request-timing.ts";
import { assertWorkspaceAvailable } from "./workspace-safety.ts";

const tails = new Map<string, Promise<void>>();

function whenAborted(signal: AbortSignal): {
  promise: Promise<never>;
  dispose: () => void;
} {
  let onAbort = () => {};
  const promise = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  // The rejection is observed by the race below, or never settles.
  promise.catch(() => undefined);
  return {
    promise,
    dispose: () => signal.removeEventListener("abort", onAbort),
  };
}

/**
 * Serialize operations that can change which document owns a path in a space.
 * A caller that aborts while waiting gives up its place without running, so an
 * abandoned read never holds the Space after the operations queued before it.
 */
export async function withDocPathLock<T>(
  spaceId: string,
  fn: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  signal?.throwIfAborted();
  const previous = tails.get(spaceId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  tails.set(spaceId, tail);
  const forget = () => {
    if (tails.get(spaceId) === tail) tails.delete(spaceId);
  };
  let acquired = false;
  const waitStartedAt = performance.now();
  try {
    if (signal) {
      const aborted = whenAborted(signal);
      try {
        await Promise.race([previous, aborted.promise]);
      } finally {
        aborted.dispose();
      }
    } else {
      await previous;
    }
    timing.end("lock-wait", waitStartedAt);
    acquired = true;
    assertWorkspaceAvailable();
    return await fn();
  } finally {
    release();
    // A caller that gave up may still be the newest in line while an earlier
    // holder runs. Its place then stands for that holder until it finishes,
    // so a later caller still waits for it.
    if (acquired) forget();
    else void tail.then(forget);
  }
}
