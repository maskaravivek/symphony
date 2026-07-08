# Symphony (MVP)

Symphony is a long-running service that polls GitHub Issues (by label), creates an isolated per-issue workspace, and runs a configured coding-agent command inside that workspace.

## Run

From repo root (or any directory that contains `WORKFLOW.md`):

```bash
yarn dev
```

Before you run Symphony, make sure `codexbar` is installed and on `PATH` (the mdedit workflow checks usage via `codexbar`):

```bash
codexbar --version
```

You can install it from the CodexBar app (`Preferences → Advanced → Install CLI`) or with Homebrew:

```bash
brew install steipete/tap/codexbar
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
- `.symphony/codex.jsonl` or `.symphony/claude.log` (configured agent output; tail this)
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
    execution_mode: independent
    max_depth: 8
```

When a `ready-for-agent` issue has native sub-issues, Symphony treats it as a coordinator epic instead of an implementation issue. It does not create a parent workspace or run Codex on the parent. It adds `ready-for-agent` to eligible open leaf sub-issues, updates a parent epic status comment, and marks the parent `ready-for-human` once all descendants are terminal.

`execution_mode: independent` keeps the current behavior: each eligible leaf issue runs as its own branch and PR from the repo's normal base branch. `execution_mode: stacked` runs same-repo leaf issues one at a time in native sub-issue order, passes the predecessor branch/thread into the workflow, and is intended for separate stacked PRs rather than one shared PR.

The workflow value is only the default. A parent epic can override it with labels:

- `epic:stacked`: force stacked execution for that epic
- `epic:independent`: force independent execution for that epic

Only the parent epic label is consulted; child labels do not change execution mode.

## Priority labels

Set `tracker.priority_labels` in `WORKFLOW.md` to match the target repo's actual labels. Symphony treats lower numeric values as higher priority when selecting queued work.

For `mangoappstudio/mdedit`, use `priority:p0`, `priority:p1`, `priority:p2`, and `priority:p3`. The mdedit Project board separately maps those labels into its High/Medium/Low Priority field through the repo's issue-priority sync workflow, so new agent-created issues must include exactly one `priority:p*` label.

## Candidate ordering

By default, Symphony orders `ready-for-agent` candidates by priority label and then issue creation time:

```yaml
tracker:
  candidate_order: priority_then_created_at
```

Repos can opt into queue-order dispatch based on when `ready-for-agent` was most recently applied:

```yaml
tracker:
  candidate_order: ready_for_agent_labeled_at
```

In `ready_for_agent_labeled_at` mode, Symphony ignores priority labels for candidate ordering and picks the oldest active `ready-for-agent` label first. If `ready-for-agent` is removed and later re-added, the re-add time becomes the new queue position.

## Agent routing

Symphony can route issues to different CLI agents by GitHub labels. `agents.default` handles ordinary work, while ordered `agents.routes` can send scarce or specialized work to another provider:

```yaml
agents:
  default: codex
  providers:
    codex:
      provider_group: codex
      provider_kind: codex
      command: bash -lc 'codex exec --json -C . --output-last-message .symphony/last_message.md - < "{{ symphony.prompt_path }}" | tee .symphony/codex.jsonl'
      resume_command: bash -lc 'codex exec resume --json --output-last-message .symphony/last_message.md "{{ symphony.agent_thread_id }}" - < "{{ symphony.prompt_path }}" | tee .symphony/codex.jsonl'
      handoff_command: bash -lc 'codex exec --json -s read-only -C . --output-last-message .symphony/last_message.md - < "{{ symphony.prompt_path }}" | tee .symphony/codex.jsonl'
      output_log: .symphony/codex.jsonl
    codex-spark:
      provider_group: codex
      provider_kind: codex
      command: bash -lc 'codex exec --model gpt-5.3-codex-spark --json -C . --output-last-message .symphony/last_message.md - < "{{ symphony.prompt_path }}" | tee .symphony/codex-spark.jsonl'
      resume_command: bash -lc 'codex exec resume --json --output-last-message .symphony/last_message.md "{{ symphony.agent_thread_id }}" - < "{{ symphony.prompt_path }}" | tee .symphony/codex-spark.jsonl'
      handoff_command: bash -lc 'codex exec --model gpt-5.3-codex-spark --json -s read-only -C . --output-last-message .symphony/last_message.md - < "{{ symphony.prompt_path }}" | tee .symphony/codex-spark.jsonl'
      output_log: .symphony/codex-spark.jsonl
      extract_codex_thread_id: true
    claude:
      provider_group: claude
      provider_kind: claude
      command: bash -lc 'claude -p < "{{ symphony.prompt_path }}" | tee .symphony/claude.log .symphony/last_message.md'
      output_log: .symphony/claude.log
      max_concurrent: 1
    claude-fable:
      provider_group: claude
      provider_kind: claude
      command: bash -lc 'claude -p --model fable < "{{ symphony.prompt_path }}" | tee .symphony/claude-fable.log .symphony/last_message.md'
      output_log: .symphony/claude-fable.log
      max_concurrent: 1
  routes:
    - provider: claude-fable
      any_labels: [agent:claude, user-experience, ui, ux, design]
      all_labels: [complexity:critical]
      none_labels: [agent:codex]
    - provider: claude-fable
      any_labels: [agent:claude, user-experience, ui, ux, design]
      all_labels: [complexity:high]
      none_labels: [agent:codex]
    - provider: codex-spark
      any_labels: [complexity:tiny, task:docs, chore]
    - provider: claude
      any_labels: [agent:claude, user-experience, ui, ux, design]
      none_labels: [agent:codex, complexity:tiny, complexity:low, complexity:medium, complexity:high, complexity:critical]
    - provider: codex
      default: true
```

