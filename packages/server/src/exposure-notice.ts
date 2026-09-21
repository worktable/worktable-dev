// ============================================================
// Network-exposure notice (single source of truth)
// ============================================================
//
// One constant for the "Worktable is reachable" reminder, shared by the CLI
// (launch + setup banners) and the server boot banner so the three surfaces can
// never drift (they previously carried three hand-written variants).
//
// The notice is SUPPRESSED when the operator has declared that HTTPS is
// terminated upstream — a tunnel or reverse proxy — via WORKTABLE_TLS_UPSTREAM=1
// (set by the CLI from the persisted `httpsUpstream` config).
//
// IMPORTANT: this acknowledgement governs the REMINDER ONLY. It does not change
// auth. The owner-password gate still keys off the bind interface, so an
// external tunnel pointed at a loopback bind stays un-gated. That residual gap
// is known and accepted: declaring HTTPS-upstream is an acknowledgement, not a
// security-posture change.

export const REACHABLE_NETWORK_NOTICE =
  "Your Worktable will be reachable over the network. It's recommended to put it behind an HTTPS tunnel (Tailscale, Cloudflare, etc.) for secure access.";

/** True when the operator has declared HTTPS is handled upstream (tunnel/proxy). */
export function tlsTerminatedUpstream(): boolean {
  return process.env["WORKTABLE_TLS_UPSTREAM"] === "1";
}
