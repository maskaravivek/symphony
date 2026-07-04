# Symphony (MVP)

Symphony is a long-running service that polls GitHub Issues (by label), creates an isolated per-issue workspace, and runs a configured coding-agent command inside that workspace.

## Run

From repo root (or any directory that contains `WORKFLOW.md`):

```bash
yarn dev
```

Start by copying `WORKFLOW.example.md` to the target app repo as `WORKFLOW.md` and adjusting hooks/token.

For one server across multiple unrelated repos, create a central `symphony.config.yml` in this repo. If this repo sits beside the app repos, keep paths relative:

```yaml
polling:
  interval_ms: 30000
agent:
  max_concurrent_agents: 4
repos:
  - id: mdedit
    workflow: ../mdedit/WORKFLOW.md
    max_concurrent_agents: 2
    enabled: true
  - id: myaarti
    workflow: ../myaarti/WORKFLOW.md
    max_concurrent_agents: 1
    enabled: true
```

Then run:

```bash
yarn dev
```

## Visibility

Symphony writes per-issue artifacts under each workspace:

- `.symphony/prompt.md` (rendered prompt)
- `.symphony/codex.jsonl` (Codex `--json` output; tail this)
- `.symphony/last_message.md` (final agent message)
- `.symphony/run.json` (run metadata used by `symphony status/open/tail`)

Helper commands:

```bash
yarn cli -- status --workflow ../mdedit/WORKFLOW.md
yarn cli -- open 264 --workflow ../mdedit/WORKFLOW.md
yarn cli -- tail 264 --workflow ../mdedit/WORKFLOW.md
```

With a multi-repo config, use repo-qualified issue refs when issue numbers are ambiguous:

```bash
yarn cli -- status --config ./symphony.config.yml
yarn cli -- open mdedit#264 --config ./symphony.config.yml
yarn cli -- tail mdedit#264 --config ./symphony.config.yml
```

## When to use Symphony vs Codex app

- Use Symphony for well-scoped, reviewable work you want to run unattended (implementation, refactors, tests, docs).
- Use the Codex app for ambiguous work that benefits from interactive steering (debugging, architecture, product judgment).

## Native GitHub epics

Symphony can coordinate GitHub native sub-issues when enabled in `WORKFLOW.md`:

```yaml
tracker:
  epics:
    enabled: true
    relationship_source: native_subissues
    auto_label_children: true
    parent_mode: coordinator_only
    max_depth: 8
```

When a `ready-for-agent` issue has native sub-issues, Symphony treats it as a coordinator epic instead of an implementation issue. It does not create a parent workspace or run Codex on the parent. It adds `ready-for-agent` to eligible open leaf sub-issues, updates a parent epic status comment, and marks the parent `ready-for-human` once all descendants are terminal.

## Priority labels

Set `tracker.priority_labels` in `WORKFLOW.md` to match the target repo's actual labels. Symphony treats lower numeric values as higher priority when selecting queued work.

For `mangoappstudio/mdedit`, use `priority:p0`, `priority:p1`, `priority:p2`, and `priority:p3`. The mdedit Project board separately maps those labels into its High/Medium/Low Priority field through the repo's issue-priority sync workflow, so new agent-created issues must include exactly one `priority:p*` label.

## Notes

- `WORKFLOW.md` contains YAML front matter for config + a Markdown prompt template body.
- `symphony.config.yml` only coordinates repos. Each repo still owns its own `WORKFLOW.md`, labels, hooks, prompt, workspace root, and Codex command.
- `--workflow` is resolved by searching up parent directories when omitted, or can be passed explicitly as a relative path from the Symphony repo.
- If `tracker.token` resolves to null, Symphony will try `gh auth token` and use that token (and set `GITHUB_TOKEN` for hooks/agent subprocesses for this run).
- If a workspace exists but is missing `.git`, Symphony will clear the workspace contents and re-run `hooks.after_create` (to recover from interrupted runs).
- Hook scripts (`hooks.after_create`, `hooks.before_run`, `hooks.after_run`) are rendered as Liquid templates with `issue.*` available.
- `codex.command` is also rendered as a Liquid template with `issue.*` and `symphony.prompt_path` / `symphony.workspace_path` available.
- GitHub writes (comments, labels, PR creation) are intentionally left to the agent/toolchain (`gh`, MCP, etc.).
