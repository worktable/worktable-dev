/**
 * Whether this Worktable runs its file features: every visible file in a
 * Space's folder is part of the Space, with its page, history and links.
 * They are on everywhere, Cloud included. WORKTABLE_FILES=0 turns them off
 * for the process, as a way back if a folder's files cause trouble.
 *
 * Request paths call this: it reads the environment, nothing else.
 */
export function filesEnabled(): boolean {
  const env = process.env["WORKTABLE_FILES"]?.trim().toLowerCase()
  return env !== "0" && env !== "false"
}
