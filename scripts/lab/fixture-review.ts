import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { FIXTURE_SLUGS, type FixtureSlug } from "./workspace-seed.ts"

export interface ReviewCheck {
  title: string
  instruction: string
}

export interface McpReviewCheck extends ReviewCheck {
  expectedEvidence: string[]
  mutatesWorkspace: boolean
  references: string[]
}

export interface FixtureReview {
  fixture: FixtureSlug | "first-run" | "empty"
  purpose: string
  uiChecks: ReviewCheck[]
  mcpChecks: McpReviewCheck[]
}

const REPO_ROOT = resolve(import.meta.dirname, "..", "..")
const FIXTURE_ROOT = join(REPO_ROOT, "fixtures", "workspaces")

const discovery = (space: string, ...spaceIds: string[]): McpReviewCheck => ({
  title: "Discover the workspace",
  instruction: `Use Worktable tools to inspect the workspace and identify the ${space} space. Do not use shell or filesystem tools.`,
  expectedEvidence: ["worktable_discover", space],
  mutatesWorkspace: false,
  references: spaceIds.map((spaceId) => `spaces/${spaceId}/space.json`),
})

export const FIXTURE_REVIEWS: Record<FixtureSlug, FixtureReview> = {
  "basic-docs": {
    fixture: "basic-docs",
    purpose: "A small workspace covering nested Markdown and rich documents.",
    uiChecks: [
      {
        title: "Open Notes",
        instruction:
          "Open the Notes space and confirm its document list is readable.",
      },
      {
        title: "Check both formats",
        instruction:
          "Open Getting Started and Ideas; confirm the nested Markdown and rich document both render.",
      },
    ],
    mcpChecks: [
      discovery("Notes", "notes"),
      {
        title: "Read nested and rich docs",
        instruction:
          "Use Worktable to read guide/getting-started and ideas in Notes, then explain how their formats differ.",
        expectedEvidence: [
          "worktable_docs_read",
          "guide/getting-started",
          "ideas",
        ],
        mutatesWorkspace: false,
        references: [
          "spaces/notes/docs/guide/getting-started.md",
          "spaces/notes/docs/ideas.json",
        ],
      },
      {
        title: "Create a visible annotation",
        instruction:
          "Pause for approval, then add an annotation to readme saying the isolated MCP review succeeded. Ask the reviewer to confirm it in the UI.",
        expectedEvidence: ["worktable_annotations_write", "readme"],
        mutatesWorkspace: true,
        references: ["spaces/notes/docs/readme.md"],
      },
    ],
  },
  engineer: {
    fixture: "engineer",
    purpose:
      "An engineering workspace spanning runbooks, incidents, services, an HTML incident board, and annotations.",
    uiChecks: [
      {
        title: "Review the runbook",
        instruction:
          "Open Payment Failures and inspect its existing annotation.",
      },
      {
        title: "Review structured surfaces",
        instruction:
          "Open Incidents, Services, and the Incident Board HTML doc.",
      },
    ],
    mcpChecks: [
      discovery("Platform Engineering", "platform"),
      {
        title: "Trace a payment incident",
        instruction:
          "Search Worktable for payment failures, read the runbook, and query the incidents and services collections for related evidence.",
        expectedEvidence: [
          "worktable_discover",
          "worktable_docs_read",
          "worktable_records_read",
        ],
        mutatesWorkspace: false,
        references: [
          "spaces/platform/docs/runbooks/payment-failures.md",
          "spaces/platform/records/incidents/schema.yaml",
          "spaces/platform/records/services/schema.yaml",
        ],
      },
      {
        title: "Inspect the incident board and annotation",
        instruction:
          "List and read the Incident Board HTML doc, then find the annotation attached to the payment-failures runbook.",
        expectedEvidence: ["worktable_html_read", "worktable_annotations_read"],
        mutatesWorkspace: false,
        references: [
          "spaces/platform/widgets/incident-board/widget.yaml",
          "spaces/platform/annotations/docs/runbooks/payment-failures.annotations.json",
        ],
      },
      {
        title: "Reply visibly",
        instruction:
          "Pause for approval, then reply to the payment-failures annotation with the incident evidence you found. Ask the reviewer to confirm the reply and agent attribution in the UI.",
        expectedEvidence: ["worktable_annotations_write"],
        mutatesWorkspace: true,
        references: [
          "spaces/platform/annotations/docs/runbooks/payment-failures.annotations.json",
        ],
      },
    ],
  },
  founder: {
    fixture: "founder",
    purpose:
      "A founder workspace connecting company docs, board updates, OKRs, hiring records, and an HTML dashboard.",
    uiChecks: [
      {
        title: "Review both spaces",
        instruction:
          "Open Company and Board, then inspect the Q3 operating plan and Q3 board update.",
      },
      {
        title: "Review operating data",
        instruction:
          "Open the OKR and Hiring Pipeline records and the Company Pulse HTML doc.",
      },
    ],
    mcpChecks: [
      discovery("Company and Board", "company", "board"),
      {
        title: "Connect strategy to operating data",
        instruction:
          "Read the Q3 operating plan and Q3 board update, then query the OKRs and hiring-pipeline collections and summarize the current priorities.",
        expectedEvidence: ["worktable_docs_read", "worktable_records_read"],
        mutatesWorkspace: false,
        references: [
          "spaces/company/docs/okrs/q3.md",
          "spaces/board/docs/updates/2026-q3.md",
          "spaces/company/records/okrs/schema.yaml",
          "spaces/company/records/hiring-pipeline/schema.yaml",
        ],
      },
      {
        title: "Inspect dashboard and instruction",
        instruction:
          "List and read the Company Pulse HTML doc, then find the annotation on the Q3 operating plan.",
        expectedEvidence: ["worktable_html_read", "worktable_annotations_read"],
        mutatesWorkspace: false,
        references: [
          "spaces/company/widgets/okr-dashboard/widget.yaml",
          "spaces/company/annotations/docs/okrs/q3.annotations.json",
        ],
      },
      {
        title: "Reply visibly",
        instruction:
          "Pause for approval, then reply to the Q3 operating-plan annotation with one concise observation. Ask the reviewer to confirm it and the agent attribution in the UI.",
        expectedEvidence: ["worktable_annotations_write"],
        mutatesWorkspace: true,
        references: [
          "spaces/company/annotations/docs/okrs/q3.annotations.json",
        ],
      },
    ],
  },
  "product-manager": {
    fixture: "product-manager",
    purpose:
      "A product workspace connecting PRDs, research, roadmap and feedback records, an HTML roadmap, and annotations.",
    uiChecks: [
      {
        title: "Review the PRD",
        instruction:
          "Open Product → PRDs → Offline Mode and inspect the existing comment.",
      },
      {
        title: "Review product data",
        instruction:
          "Open Roadmap and Feedback records, then open the Roadmap HTML doc.",
      },
    ],
    mcpChecks: [
      discovery("Product", "product"),
      {
        title: "Read the Offline Mode context",
        instruction:
          "Search Worktable for offline mode and read prds/offline-mode. Report the problem, goals, and success metric.",
        expectedEvidence: [
          "worktable_discover",
          "worktable_docs_read",
          "prds/offline-mode",
        ],
        mutatesWorkspace: false,
        references: ["spaces/product/docs/prds/offline-mode.md"],
      },
      {
        title: "Trace feedback to roadmap",
        instruction:
          "Query Feedback for fb-001 and Roadmap for offline-mode. Explain the reference and report quarter and status.",
        expectedEvidence: ["worktable_records_read", "fb-001", "offline-mode"],
        mutatesWorkspace: false,
        references: [
          "spaces/product/records/feedback/fb-001.yaml",
          "spaces/product/records/roadmap/offline-mode.yaml",
        ],
      },
      {
        title: "Inspect HTML and annotations",
        instruction:
          "List and read the Roadmap HTML doc, then find the annotation attached to prds/offline-mode.",
        expectedEvidence: ["worktable_html_read", "worktable_annotations_read"],
        mutatesWorkspace: false,
        references: [
          "spaces/product/widgets/roadmap-timeline/widget.yaml",
          "spaces/product/annotations/docs/prds/offline-mode.annotations.json",
        ],
      },
      {
        title: "Reply visibly",
        instruction:
          "Pause for approval, then reply to the Offline Mode annotation with the fb-001 and roadmap evidence. Ask the reviewer to confirm the reply and agent attribution in the UI.",
        expectedEvidence: ["worktable_annotations_write"],
        mutatesWorkspace: true,
        references: [
          "spaces/product/annotations/docs/prds/offline-mode.annotations.json",
        ],
      },
    ],
  },
  "wiki-links": {
    fixture: "wiki-links",
    purpose:
      "An interlinked documentation workspace covering links, backlinks, orphans, broken links, and review freshness.",
    uiChecks: [
      {
        title: "Follow the atlas",
        instruction:
          "Open Field Atlas → Overview and follow links to Setup, Usage, and API Reference.",
      },
      {
        title: "Inspect trust signals",
        instruction:
          "Compare linked documents with the orphan scratchpad and inspect freshness/review indicators.",
      },
    ],
    mcpChecks: [
      discovery("Field Atlas", "atlas"),
      {
        title: "Inspect links and backlinks",
        instruction:
          "Read overview and reference/api through Worktable. Report resolved links, the deliberate broken changelog link, and API Reference backlinks.",
        expectedEvidence: ["worktable_docs_read", "backlinks", "reference/api"],
        mutatesWorkspace: false,
        references: [
          "spaces/atlas/docs/overview.md",
          "spaces/atlas/docs/reference/api.md",
        ],
      },
      {
        title: "Find the orphan and annotation",
        instruction:
          "Use Worktable discovery tools to identify the orphan scratchpad and the open annotation on overview.",
        expectedEvidence: [
          "worktable_docs_read",
          "worktable_annotations_read",
          "orphan-scratchpad",
        ],
        mutatesWorkspace: false,
        references: [
          "spaces/atlas/docs/orphan-scratchpad.md",
          "spaces/atlas/annotations/docs/overview.annotations.json",
        ],
      },
      {
        title: "Reply visibly",
        instruction:
          "Pause for approval, then reply to the overview annotation with the link-health findings. Ask the reviewer to confirm it and the agent attribution in the UI.",
        expectedEvidence: ["worktable_annotations_write"],
        mutatesWorkspace: true,
        references: ["spaces/atlas/annotations/docs/overview.annotations.json"],
      },
    ],
  },
}

