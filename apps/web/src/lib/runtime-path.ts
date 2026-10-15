/** Each Cloud tab addresses one Worktable explicitly; solo/local paths stay unchanged. */
export const RUNTIME_BASE_PATH = typeof window === "undefined" ? "" : window.location.pathname.match(/^\/t\/[A-Za-z0-9_-]+(?=\/|$)/)?.[0] ?? ""
export const runtimePath = (path: string) => `${RUNTIME_BASE_PATH}${path}`
