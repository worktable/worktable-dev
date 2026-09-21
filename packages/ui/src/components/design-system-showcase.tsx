import { BarChart2, Users, Zap, Globe, Star, ArrowRight } from "lucide-react"

import { Button } from "./button"
import { Badge } from "./badge"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "./card"
import { Separator } from "./separator"
import { Skeleton } from "./skeleton"
import { Progress } from "./progress"
import { Avatar, AvatarFallback, AvatarImage } from "./avatar"
import { Input } from "./input"
import { Textarea } from "./textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs"
import { Switch } from "./switch"
import { SettingRow } from "./setting-row"
import { Callout } from "./callout"
import { EntityCard } from "./entity-card"
import { ComparisonTable } from "./comparison-table"
import { Timeline } from "./timeline"
import { SourceChip } from "./source-chip"
import { QuadrantChart } from "./quadrant-chart"
import { VerdictBadge } from "./verdict-badge"
import { KpiRow } from "./kpi-row"
import { SectionHeader } from "./section-header"
import { LinkCard } from "./link-card"
import { CopyField } from "./copy-field"
import { Snippet } from "./snippet"
import { SecretReveal } from "./secret-reveal"

// ---- Sample data ------------------------------------------------

const kpiItems = [
  {
    label: "Total Agents",
    value: "142",
    description: "Across all spaces",
    trend: { direction: "up" as const, label: "+12 this week" },
    icon: <Users className="size-4" />,
  },
  {
    label: "Boards Created",
    value: "2,840",
    trend: { direction: "up" as const, label: "+340 today" },
    icon: <BarChart2 className="size-4" />,
  },
  {
    label: "Avg. Board Score",
    value: "8.4",
    description: "Out of 10",
    trend: { direction: "flat" as const, label: "Stable" },
    icon: <Star className="size-4" />,
  },
  {
    label: "Latency (p95)",
    value: "94ms",
    trend: { direction: "down" as const, label: "-18ms vs last week" },
    icon: <Zap className="size-4" />,
    variant: "highlight" as const,
  },
]

const timelineItems = [
  {
    date: "Mar 2024",
    title: "Project Kickoff",
    description: "Initial architecture and design system planning session.",
    status: "complete" as const,
  },
  {
    date: "Jun 2024",
    title: "Alpha Release",
    description:
      "First internal release with core MCP tools and basic board rendering.",
    status: "complete" as const,
  },
  {
    date: "Now",
    title: "Beta v1.0",
    description:
      "Design system complete. Public beta launch with full shadcn component library.",
    status: "current" as const,
  },
  {
    date: "Q3 2025",
    title: "GA Release",
    description:
      "Production-ready with collaborative editing and agent marketplace.",
    status: "upcoming" as const,
  },
]

const comparisonItems = ["Worktable", "Notion AI", "Linear"]
const comparisonDimensions = [
  {
    label: "Agent-native",
    values: [
      { content: "Yes — MCP first", highlight: true },
      { content: "No" },
      { content: "No" },
    ],
  },
  {
    label: "Real-time sync",
    values: [
      { content: "WebSocket + file watch", highlight: true },
      { content: "Polling" },
      { content: "WebSocket" },
    ],
  },
  {
    label: "Open source",
    values: [
      { content: "✓ AGPL-3.0-only", highlight: true },
      { content: "✗ Proprietary" },
      { content: "✗ Proprietary" },
    ],
  },
  {
    label: "Board templates",
    values: [
      { content: "Research, Kanban, Brief" },
      { content: "Database, Doc" },
      { content: "Issue tracker" },
    ],
  },
]

const quadrantItems = [
  {
    name: "Worktable",
    x: 80,
    y: 85,
    size: 60,
    color: "oklch(0.511 0.096 186.391)",
  },
  { name: "Notion AI", x: 55, y: 70, size: 50 },
  { name: "Linear", x: 50, y: 45, size: 40, color: "oklch(0.6 0.118 184.704)" },
  { name: "Retool", x: 35, y: 65, size: 35, color: "oklch(0.78 0.15 75)" },
  { name: "Airtable", x: 40, y: 35, size: 30, color: "oklch(0.72 0.17 142)" },
]

