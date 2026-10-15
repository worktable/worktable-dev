import { RUNTIME_BASE_PATH, runtimePath } from "./runtime-path"
import {
  acceptTeamResponse,
  browserTeamMemberId,
  clearTeamBrowserData,
} from "./team-context"
import { noteServerBuild } from "./build-version"
import {
  workspaceContentEpoch,
  workspaceContentChanged,
  isBrowserContentMutation,
  fenceChangedWorkspace,
} from "./workspace-content-epoch";
// Shared REST fetch helper for the web app.
//
// One module so the credentials/401 behavior can't drift across the per-domain
// API clients (api.ts, widgets-api.ts, docs-api.ts, records-api.ts,
// annotations-api.ts). When the server is exposed (owner-password mode), the
// session cookie must ride every request (credentials:"include") and an
// unauthenticated request (401) bounces the browser to the login page.
//
// On loopback / flag-off this is a no-op: there is no cookie to send and the
// server never returns 401, so behavior is byte-for-byte today.

export const BASE_URL = import.meta.env.VITE_API_URL ?? RUNTIME_BASE_PATH;

/**
 * Redirect to the login page, preserving the current location as ?next (so the
 * login flow can return the user where they were). Validated same-origin on the
 * login route before use.
 */
export function redirectToLogin(): void {
  if (typeof window === "undefined") return;
  const next = encodeURIComponent(
    window.location.pathname + window.location.search
  );
  // Avoid a redirect loop if we're already on /login.
  if (window.location.pathname === runtimePath("/login")) return
  void clearTeamBrowserData().finally(() =>
    window.location.assign(RUNTIME_BASE_PATH ? `/login?return_to=${next}` : `${runtimePath("/login")}?next=${next}`)
  )
}

export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}

export class HttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

/** Exact replacement path supplied when a document moved during a request. */
export function canonicalConflictPath(
  error: unknown,
  attemptedPath: string
): string | null {
  if (
    !(error instanceof HttpError) ||
    error.status !== 409 ||
    typeof error.body !== "object" ||
    error.body === null
  ) {
    return null;
  }
  const canonicalPath = (error.body as { canonicalPath?: unknown })
    .canonicalPath;
  return typeof canonicalPath === "string" &&
    canonicalPath.length > 0 &&
    canonicalPath !== attemptedPath
    ? canonicalPath
    : null;
}

let csrfToken: string | null = null;
// One session read at a time: a change waits for the read already running.
let csrfRequest: Promise<string | null> | null = null;
let csrfPrefetched = false;
/** The longest a change waits for a session read that is already running. */
export const CSRF_WAIT_MS = 2_000;

function unsafe(method: string): boolean {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
}

async function csrfFailure(response: Response): Promise<boolean> {
  if (response.status !== 403) return false;
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { code?: string } | null;
  return body?.code === "CSRF_REQUIRED";
}

