// Serves the agents/overview page as raw markdown at /agents.md — the one
// URL to paste into an agent. Same content-collection entry humans read at
// /agents/overview/, so the two surfaces cannot fork.
import type { APIRoute } from "astro";
import { getEntry } from "astro:content";

const SITE = "https://docs.worktable.dev";

export const GET: APIRoute = async () => {
  const entry = await getEntry("docs", "agents/overview");
  if (!entry?.body) {
    return new Response("Not found", { status: 404 });
  }
  const body = entry.body
    // absolutize root-relative markdown links for readers outside the site
    .replace(/\]\(\//g, `](${SITE}/`)
    .trim();
  const markdown = `# ${entry.data.title}\n\n${body}\n`;
  return new Response(markdown, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
};
