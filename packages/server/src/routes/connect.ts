import { Hono } from "hono";
import {
  getConnectorBundle,
  renderConnectScript,
} from "../connector-assets.ts";
import { resolveOrigin } from "./system.ts";

// ============================================================
// Connector serving (/connect.sh, /connect.mjs)
// ============================================================
//
// Deliberately unauthenticated: the agent machine fetches these BEFORE it
// has any credential — the pairing code (a positional argument, never
// templated into the script) is what authorizes the actual redemption.
// Both responses are secret-free and derived only from server state.

export const connectRouter = new Hono();

connectRouter.get("/connect.sh", (c) => {
  const { origin } = resolveOrigin(c);
  return c.text(renderConnectScript(origin), 200, {
    "Content-Type": "text/x-shellscript; charset=utf-8",
    // The embedded origin follows the install's current public URL config.
    "Cache-Control": "no-store",
  });
});

connectRouter.get("/connect.mjs", async (c) => {
  const bundle = await getConnectorBundle();
  if (!bundle) {
    return c.json(
      {
        error:
          "Connector bundle unavailable in this install. Use Settings -> Agents -> Manual install.",
        code: "CONNECTOR_UNAVAILABLE",
      },
      404
    );
  }
  return c.text(bundle, 200, {
    "Content-Type": "text/javascript; charset=utf-8",
    "Cache-Control": "no-store",
  });
});