// ---- Showcase Component -----------------------------------------

function DesignSystemShowcase() {
  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      {/* Header */}
      <div className="mx-auto max-w-5xl">
        <div className="mb-8">
          <div className="mb-2 flex items-center gap-3">
            <div className="flex size-8 items-center justify-center rounded-lg bg-surface-selected text-primary">
              <BarChart2 className="size-4 text-primary" />
            </div>
            <h1 className="text-2xl font-bold">Worktable DS</h1>
            <Badge variant="outline" className="text-xs">
              v1.0.0-beta
            </Badge>
          </div>
          <p className="max-w-prose text-sm text-muted-foreground">
            Worktable Design System — a living showcase of all components with
            sample data. Think Bloomberg Terminal meets Notion: editorial,
            data-first, information-dense without clutter.
          </p>
        </div>

        <Tabs defaultValue="custom" className="w-full">
          <TabsList>
            <TabsTrigger value="custom">Custom Components</TabsTrigger>
            <TabsTrigger value="base">Base Components</TabsTrigger>
          </TabsList>

          {/* CUSTOM COMPONENTS TAB */}
          <TabsContent value="custom" className="mt-6 flex flex-col gap-8">
            {/* KPI Row */}
            <section>
              <SectionHeader
                title="KPI Row"
                subtitle="Horizontal grid of stat cards for key metrics"
                level={2}
                action={<Badge variant="secondary">kpi-row</Badge>}
                className="mb-3"
              />
              <KpiRow items={kpiItems} columns={4} />
            </section>

            <Separator />

            {/* Callouts */}
            <section>
              <SectionHeader
                title="Callout"
                subtitle="Highlighted blocks for important information"
                level={2}
                action={<Badge variant="secondary">callout</Badge>}
                className="mb-3"
              />
              <div className="flex flex-col gap-2">
                <Callout variant="info" title="Info">
                  Worktable uses MCP tools to let AI agents create structured
                  boards directly.
                </Callout>
                <Callout variant="success" title="Build succeeded">
                  All 16 components installed and passing type checks.
                </Callout>
                <Callout variant="warning" title="Beta warning">
                  The MCP server and file sync APIs are still in active
                  development.
                </Callout>
                <Callout variant="danger" title="Breaking change">
                  Board schema v2 introduces incompatible changes to the{" "}
                  <code>stat-row</code> block format.
                </Callout>
              </div>
            </section>

            <Separator />

            {/* Section Headers */}
            <section>
              <SectionHeader
                title="Section Header"
                subtitle="Three levels of hierarchy for section dividers"
                level={2}
                action={<Badge variant="secondary">section-header</Badge>}
                className="mb-3"
              />
              <div className="flex flex-col gap-1 rounded-xl p-4 ring-1 ring-foreground/10">
                <SectionHeader
                  title="Level 1 Heading"
                  subtitle="Large, primary section divider"
                  level={1}
                  action={
                    <Button size="sm" variant="outline">
                      Action
                    </Button>
                  }
                />
                <Separator />
                <SectionHeader
                  title="Level 2 Heading"
                  subtitle="Default section label — most common"
                  level={2}
                  action={
                    <Button size="sm" variant="ghost">
                      View all
                    </Button>
                  }
                />
                <Separator />
                <SectionHeader
                  title="Level 3 Heading"
                  subtitle="Compact, sub-section label"
                  level={3}
                />
              </div>
            </section>

            <Separator />

            {/* Entity Cards */}
            <section>
              <SectionHeader
                title="Entity Card"
                subtitle="Person, company, product, or concept cards for research boards"
                level={2}
                action={<Badge variant="secondary">entity-card</Badge>}
                className="mb-3"
              />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <EntityCard
                  name="Anthropic"
                  subtitle="AI Safety Company"
                  description="Founded in 2021, building AI systems that are safe, beneficial, and understandable."
                  badges={[
                    { label: "AI Lab", variant: "secondary" },
                    { label: "Safety", variant: "outline" },
                  ]}
                  metadata={[
                    { label: "Founded", value: "2021" },
                    { label: "Employees", value: "700+" },
                    { label: "HQ", value: "San Francisco" },
                    { label: "Valuation", value: "$18B" },
                  ]}
                />
                <EntityCard
                  name="Claude Sonnet"
                  subtitle="Frontier AI Model"
                  avatar="https://upload.wikimedia.org/wikipedia/commons/thumb/8/8c/Claude_AI_logo.svg/200px-Claude_AI_logo.svg.png"
                  description="Anthropic's most capable and balanced model for production use."
                  badges={[
                    { label: "API", variant: "default" },
                    { label: "MCP", variant: "secondary" },
                  ]}
                  metadata={[
                    { label: "Context", value: "200K tokens" },
                    { label: "Speed", value: "Fast" },
                  ]}
                />
                <EntityCard
                  name="Worktable"
                  subtitle="Open Source Tool"
                  description="Visual workspace for AI agents. Agents create boards, humans read them."
                  badges={[
                    { label: "Open Source", variant: "outline" },
                    { label: "React", variant: "secondary" },
                    { label: "MCP", variant: "secondary" },
                  ]}
                  metadata={[
                    { label: "License", value: "AGPL-3.0-only" },
                    { label: "Stack", value: "Bun + Hono" },
                    { label: "UI", value: "shadcn v4" },
                    { label: "Status", value: "Beta" },
                  ]}
                />
              </div>
            </section>

            <Separator />

            {/* Comparison Table */}
            <section>
              <SectionHeader
                title="Comparison Table"
                subtitle="Side-by-side feature comparison with sticky dimension labels"
                level={2}
                action={<Badge variant="secondary">comparison-table</Badge>}
                className="mb-3"
              />
              <ComparisonTable
                items={comparisonItems}
                dimensions={comparisonDimensions}
              />
            </section>

            <Separator />

            {/* Timeline */}
            <section>
              <SectionHeader
                title="Timeline"
                subtitle="Vertical milestones with status and date labels"
                level={2}
                action={<Badge variant="secondary">timeline</Badge>}
                className="mb-3"
              />
              <div className="max-w-md">
                <Timeline items={timelineItems} />
              </div>
            </section>

            <Separator />

            {/* Verdict Badges */}
            <section>
              <SectionHeader
                title="Verdict Badge"
                subtitle="Clear recommendation indicators"
                level={2}
                action={<Badge variant="secondary">verdict-badge</Badge>}
                className="mb-3"
              />
              <div className="flex flex-wrap gap-3">
                <VerdictBadge verdict="recommended" />
                <VerdictBadge
                  verdict="consider"
                  label="Consider with caveats"
                />
                <VerdictBadge verdict="avoid" />
                <VerdictBadge verdict="neutral" label="Needs more data" />
              </div>
            </section>

            <Separator />

            {/* Source Chips */}
            <section>
              <SectionHeader
                title="Source Chip"
                subtitle="Inline reference pills for URLs and documents"
                level={2}
                action={<Badge variant="secondary">source-chip</Badge>}
                className="mb-3"
              />
              <div className="flex flex-wrap gap-2">
                <SourceChip
                  url="https://github.com/anthropics/anthropic-sdk-python"
                  label="anthropic-sdk-python"
                />
                <SourceChip
                  url="https://ui.shadcn.com"
                  domain="ui.shadcn.com"
                />
                <SourceChip
                  url="https://modelcontextprotocol.io"
                  label="MCP Spec"
                />
                <SourceChip url="https://base-ui.com" domain="base-ui.com" />
                <SourceChip url="https://tailwindcss.com" />
              </div>
            </section>

            <Separator />

            {/* Quadrant Chart */}
            <section>
              <SectionHeader
                title="Quadrant Chart"
                subtitle="2x2 SVG positioning chart for market or product analysis"
                level={2}
                action={<Badge variant="secondary">quadrant-chart</Badge>}
                className="mb-3"
              />
              <div className="max-w-md">
                <QuadrantChart
                  xLabel="Developer Experience"
                  yLabel="AI-Native Capability"
                  quadrantLabels={{
                    topLeft: "Capable, Complex",
                    topRight: "Leaders",
                    bottomLeft: "Laggards",
                    bottomRight: "Simple, Limited",
                  }}
                  items={quadrantItems}
                />
              </div>
            </section>

            <Separator />

            {/* Link Cards */}
            <section>
              <SectionHeader
                title="Link Card"
                subtitle="External resource cards with optional preview image"
                level={2}
                action={<Badge variant="secondary">link-card</Badge>}
                className="mb-3"
              />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <LinkCard
                  url="https://modelcontextprotocol.io"
                  title="Model Context Protocol"
                  description="An open protocol that enables seamless integration between LLM applications and external data sources and tools."
                  domain="modelcontextprotocol.io"
                />
                <LinkCard
                  url="https://ui.shadcn.com"
                  title="shadcn/ui"
                  description="Beautifully designed components built with Radix UI and Tailwind CSS."
                  domain="ui.shadcn.com"
                />
                <LinkCard
                  url="https://base-ui.com"
                  title="Base UI"
                  description="Unstyled, accessible components for building React user interfaces."
                  domain="base-ui.com"
                />
              </div>
            </section>
          </TabsContent>

          {/* BASE COMPONENTS TAB */}
          <TabsContent value="base" className="mt-6 flex flex-col gap-8">
            {/* Buttons */}
            <section>
              <SectionHeader
                title="Button"
                level={2}
                action={<Badge variant="secondary">button</Badge>}
                className="mb-3"
              />
              <div className="flex flex-wrap gap-2">
                <Button>Default</Button>
                <Button variant="secondary">Secondary</Button>
                <Button variant="outline">Outline</Button>
                <Button variant="ghost">Ghost</Button>
                <Button variant="destructive">Destructive</Button>
                <Button variant="link">Link</Button>
                <Button size="sm">Small</Button>
                <Button size="lg">Large</Button>
                <Button disabled>Disabled</Button>
              </div>
            </section>

            <Separator />

            {/* Badges */}
            <section>
              <SectionHeader
                title="Badge"
                level={2}
                action={<Badge variant="secondary">badge</Badge>}
                className="mb-3"
              />
              <div className="flex flex-wrap gap-2">
                <Badge>Default</Badge>
                <Badge variant="secondary">Secondary</Badge>
                <Badge variant="info">Info</Badge>
                <Badge variant="outline">Outline</Badge>
                <Badge variant="destructive">Destructive</Badge>
              </div>
            </section>

            <Separator />

            {/* Avatar */}
            <section>
              <SectionHeader
                title="Avatar"
                level={2}
                action={<Badge variant="secondary">avatar</Badge>}
                className="mb-3"
              />
              <div className="flex items-center gap-3">
                <Avatar>
                  <AvatarImage
                    src="https://github.com/shadcn.png"
                    alt="shadcn"
                  />
                  <AvatarFallback>SC</AvatarFallback>
                </Avatar>
                <Avatar>
                  <AvatarFallback>KH</AvatarFallback>
                </Avatar>
                <Avatar>
                  <AvatarFallback>AD</AvatarFallback>
                </Avatar>
              </div>
            </section>

            <Separator />

            {/* Progress */}
            <section>
              <SectionHeader
                title="Progress"
                level={2}
                action={<Badge variant="secondary">progress</Badge>}
                className="mb-3"
              />
              <div className="flex max-w-sm flex-col gap-3">
                <Progress value={33} />
                <Progress value={67} />
                <Progress value={100} />
              </div>
            </section>

            <Separator />

            {/* Skeleton */}
            <section>
              <SectionHeader
                title="Skeleton"
                level={2}
                action={<Badge variant="secondary">skeleton</Badge>}
                className="mb-3"
              />
              <div className="flex max-w-sm flex-col gap-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-8 w-full" />
              </div>
            </section>

            <Separator />

            {/* Form Inputs */}
            <section>
              <SectionHeader
                title="Form Inputs"
                level={2}
                action={<Badge variant="secondary">input · textarea</Badge>}
                className="mb-3"
              />
              <div className="flex max-w-sm flex-col gap-3">
                <Input placeholder="Search agents..." />
                <Textarea
                  placeholder="Describe your research goal..."
                  rows={3}
                />
              </div>
            </section>

            <Separator />

            {/* Switch */}
            <section>
              <SectionHeader
                title="Switch"
                level={2}
                action={<Badge variant="secondary">switch</Badge>}
                className="mb-3"
              />
              <div className="flex flex-wrap items-center gap-4">
                <Switch aria-label="Unchecked switch" />
                <Switch defaultChecked aria-label="Checked switch" />
                <Switch disabled aria-label="Disabled switch" />
                <Switch
                  defaultChecked
                  disabled
                  aria-label="Disabled checked switch"
                />
              </div>
            </section>

            <Separator />

            {/* Setting Row */}
            <section>
              <SectionHeader
                title="Setting Row"
                level={2}
                action={<Badge variant="secondary">setting-row</Badge>}
                className="mb-3"
              />
              <div className="max-w-md">
                <Card>
                  <CardContent className="divide-y divide-border">
                    <SettingRow
                      label="Agent presence"
                      description="Show a bronze marker when an agent is active in this space."
                    >
                      <Switch
                        defaultChecked
                        aria-label="Toggle agent presence"
                      />
                    </SettingRow>
                    <SettingRow
                      htmlFor="workspace-name"
                      label="Workspace name"
                      description="Displayed in the sidebar and browser tab."
                    >
                      <Input
                        id="workspace-name"
                        defaultValue="Worktable"
                        className="h-9 w-40"
                      />
                    </SettingRow>
                  </CardContent>
                </Card>
              </div>
            </section>

            <Separator />

            {/* Card */}
            <section>
              <SectionHeader
                title="Card"
                level={2}
                action={<Badge variant="secondary">card</Badge>}
                className="mb-3"
              />
              <div className="max-w-sm">
                <Card>
                  <CardHeader>
                    <CardTitle>Research Board</CardTitle>
                    <CardDescription>
                      Competitive analysis for Q3 AI tool evaluation
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Globe className="size-4" />
                      <span>12 entities · 4 sources</span>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </section>

            <Separator />

            {/* Tabs preview */}
            <section>
              <SectionHeader
                title="Tabs"
                level={2}
                action={<Badge variant="secondary">tabs</Badge>}
                className="mb-3"
              />
              <Tabs defaultValue="overview">
                <TabsList>
                  <TabsTrigger value="overview">Overview</TabsTrigger>
                  <TabsTrigger value="analysis">Analysis</TabsTrigger>
                  <TabsTrigger value="sources">Sources</TabsTrigger>
                </TabsList>
                <TabsContent
                  value="overview"
                  className="mt-2 rounded-lg border border-border p-3 text-sm text-muted-foreground"
                >
                  Overview content goes here.
                </TabsContent>
                <TabsContent
                  value="analysis"
                  className="mt-2 rounded-lg border border-border p-3 text-sm text-muted-foreground"
                >
                  Analysis content goes here.
                </TabsContent>
                <TabsContent
                  value="sources"
                  className="mt-2 rounded-lg border border-border p-3 text-sm text-muted-foreground"
                >
                  Sources content goes here.
                </TabsContent>
              </Tabs>
            </section>

            <Separator />

            {/* Copy & secrets */}
            <section>
              <SectionHeader
                title="Copy & secrets"
                subtitle="Copyable values, code snippets, and one-time secrets"
                level={2}
                action={
                  <Badge variant="secondary">
                    copy-field · snippet · secret-reveal
                  </Badge>
                }
                className="mb-3"
              />
              <div className="flex max-w-lg flex-col gap-3">
                <CopyField
                  label="MCP endpoint"
                  value="http://127.0.0.1:7480/mcp"
                />
                <Snippet
                  code={
                    "claude mcp add --transport http worktable http://127.0.0.1:7480/mcp --scope user"
                  }
                />
                <SecretReveal secret="wt_ab12cd34ef56_S3cr3tT0k3nValueGoesHere" />
              </div>
            </section>
          </TabsContent>
        </Tabs>

        {/* Footer */}
        <div className="mt-12 flex items-center justify-between border-t border-border pt-6 text-xs text-muted-foreground">
          <span>Worktable DS · Worktable v1.0.0-beta</span>
          <div className="flex items-center gap-1">
            <span>View on GitHub</span>
            <ArrowRight className="size-3" />
          </div>
        </div>
      </div>
    </div>
  )
}

export { DesignSystemShowcase }
