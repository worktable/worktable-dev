import { SourceCodeLink } from "@/components/source-code-link";
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
  sourceUrl?: string;
  exposed: boolean;
  hasOwnerPassword: boolean;
  authenticated: boolean;
}

const MIN_PASSWORD_LENGTH = 8;

/**
 * Validate the ?next target is a same-origin path so an open redirect cannot be
 * smuggled in. Only a leading-slash path (not "//" protocol-relative) is allowed.
 */
function safeNext(): string {
  if (typeof window === "undefined") return "/";
  const raw = new URLSearchParams(window.location.search).get("next");
  if (!raw) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

function LoginPage() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isHttp =
    typeof window !== "undefined" && window.location.protocol !== "https:";
  const needsSetup = status ? !status.hasOwnerPassword : false;

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
        if (json.authenticated) {
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
  }, [redirectNext]);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);

      if (needsSetup) {
        if (password.length < MIN_PASSWORD_LENGTH) {
          setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
          return;
        }
        if (password !== confirmPassword) {
          setError("Passwords do not match.");
          return;
        }
      } else if (!password) {
        setError("Enter your owner password.");
        return;
      }

      setSubmitting(true);
      try {
        const path = needsSetup ? "/auth/password" : "/auth/login";
        const res = await fetch(`${BASE_URL}${path}`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password }),
        });
        if (res.ok) {
          redirectNext();
          return;
        }
        if (res.status === 401) {
          setError("Incorrect password. Try again.");
        } else if (res.status === 409) {
          // Password was set elsewhere in the meantime — fall back to login mode.
          setStatus((s) => (s ? { ...s, hasOwnerPassword: true } : s));
          setError("This workspace already has a password. Sign in instead.");
        } else {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setError(body.error ?? "Something went wrong. Try again.");
        }
      } catch {
        setError("Could not reach the server. Try again.");
      } finally {
        setSubmitting(false);
      }
    },
    [needsSetup, password, confirmPassword, redirectNext]
  );

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4 py-10 text-foreground">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <WorktableAppIcon className="mb-4 size-12" />
          <h1 className="text-lg font-semibold">
            {needsSetup ? "Set your owner password" : "Sign in to Worktable"}
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {needsSetup
              ? "Create a password to protect this workspace over the network."
              : "Enter your owner password to open this workspace."}
          </p>
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

        <form onSubmit={onSubmit} className="space-y-3">
          <div className="relative">
            <Lock className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="password"
              autoComplete={needsSetup ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              className="pl-9"
              autoFocus
              disabled={submitting || !status}
            />
          </div>

          {needsSetup && (
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
              ? needsSetup
                ? "Setting password…"
                : "Signing in…"
              : needsSetup
                ? "Set password"
                : "Sign in"}
          </Button>
        </form>
        {status?.sourceUrl ? (
          <div className="mt-4 text-center">
            <SourceCodeLink sourceUrl={status.sourceUrl} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
