import { defineConfig } from "astro/config"
import starlight from "@astrojs/starlight"
import starlightLlmsTxt from "starlight-llms-txt"
import { copyButtons } from "./src/lib/copy-buttons.ts"

export default defineConfig({
  site: "https://docs.worktable.dev",
  redirects: {
    "/concepts/files-are-the-protocol": "/reference/workspace-files/",
    "/concepts/file-based-foundation": "/reference/workspace-files/",
    "/concepts/content-model": "/#choose-content",
    "/concepts/how-agents-fit": "/agents/overview/",
    "/start/first-workspace": "/start/first-space/",
    "/guides/desktop": "/start/desktop/",
    "/agents/orientation": "/agents/overview/",
    "/workflows/for-product-teams": "/workflows/",
    "/workflows/agent-handoffs": "/workflows/project-handoffs/",
    "/guides/what-to-use-it-for": "/workflows/",
    "/guides/agent-handoffs": "/workflows/project-handoffs/",
    "/reference/troubleshooting": "/guides/troubleshooting/",
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
        PageTitle: "./src/components/PageTitle.astro",
        ThemeProvider: "./src/components/ThemeProvider.astro",
        // Brand lockup (app icon + wordmark)
        SiteTitle: "./src/components/SiteTitle.astro",
        // Section tabs in the header; search moves to the sidebar
        Header: "./src/components/Header.astro",
        // Static expanded groups filtered by the active header tab
        Sidebar: "./src/components/Sidebar.astro",
        TableOfContents: "./src/components/TableOfContents.astro",
        MobileTableOfContents: "./src/components/MobileTableOfContents.astro",
        // Icon toggle instead of the stock three-option select
        ThemeSelect: "./src/components/ThemeSelect.astro",
        // Quiet prev/next text links, scoped to the active tab
        Pagination: "./src/components/Pagination.astro",
        // Keep the privacy policy available from every documentation page.
        Footer: "./src/components/Footer.astro",
      },
      expressiveCode: {
        frames: { showCopyToClipboardButton: false },
        plugins: [copyButtons],
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
          label: "Get started",
          items: [
            { slug: "index" },
            { slug: "start/desktop" },
            { slug: "start/install" },
            { slug: "guides/worktable-cloud" },
            { label: "Connections", link: "/start/connect-your-agent/" },
            { slug: "start/first-space" },
          ],
        },
        {
          label: "Workflows",
          items: [
            { slug: "workflows" },
            { slug: "workflows/research-decisions" },
            { slug: "workflows/project-handoffs" },
            { slug: "workflows/track-requests" },
            { slug: "workflows/interactive-tools" },
          ],
        },
        {
          label: "Use Worktable",
          items: [
            { slug: "guides/organize-and-find" },
            { slug: "guides/docs-and-versions" },
            { slug: "guides/drawings" },
            { slug: "guides/widgets" },
            { slug: "guides/records" },
            { slug: "guides/annotations" },
            { slug: "guides/threads" },
          ],
        },
        {
          label: "Manage Worktable",
          items: [
            { slug: "guides/sharing" },
            { slug: "guides/import-export" },
            { slug: "guides/remote-access" },
            { slug: "guides/update-and-uninstall" },
            { slug: "guides/cloud-account" },
            { slug: "guides/troubleshooting" },
          ],
        },
        {
          label: "Agent setup",
          items: [
            { slug: "agents/overview" },
            { slug: "agents/setup" },
            { slug: "agents/connections" },
            { slug: "agents/skills" },
          ],
        },
        {
          label: "Agent workflows",
          items: [
            { slug: "agents/find-context" },
            { slug: "agents/writing-docs" },
            { slug: "agents/drawings" },
            { slug: "agents/building-widgets" },
            { slug: "agents/records-and-schemas" },
            { slug: "agents/annotations-protocol" },
            { slug: "agents/threads" },
          ],
        },
        {
          label: "Installation",
          items: [
            { slug: "reference/desktop" },
            { slug: "reference/cli" },
            { slug: "reference/cli-commands" },
            { slug: "reference/installer" },
            { slug: "reference/configuration" },
          ],
        },
        {
          label: "Agent tools",
          items: [
            { slug: "reference/mcp" },
            { slug: "reference/mcp-tools" },
            { slug: "reference/records" },
            { slug: "reference/html-doc-runtime" },
            { slug: "reference/drawing-operations" },
          ],
        },
        {
          label: "Data and access",
          items: [
            { slug: "reference/workspace-files" },
            { slug: "reference/workspace-packages" },
            { slug: "reference/security" },
            { slug: "reference/mcp-migration" },
          ],
        },
        {
          label: "Contributing",
          items: [{ slug: "contributing" }],
        },
        {
          label: "Project",
          items: [
            { slug: "whats-new" },
            {
              label: "GitHub releases",
              link: "https://github.com/worktable/worktable-dev/releases",
            },
          ],
        },
      ],
      plugins: [
        starlightLlmsTxt({
          projectName: "Worktable",
          description:
            "Open-source workspace for documents, drawings, interactive HTML, records, and conversations shared by people and their agents.",
          details: [
            "Run a workspace locally, on your own server, or in Cloud. Open it in Desktop or a browser.",
            "Connect agents from Settings → Agents; authentication and bootstrap depend on the deployment and client.",
            "Agents should start at the bootstrap below for setup, connections, and optional skills.",
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