export const FIRST_RUN_REVIEW: FixtureReview = {
  fixture: "first-run",
  purpose:
    "A genuinely absent workspace exercising first-run creation and the seeded Welcome experience.",
  uiChecks: [
    {
      title: "Create the workspace",
      instruction:
        "Choose Create a new workspace and continue through the real onboarding flow.",
    },
    {
      title: "Review Welcome",
      instruction:
        "Confirm Worktable opens the Welcome document and that navigation, theme, and Settings are usable.",
    },
  ],
  mcpChecks: [
    discovery("Welcome"),
    {
      title: "Read the starter document",
      instruction:
        "Use Worktable discovery and read tools to find and summarize the Welcome starter document.",
      expectedEvidence: [
        "worktable_discover",
        "worktable_docs_read",
        "Welcome",
      ],
      mutatesWorkspace: false,
      references: [],
    },
    {
      title: "Create a visible annotation",
      instruction:
        "Pause for approval, then add an annotation to the starter document saying the isolated MCP review succeeded. Ask the reviewer to confirm it in the UI.",
      expectedEvidence: ["worktable_annotations_write"],
      mutatesWorkspace: true,
      references: [],
    },
  ],
}

export const EMPTY_REVIEW: FixtureReview = {
  ...FIRST_RUN_REVIEW,
  fixture: "empty",
  purpose:
    "An existing empty default directory exercising safe workspace creation and Welcome seeding.",
}