Routes are evaluated in order. A route can use `any_labels`, `all_labels`, `none_labels`, and `default`. The example above sends high/critical UX work to Fable, tiny/docs/chore work to Codex Spark, UX work without a complexity label to default Claude, and everything else to default Codex. Providers with the same `provider_group` share `max_concurrent`, proactive usage checks, and usage-limit backoff; `provider_kind: codex` marks Codex-compatible providers that support thread extraction and resume instructions.

Issues labeled `task:spec` or `planning` run in planning-only mode regardless of provider route. Symphony uses the provider's `handoff_command` when available, appends spec-writing instructions to the prompt, posts the captured final message back to the issue as a technical specification comment, skips `after_run` PR validation, and marks the issue `ready-for-human` without expecting a branch or pull request.

## Notes

- `WORKFLOW.md` contains YAML front matter for config + a Markdown prompt template body.
- `symphony.config.yml` only coordinates repos. Each repo still owns its own `WORKFLOW.md`, labels, hooks, prompt, workspace root, and agent commands.
- `--workflow` is resolved by searching up parent directories when omitted, or can be passed explicitly as a relative path from the Symphony repo.
- If `tracker.token` resolves to null, Symphony will try `gh auth token` and use that token (and set `GITHUB_TOKEN` for hooks/agent subprocesses for this run).
- GitHub API rate-limit responses pause repo polling until GitHub's reset/retry window instead of continuing to fan out failed issue fetches.
- `usage_limit_check_command` is optional and provider-specific: exit `0` allows dispatch, exit `1` blocks dispatch for that provider group, and exit `2` means "unknown" so Symphony logs the check result but does not block.
- `codexbar` commands are supported directly at runtime: when a check command invokes `codexbar` with `--provider` and `--format json`, Symphony parses usage percentages and blocks when any active window is at or above 90% used.
- `workspace.strategy` is optional and defaults to today's durable per-issue workspace behavior. Supported strategies are `durable_issue_workspace`, `pooled_isolated`, `none_or_readonly`, and `durable_epic_workspace`; hooks and agent commands receive the selected value as `symphony.workspace_strategy` / `SYMPHONY_WORKSPACE_STRATEGY`.
- Each workflow workspace root has a single-runner lock at `.symphony/orchestrator.lock`; a second Symphony process for the same repo skips dispatch while the live owner is running. Live orphaned workers discovered after a restart count against concurrency until they finish.
- If a workspace exists but is missing `.git`, Symphony will clear the workspace contents and re-run `hooks.after_create` (to recover from interrupted runs).
- Hook scripts (`hooks.after_create`, `hooks.before_run`, `hooks.after_run`) are rendered as Liquid templates with `issue.*` available.
- Agent commands are rendered as Liquid templates with `issue.*` and `symphony.prompt_path` / `symphony.workspace_path` / `symphony.agent_provider` / `symphony.agent_thread_id` available.
- Legacy `codex.command` workflows still work; Symphony converts them into a default `codex` provider internally.
- GitHub writes (comments, labels, PR creation) are intentionally left to the agent/toolchain (`gh`, MCP, etc.).
