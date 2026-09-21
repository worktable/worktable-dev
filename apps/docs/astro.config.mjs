import { defineConfig } from "astro/config"
import starlight from "@astrojs/starlight"
import starlightLlmsTxt from "starlight-llms-txt"

export default defineConfig({
  site: "https://docs.worktable.dev",
  redirects: {
    "/concepts/files-are-the-protocol": "/concepts/file-based-foundation",
    "/start/first-workspace": "/start/first-space",
    "/guides/desktop": "/start/desktop",
    "/agents/orientation": "/agents/overview",
    "/workflows/for-product-teams": "/guides/what-to-use-it-for",
    "/workflows/agent-handoffs": "/guides/agent-handoffs",
  },
  integrations: [
    starlight({
      title: "Worktable Docs",
      description:
        "Use Worktable with people and AI agents across Desktop, Cloud, and self-hosted deployments.",
      favicon: "/favicon.svg",
      customCss: ["./src/styles/custom.css"],
      components: {
        // Dark default for first-time visitors (worktable.dev handoff)
        ThemeProvider: "./src/components/ThemeProvider.astro",
        // Brand lockup (app icon + wordmark)
        SiteTitle: "./src/components/SiteTitle.astro",
        // Section tabs in the header; search moves to the sidebar
        Header: "./src/components/Header.astro",
        // Static expanded groups filtered by the active header tab
        Sidebar: "./src/components/Sidebar.astro",
        // Icon toggle instead of the stock three-option select
        ThemeSelect: "./src/components/ThemeSelect.astro",
        // Quiet prev/next text links, scoped to the active tab
        Pagination: "./src/components/Pagination.astro",
        // Keep the privacy choice available from every documentation page.
        Footer: "./src/components/Footer.astro",
      },
      expressiveCode: {
        styleOverrides: {
          borderRadius: "0.625rem",
          borderColor: "var(--border-chrome)",
          codeBackground: "var(--well-bg)",
          codeFontFamily: "var(--sl-font-mono)",
          frames: {
            shadowColor: "transparent",
            terminalBackground: "var(--well-bg)",
            terminalTitlebarBackground: "transparent",
            editorTabBarBackground: "transparent",
            editorActiveTabBackground: "var(--well-bg)",
          },
        },
      },
      head: [
        {
          tag: "link",
          attrs: { rel: "preconnect", href: "https://api.fontshare.com" },
        },
        {
          tag: "link",
          attrs: {
            rel: "preconnect",
            href: "https://cdn.fontshare.com",
            crossorigin: true,
          },
        },
        {
          tag: "link",
          attrs: { rel: "preconnect", href: "https://fonts.googleapis.com" },
        },
        {
          tag: "link",
          attrs: {
            rel: "preconnect",
            href: "https://fonts.gstatic.com",
            crossorigin: true,
          },
        },
        {
          // Shell chrome wiring: html[data-scrolled] drives the glass
          // header's scroll shadow; the sidebar pane gets the app's
          // scroll-fade masks (data-scroll-top/bottom contract).
          tag: "script",
          content: [
            "(function () {",
            "  function init() {",
            "    var html = document.documentElement;",
            "    function onScroll() {",
            "      html.toggleAttribute('data-scrolled', window.scrollY > 8);",
            "      html.toggleAttribute('data-scroll-end', window.scrollY + window.innerHeight >= html.scrollHeight - 8);",
            "    }",
            "    addEventListener('scroll', onScroll, { passive: true });",
            "    addEventListener('resize', onScroll, { passive: true });",
            "    onScroll();",
            "    var pane = document.getElementById('starlight__sidebar');",
            "    if (!pane) return;",
            "    pane.classList.add('scroll-fade');",
            "    function update() {",
            "      pane.toggleAttribute('data-scroll-top', pane.scrollTop > 4);",
            "      pane.toggleAttribute('data-scroll-bottom', pane.scrollTop + pane.clientHeight < pane.scrollHeight - 4);",
            "    }",
            "    pane.addEventListener('scroll', update, { passive: true });",
            "    if (window.ResizeObserver) new ResizeObserver(update).observe(pane);",
            "    update();",
            "  }",
            "  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);",
            "  else init();",
            "})();",
          ].join("\n"),
        },
      ],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/worktable/worktable-dev",
        },
      ],
      sidebar: [
        {
          label: "Start",
          items: [
            { slug: "start/desktop" },
            { slug: "guides/worktable-cloud" },
            { slug: "start/install" },
            { slug: "start/connect-your-agent" },
            { slug: "start/first-space" },
          ],
        },
        {
          label: "Concepts",
          items: [
            { slug: "concepts/file-based-foundation" },
            { slug: "concepts/content-model" },
            { slug: "concepts/how-agents-fit" },
          ],
        },
        {
          label: "Guides",
          items: [
            { slug: "guides/what-to-use-it-for" },
            { slug: "guides/organize-and-find" },
            { slug: "guides/docs-and-versions" },
            { slug: "guides/import-export" },
            { slug: "guides/annotations" },
            { slug: "guides/widgets" },
            { slug: "guides/records" },
            { slug: "guides/agent-handoffs" },
            { slug: "guides/threads" },
            { slug: "guides/remote-access" },
            { slug: "guides/update-and-uninstall" },
          ],
        },
        {
          label: "Agents",
          items: [
            { slug: "agents/overview" },
            { slug: "agents/writing-docs" },
            { slug: "agents/building-widgets" },
            { slug: "agents/records-and-schemas" },
            { slug: "agents/annotations-protocol" },
            { slug: "agents/threads" },
          ],
        },
        {
          label: "Reference",
          items: [
            { slug: "reference/desktop" },
            { slug: "reference/cli" },
            { slug: "reference/cli-commands" },
            { slug: "reference/installer" },
            { slug: "reference/configuration" },
            { slug: "reference/mcp" },
            { slug: "reference/mcp-tools" },
            { slug: "reference/mcp-migration" },
            { slug: "reference/records" },
            { slug: "reference/html-doc-runtime" },
            { slug: "reference/workspace-files" },
            { slug: "reference/workspace-packages" },
            { slug: "reference/security" },
            { slug: "reference/troubleshooting" },
          ],
        },
        {
          label: "Project",
          items: [
            { slug: "whats-new" },
            {
              label: "Releases on GitHub",
              link: "https://github.com/worktable/worktable-dev/releases",
              attrs: { target: "_blank" },
            },
          ],
        },
      ],
      plugins: [
        starlightLlmsTxt({
          projectName: "Worktable",
          description:
            "File-backed workspace shared by humans and AI agents — docs, HTML docs, records, annotations, and durable conversations across Desktop, Cloud, and self-hosted deployments.",
          details: [
            "Choose Worktable Desktop, Worktable Cloud, or the CLI for a local or self-hosted deployment.",
            "Connect agents from Settings → Agents; authentication and bootstrap depend on the deployment and client.",
            "Agents should start at the bootstrap manifest below, then read the agents guide set.",
          ].join(" "),
          optionalLinks: [
            {
              label: "Agent bootstrap manifest",
              url: "https://docs.worktable.dev/agents.md",
              description:
                "Connect, orient, and work in a Worktable workspace — raw markdown, one URL to give an agent.",
            },
          ],
          customSets: [
            {
              label: "Agents guide",
              paths: ["agents/**"],
              description: "How agents operate a Worktable workspace well.",
            },
          ],
          promote: ["index*", "agents/**"],
        }),
      ],
    }),
  ],
})