function acquireCsrfToken(): Promise<string | null> {
  csrfRequest ??= (async () => {
    try {
      const response = await fetch(`${BASE_URL}/gateway/session`, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { csrfToken?: unknown };
      csrfToken = typeof body.csrfToken === "string" ? body.csrfToken : null;
      return csrfToken;
    } finally {
      csrfRequest = null;
    }
  })();
  return csrfRequest;
}

/** Re-read the CSRF token from the current Cloud browser session. */
export async function getFreshBrowserCsrfToken(): Promise<string | null> {
  return acquireCsrfToken();
}

/**
 * Cloud refuses a change without the session's CSRF token. Once the tab knows
 * it runs on Cloud, read the token in the background, so the first change
 * carries it instead of being refused and sent again.
 */
export function prefetchBrowserCsrfToken(): void {
  // Once per page load: a signed-out session has no token to find on focus.
  if (csrfPrefetched || csrfToken !== null || csrfRequest) return;
  csrfPrefetched = true;
  acquireCsrfToken().catch(() => {
    // The refusal-and-retry path still covers a change.
  });
}

/**
 * The token a change should carry now. A session read already running gets
 * `CSRF_WAIT_MS` to answer; after that the change goes without it, and a
 * refusal is retried once the read answers.
 */
async function currentCsrfToken(
  signal: AbortSignal | null | undefined
): Promise<string | null> {
  const request = csrfRequest;
  if (!request) return csrfToken;
  signal?.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      request.catch(() => csrfToken),
      new Promise<string | null>((resolve) => {
        timer = setTimeout(() => resolve(csrfToken), CSRF_WAIT_MS);
      }),
      new Promise<never>((_resolve, reject) => {
        if (!signal) return;
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

/** Shared credentialed fetch with one Cloud-CSRF retry after a refusal. */
export async function authenticatedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> {
  const method = init.method ?? (input instanceof Request ? input.method : "GET");
  const contentMutation = isBrowserContentMutation(method, input);
  if (contentMutation && workspaceContentChanged()) {
    return new Response(JSON.stringify({
      code: "WORKSPACE_CHANGED",
      error: "Workspace changed. Reload before editing.",
    }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    });
  }
  // Capture once: a CSRF retry must not silently rebase an old mutation.
  const epoch = workspaceContentEpoch();
  const send = (token: string | null) => {
    const headers = new Headers(init.headers)
    const member = browserTeamMemberId()
    if (member) headers.set("X-Worktable-Member", member)
    if (contentMutation && epoch)
      headers.set("X-Worktable-Content-Epoch", epoch)
    if (unsafe(method) && token) headers.set("X-Worktable-CSRF", token)
    return fetch(input, { ...init, method, headers, credentials: "include" })
  }

  const token = unsafe(method)
    ? await currentCsrfToken(
        init.signal ?? (input instanceof Request ? input.signal : undefined)
      )
    : csrfToken;
  let response = await send(token);
  noteServerBuild(response);
  if (unsafe(method) && (await csrfFailure(response))) {
    const token = await acquireCsrfToken();
    if (token) response = await send(token);
  }
  if (response.status === 403 || response.status === 409) {
    const body = await response
      .clone()
      .json()
      .catch(() => null)
    if (contentMutation && body?.code === "WORKSPACE_CHANGED") fenceChangedWorkspace()
    if (body?.code === "MEMBERSHIP_REQUIRED") {
      fenceChangedWorkspace()
      void clearTeamBrowserData().finally(() => window.location.replace("/"))
    }
    if (body?.code === "MEMBER_CHANGED") {
      fenceChangedWorkspace()
      void clearTeamBrowserData().finally(() => window.location.replace(runtimePath("/")))
    }
  }
  acceptTeamResponse(response, method, input);
  return response;
}

/** Request options a query function forwards, so abandoned reads stop. */
export interface ReadOptions {
  signal?: AbortSignal;
}

/**
 * Run a view's read with an abort signal that follows the query's own once
 * the read has run for `graceMs`. TanStack Query cancels a read whose last
 * observer unmounts if it has taken the signal, and views unmount and mount
 * again during route changes and Suspense: taking it at once would cancel
 * and repeat those reads. A read abandoned after the grace period, such as a
 * slow document the person navigated away from, still frees its connection.
 * Lists the app shell keeps mounted do not use this.
 */
export async function abandonableRead<T>(
  context: { signal: AbortSignal },
  read: (options: ReadOptions) => Promise<T>,
  graceMs = 1_000
): Promise<T> {
  const controller = new AbortController();
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    const signal = context.signal;
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", () => controller.abort(), { once: true });
  }, graceMs);
  try {
    return await read({ signal: controller.signal });
  } finally {
    settled = true;
    clearTimeout(timer);
  }
}

/**
 * Fetch JSON from the REST API. Sends the session cookie, and on a 401 redirects
 * to /login then throws (so callers/queries don't proceed with empty data).
 * Pass a query's `signal` so a cancelled read aborts its request. Reads send
 * no Content-Type, which they have no body to describe.
 */
export async function fetchJSON<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const read = (method === "GET" || method === "HEAD") && init?.body == null;
  const res = await authenticatedFetch(`${BASE_URL}${path}`, {
    ...init,
    headers: read
      ? init?.headers
      : { "Content-Type": "application/json", ...init?.headers },
  });
  if (res.status === 401) {
    redirectToLogin();
    throw new UnauthorizedError();
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new HttpError(
      res.status,
      body,
      (body as { error?: string }).error ?? `HTTP ${res.status}`
    );
  }
  return res.json() as Promise<T>;
}

/**
 * Like fetchJSON but for endpoints that return no body (DELETE). Still sends
 * credentials and drives the 401 redirect.
 */
export async function fetchVoid(
  path: string,
  init?: RequestInit
): Promise<void> {
  const res = await authenticatedFetch(`${BASE_URL}${path}`, {
    ...init,
  });
  if (res.status === 401) {
    redirectToLogin();
    throw new UnauthorizedError();
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
}
