# Worktable

A local-first workspace for you and your AI agents.

Keep the work you do with agents somewhere you can return to: research, plans,
interactive tools, and project records. Worktable gives you a visual workspace to
read, edit, and review that work, while your agents use the same content through
MCP. Switch agents or start a new conversation without starting the project over.

[Get started](#get-started) · [Documentation](https://docs.worktable.dev) · [Releases](https://github.com/worktable/worktable-dev/releases) · [Contributing](CONTRIBUTING.md)

![A project plan in Worktable, with related documents and records in the sidebar and review comments beside the document.](docs/images/worktable-workspace.png)

## Work that lasts beyond a chat

Ask an agent to research a decision and save the findings. Open the document,
leave a comment on what needs work, and have the agent revise it. Later, another
agent can pick up the same project with its documents and decisions intact.

- **Docs:** write and edit notes, research, plans, and reference material, with
  versions and links between documents.
- **Interactive HTML:** let an agent build a dashboard, calculator, or small tool
  you can use inside the workspace.
- **Records:** keep structured information such as tasks, projects, and research
  findings in collections that both you and your agents can update.
- **Review and conversations:** attach comments and instructions to the work,
  track changes, and continue discussions in persistent threads.

Worktable connects to the agents you already use. It supplies their shared
workspace; your agent client supplies the model and any required subscription
or API credentials. You can also write and organize content yourself.

## Your workspace is yours

Local and self-hosted workspaces live in a folder you control. Documents, HTML,
records, and metadata are stored as files, including Markdown, JSON, and YAML.
You can inspect them, back them up, or move the workspace to another machine.
See the [file-backed foundation](https://docs.worktable.dev/concepts/file-based-foundation/)
for the storage formats and portability model.

Local Worktable does not require a Worktable account. Connected agent providers
may process the content you give them under their own terms.

## Get started

Install on **macOS or Linux**, on Apple Silicon/arm64 or x64:

```sh
curl -fsSL https://worktable.dev/install | sh
```

The installer guides you through setup and prints the address to open in your
browser, normally `http://localhost:7480`. Your workspace defaults to
`~/Worktable`. You do not need Node, Bun, or a source checkout to use the release.
To open Worktable again later, run `worktable`.

Prefer to inspect the installer first? [Read the script](install.sh), or preview
its actions with `curl -fsSL https://worktable.dev/install | sh -s -- --dry-run`.

Next, open **Settings → Agents** and
[connect your agent](https://docs.worktable.dev/start/connect-your-agent/).
Create a space for a project and ask your agent to save a plan or research brief
there. [Your first space](https://docs.worktable.dev/start/first-space/) walks
through creating, reviewing, and continuing that work.

The current release provides the CLI and browser app. Desktop source is included;
see [Desktop availability](https://docs.worktable.dev/start/desktop/) for native
app installation status. For a server you control, follow the
[remote access guide](https://docs.worktable.dev/guides/remote-access/).
[Worktable Cloud](https://www.worktable.cloud) is the optional managed service.

## Learn more

- [Ways to use Worktable](https://docs.worktable.dev/guides/what-to-use-it-for/)
- [Agent setup and integrations](https://docs.worktable.dev/start/connect-your-agent/)
- [CLI and MCP reference](https://docs.worktable.dev/reference/cli/)
- [Develop from source](docs/development.md) and [build release artifacts](docs/building.md)

## Help and contribute

Worktable is actively developed. [Report a bug](https://github.com/worktable/worktable-dev/issues/new?template=bug_report.yml)
or [ask a question](https://github.com/worktable/worktable-dev/discussions/categories/q-a).
Use synthetic examples and remove private information from attachments.
Report vulnerabilities privately through [the security policy](SECURITY.md).

Fixes and documentation improvements are welcome. Please discuss substantial
features before implementing them so we can agree on scope and approach.
[CONTRIBUTING.md](CONTRIBUTING.md) covers development, review, and contribution
sign-off. [The changelog](CHANGELOG.md) records release changes.

## License

The Worktable application is **AGPL-3.0-only**, copyright Reva Labs.
See [LICENSE](LICENSE). Some shared components and agent plugins have MIT
licenses; [NOTICE](NOTICE) and the relevant package notices identify the exact
exceptions and third-party terms. Bundled runtime source and rebuild materials
are listed in [SOURCE-MATERIALS.json](SOURCE-MATERIALS.json).