export function fixtureReview(fixture?: string): FixtureReview {
  if (!fixture) return FIRST_RUN_REVIEW
  if (fixture === "empty") return EMPTY_REVIEW
  const review = FIXTURE_REVIEWS[fixture as FixtureSlug]
  if (!review) throw new Error(`No review guide exists for fixture ${fixture}`)
  return review
}

export function validateFixtureReview(review: FixtureReview): string[] {
  if (review.fixture === "first-run" || review.fixture === "empty") return []
  const root = join(FIXTURE_ROOT, review.fixture)
  const errors: string[] = []
  for (const check of review.mcpChecks) {
    for (const reference of check.references) {
      const path = join(root, reference)
      if (!existsSync(path))
        errors.push(`${review.fixture}: missing ${reference}`)
      else if (readFileSync(path).length === 0)
        errors.push(`${review.fixture}: empty ${reference}`)
    }
  }
  return errors
}

export function renderMcpReviewMarkdown(review: FixtureReview): string {
  const lines = [
    "# Worktable MCP review",
    "",
    review.purpose,
    "",
    "Use Worktable MCP tools for every check. Do not inspect the workspace with shell or filesystem tools. Work one check at a time, report the evidence you observed, and pause for approval before any check marked **Mutation**.",
    "",
  ]
  review.mcpChecks.forEach((check, index) => {
    lines.push(
      `## ${index + 1}. ${check.title}${check.mutatesWorkspace ? " — Mutation" : ""}`
    )
    lines.push(
      "",
      check.instruction,
      "",
      `Expected evidence: ${check.expectedEvidence.join(", ")}`,
      ""
    )
  })
  return `${lines.join("\n").trim()}\n`
}

export function fixtureReviewSlugs(): readonly FixtureSlug[] {
  return FIXTURE_SLUGS
}
