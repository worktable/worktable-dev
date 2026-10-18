import { runtimePath } from "@/lib/runtime-path"
import { notifyBrowserAccountChanged } from "@/lib/auth-events"
import { clearTeamBrowserData } from "@/lib/team-context"
import { useCallback, useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { AlertTriangle, Lock } from "lucide-react";
import { Button } from "@worktable/ui/components/button";
import { Input } from "@worktable/ui/components/input";
import { WorktableAppIcon } from "@/components/worktable-app-icon";
import { BASE_URL } from "@/lib/http";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

interface AuthStatus {
  exposed: boolean;
  hasOwnerPassword: boolean;
  authenticated: boolean;
  teamsEnabled?: boolean;
}

const MIN_PASSWORD_LENGTH = 8;

/**
 * Validate the ?next target is a same-origin path so an open redirect cannot be
 * smuggled in. Only a leading-slash path (not "//" protocol-relative) is allowed.
 */
function safeNext(): string {
  if (typeof window === "undefined") return "/";
  const raw = new URLSearchParams(window.location.search).get("next");
  if (!raw) return runtimePath("/");
  if (!raw.startsWith("/") || raw.startsWith("//")) return runtimePath("/");
  return raw;
}

interface InvitationDetails {
  worktableName: string;
  inviterName: string | null;
  spaceName: string | null;
  email: string;
  expiresAt: number;
}

/** What the held invitation is for, or why it can't be used. */
function useInvitationDetails(
  invitationId: string | null
): InvitationDetails | { error: string } | null {
  const [details, setDetails] = useState<
    InvitationDetails | { error: string } | null
  >(null);
  useEffect(() => {
    if (!invitationId) return;
    let cancelled = false;
    fetch(`${BASE_URL}/auth/team/invitations/${encodeURIComponent(invitationId)}`, {
      credentials: "include",
    })
      .then(async (response) => {
        const body = (await response.json()) as InvitationDetails & { error?: string };
        if (cancelled) return;
        if (response.ok) setDetails(body);
        else if (response.status === 410)
          setDetails({ error: body.error ?? "This invitation is no longer available" });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [invitationId]);
  return details;
}

function expiresIn(at: number): string {
  const hours = Math.floor((at - Date.now()) / 3_600_000);
  if (hours < 1) return "Expires in under an hour";
  if (hours < 48) return `Expires in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  return `Expires in ${Math.floor(hours / 24)} days`;
}

function LoginPage() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const search = typeof window === "undefined" ? "" : window.location.search;
  const invitationId = new URLSearchParams(search).get("invite");
  // A password reset link from an owner or the Worktable's machine.
  const [resetToken, setResetToken] = useState(() =>
    new URLSearchParams(search).get("reset")
  );
  const [notice, setNotice] = useState<string | null>(null);
  const invite = useInvitationDetails(invitationId);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isHttp =
    typeof window !== "undefined" && window.location.protocol !== "https:";
  const needsSetup = status ? !status.teamsEnabled && !status.hasOwnerPassword : false;
  const resetting = Boolean(resetToken && status?.teamsEnabled);
  const choosingPassword = needsSetup || resetting;

  const redirectNext = useCallback(() => {
    window.location.assign(safeNext());
  }, []);

  // On mount: if already authenticated, bounce to ?next; otherwise show the form.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${BASE_URL}/auth/status`, {
          credentials: "include",
        });
        const json = (await res.json()) as AuthStatus;
        if (cancelled) return;
        if (json.authenticated && !invitationId && !resetToken) {
          redirectNext();
          return;
        }
        setStatus(json);
      } catch {
        if (!cancelled) {
          setStatus({
            exposed: true,
            hasOwnerPassword: true,
            authenticated: false,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [redirectNext, invitationId, resetToken]);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);

      if (choosingPassword) {
        if (password.length < MIN_PASSWORD_LENGTH) {
          setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
          return;
        }
        if (password !== confirmPassword) {
          setError("Passwords do not match.");
          return;
        }
      } else if (!password) {
        setError(status?.teamsEnabled ? "Enter your password." : "Enter your owner password.");
        return;
      }

      setSubmitting(true);
      try {
        const path = resetting ? "/auth/team/reset-password" : invitationId ? "/auth/team/enroll" : status?.teamsEnabled ? "/auth/team/sign-in/email" : needsSetup ? "/auth/password" : "/auth/login";
        const res = await fetch(`${BASE_URL}${path}`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(resetting ? { token: resetToken, newPassword: password } : invitationId ? { invitationId, name, password } : status?.teamsEnabled ? { email, password } : { password }),
        });
        if (res.ok && resetting) {
          const url = new URL(window.location.href);
          url.searchParams.delete("reset");
          window.history.replaceState(null, "", url);
          setResetToken(null);
          setPassword("");
          setConfirmPassword("");
          setNotice("Password changed. Sign in with your new password.");
          return;
        }
        if (res.ok) {
          // A new member opens the Space they were invited into.
          const joined = invitationId
            ? ((await res.json().catch(() => ({}))) as { spaceId?: unknown })
            : {};
          if (status?.teamsEnabled) {
            notifyBrowserAccountChanged();
            await clearTeamBrowserData();
          }
          if (typeof joined.spaceId === "string" && joined.spaceId) {
            window.location.assign(runtimePath(`/spaces/${encodeURIComponent(joined.spaceId)}`));
            return;
          }
          redirectNext();
          return;
        }
        if (resetting && res.status === 400) {
          setError("This reset link has expired or was already used. Ask an owner for a new one.");
        } else if (res.status === 401 && invitationId) {
          setError("This email already has an account here. Use its password, or ask an owner for a reset link.");
        } else if (res.status === 401) {
          setError("Incorrect password. Try again.");
        } else if (res.status === 409) {
          // Password was set elsewhere in the meantime — fall back to login mode.
          setStatus((s) => (s ? { ...s, hasOwnerPassword: true } : s));
          setError("This workspace already has a password. Sign in instead.");
        } else {
          const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
          setError(body.message ?? body.error ?? "Something went wrong. Try again.");
        }
      } catch {
        setError("Could not reach the server. Try again.");
      } finally {
        setSubmitting(false);
      }
    },
    [needsSetup, choosingPassword, resetting, resetToken, password, confirmPassword, redirectNext, status?.teamsEnabled, invitationId, email, name]
  );

  const joinTitle =
    invite && !("error" in invite) ? `Join ${invite.worktableName}` : "Join Worktable";

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4 py-10 text-foreground">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <WorktableAppIcon className="mb-4 size-12" />
          <h1 className="text-lg font-semibold">
            {resetting ? "Choose a new password" : invitationId ? (invite && "error" in invite ? "This invitation can’t be used" : joinTitle) : needsSetup ? "Set your owner password" : "Sign in to Worktable"}
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {resetting ? "This link works once. Choosing a new password signs you out everywhere." : invitationId ? (invite && "error" in invite ? `${invite.error}. Ask whoever invited you for a new one.` : invite ? `${invite.inviterName ?? "A teammate"} invited you to ${invite.spaceName ?? "work with the team"}. Choose a name and password, or use your password if you already have an account here.` : "Choose a name and password for your individual account. If you already have an account here, use its password.") : status?.teamsEnabled ? "Sign in with your individual account." : needsSetup
              ? "Create a password to protect this workspace over the network."
              : "Enter your owner password to open this workspace."}
          </p>
          {invite && !("error" in invite) && (
            <p className="mt-3 text-xs text-muted-foreground">
              For {invite.email} · {expiresIn(invite.expiresAt)}
            </p>
          )}
        </div>

        {isHttp && (
          <div className="mb-4 flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>
              This connection is not encrypted (plain http). Your password and
              session can be read on the network. Use an https tunnel.
            </span>
          </div>
        )}

        {invite && "error" in invite ? null : (
        <form onSubmit={onSubmit} className="space-y-3">
          {resetting ? null : invitationId ? <Input aria-label="Name" autoComplete="name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required disabled={submitting || !status} /> : status?.teamsEnabled ? <Input aria-label="Email" type="email" autoComplete="username" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required disabled={submitting || !status} /> : null}
          <div className="relative">
            <Lock className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="password"
              aria-label="Password"
              autoComplete={choosingPassword || invitationId ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              className="pl-9"
              autoFocus
              disabled={submitting || !status}
            />
          </div>

          {choosingPassword && (
            <div className="relative">
              <Lock className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Confirm password"
                className="pl-9"
                disabled={submitting || !status}
              />
            </div>
          )}

          {notice && !error && (
            <p className="text-sm text-muted-foreground" role="status">
              {notice}
            </p>
          )}
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}

          <Button
            type="submit"
            className="w-full"
            disabled={submitting || !status}
          >
            {submitting
              ? choosingPassword
                ? "Setting password…"
                : "Signing in…"
              : resetting ? "Set new password" : invitationId ? joinTitle : needsSetup
                ? "Set password"
                : "Sign in"}
          </Button>
        </form>
        )}
      </div>
    </div>
  );
}
