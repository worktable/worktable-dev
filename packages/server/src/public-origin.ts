/**
 * Public origin parsing for install-facing URLs.
 *
 * These values describe the front door for this server process: an operator env
 * override or machine-local Settings value. They are intentionally not workspace
 * metadata, because a copied workspace must not keep pointing agents at the old
 * install.
 */

export interface PublicUrlValidation {
  ok: boolean;
  /**
   * The normalized origin when ok and non-empty; `null` when the caller cleared
   * it (empty/whitespace input). Undefined when invalid.
   */
  value?: string | null;
  /** Human-readable reason when `ok` is false. */
  error?: string;
}

/** Parse a value into a usable http(s) origin, or null. */
export function asHttpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Validate + normalize a candidate `publicUrl`. An origin only: absolute http(s)
 * URL with no path, query, or fragment. Empty/whitespace input is a valid clear
 * (returns `value: null`). Anything else invalid returns `ok: false` with a
 * message. On success `value` is `new URL(v).origin`.
 */
export function normalizePublicUrl(input: string): PublicUrlValidation {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: true, value: null };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: "publicUrl must be a valid absolute URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "publicUrl must use http or https" };
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return {
      ok: false,
      error: "publicUrl must be an origin only (no path, query, or fragment)",
    };
  }
  return { ok: true, value: url.origin };
}
