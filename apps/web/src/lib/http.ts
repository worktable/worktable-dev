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

export const BASE_URL = import.meta.env.VITE_API_URL ?? "";

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
  if (window.location.pathname === "/login") return;
  window.location.assign(`/login?next=${next}`);
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

async function acquireCsrfToken(): Promise<string | null> {
  const response = await fetch(`${BASE_URL}/gateway/session`, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { csrfToken?: unknown };
  csrfToken = typeof body.csrfToken === "string" ? body.csrfToken : null;
  return csrfToken;
}

/** Re-read the CSRF token from the current Cloud browser session. */
export async function getFreshBrowserCsrfToken(): Promise<string | null> {
  return acquireCsrfToken();
}

/** Shared credentialed fetch with one lazy Cloud-CSRF retry. */
export async function authenticatedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> {
  const method = init.method ?? (input instanceof Request ? input.method : "GET");
  const send = (token: string | null) => {
    const headers = new Headers(init.headers);
    if (unsafe(method) && token) headers.set("X-Worktable-CSRF", token);
    return fetch(input, { ...init, method, headers, credentials: "include" });
  };

  let response = await send(csrfToken);
  if (unsafe(method) && (await csrfFailure(response))) {
    const token = await acquireCsrfToken();
    if (token) response = await send(token);
  }
  return response;
}

/**
 * Fetch JSON from the REST API. Sends the session cookie, and on a 401 redirects
 * to /login then throws (so callers/queries don't proceed with empty data).
 */
export async function fetchJSON<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await authenticatedFetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
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
