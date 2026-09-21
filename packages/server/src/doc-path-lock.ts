import { assertWorkspaceAvailable } from "./workspace-safety.ts";

const tails = new Map<string, Promise<void>>();

/** Serialize operations that can change which document owns a path in a space. */
export async function withDocPathLock<T>(
  spaceId: string,
  fn: () => Promise<T>
): Promise<T> {
  const previous = tails.get(spaceId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  tails.set(spaceId, tail);
  await previous;
  try {
    assertWorkspaceAvailable();
    return await fn();
  } finally {
    release();
    if (tails.get(spaceId) === tail) tails.delete(spaceId);
  }
}
