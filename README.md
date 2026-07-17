# Symphony (MVP)

Symphony is a long-running service that polls GitHub Issues (by label), creates an isolated per-issue workspace, and runs a configured coding-agent command inside that workspace.

## Run

Symphony requires Node.js 22.5 or newer; the durable local episode ledger uses Node's built-in SQLite API.

From repo root (or any directory that contains `WORKFLOW.md`):

```bash
yarn dev
```

In development, `yarn dev` starts the orchestrator, starts the readonly local dashboard, and opens the dashboard in your default browser. By default it uses `./symphony.config.yml`; pass `run` args to override the target, for example:

```bash
yarn dev run --workflow ../mdedit/WORKFLOW.md
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

Each dispatch also gets an immutable `.symphony/runs/<timestamp>-<attempt>-<session-id>/` directory containing its manifest, prompt, stdout/stderr, final message, review artifacts, verification snapshot, and hook log. Symphony retains 30 days and at most 50 sessions per active work item.

It also keeps an append-only local event ledger at `<workspace.root>/.symphony/episodes.sqlite`. The ledger stores structured run, verification, loop-trigger, and merge outcome metadata; large prompts and agent output remain file artifacts referenced by path.

Workflow events distinguish agent execution from orchestration finalization: `workflow.started`, `agent.started`, `agent.completed`/`agent.failed`, `workflow.finalizing`, and one terminal or retry workflow event. Historical `run.*` rows remain readable but are no longer emitted. The same database stores durable retries, review claims, and merge-assessment state.

Helper commands:

```bash
yarn cli -- status --workflow ../mdedit/WORKFLOW.md
yarn cli -- open 264 --workflow ../mdedit/WORKFLOW.md
yarn cli -- tail 264 --workflow ../mdedit/WORKFLOW.md
yarn cli -- history 264 --workflow ../mdedit/WORKFLOW.md
yarn cli -- dashboard --workflow ../mdedit/WORKFLOW.md
```

With a multi-repo config, use repo-qualified issue refs when issue numbers are ambiguous:

```bash
yarn cli -- status --config ./symphony.config.yml
yarn cli -- open mdedit#264 --config ./symphony.config.yml
yarn cli -- tail mdedit#264 --config ./symphony.config.yml
yarn cli -- dashboard --config ./symphony.config.yml
```

The dashboard is a local readonly Kanban view backed by the same `.symphony/run.json` and epic state files as the CLI helpers, with readonly GitHub refreshes layered on top when available so closed or merged work does not linger in active review columns. By default it binds to `127.0.0.1:3766` and auto-picks the next available port when needed.

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

## Post-Run PR Review

When `review.enabled` is true and an autonomous run produces a PR, Symphony writes a staff-engineer review prompt to `.symphony/review_prompt.md` and exposes it to `hooks.after_run` as `SYMPHONY_REVIEW_PROMPT_PATH` plus PR metadata such as `SYMPHONY_REVIEW_PR_NUMBER`, `SYMPHONY_REVIEW_PR_HEAD_REF`, and `SYMPHONY_REVIEW_PR_HEAD_SHA`. `SYMPHONY_REVIEW_ENABLED` is always set to `1` or `0`, so repository hooks can retain their review implementation while skipping it when disabled. The prompt asks the review agent to prefer `/code-review` when the target repo has that skill installed, and to fall back to a manual review otherwise.

Review hooks should emit a one-line `SYMPHONY_REVIEW_RESULT` JSON object and end with `REVIEW_VERDICT: PASS`, `BLOCK`, or `RETRY`. Findings are classified as `actionable`, `nit`, or `ambiguous`: actionable blockers can enter the bounded auto-fix loop, nits do not block, and ambiguous decisions go directly to human review. `RETRY` represents a transient reviewer or environment failure rather than a code defect.

Hooks can also emit `SYMPHONY_REVIEWER` and `SYMPHONY_VERIFICATION_EVIDENCE` one-line JSON objects. Receipts record reviewer execution/provider/model/lens, policy version, and typed evidence such as `test`, `integration`, `browser-observation`, or `migration-dry-run`. Every receipt is bound to both the PR head SHA and base SHA.

`review.lenses` provides a small ordered set of repository-owned review perspectives. Fresh review executions on the same head/base cycle through the list, so an elevated PR can receive, for example, one general review and one security/data-safety review without adding a swarm engine to Symphony.

Labels are not the source of truth for whether a PR has already been reviewed. Symphony also maintains a hidden PR comment marked `symphony-review-state:v1` with verification receipts and auto-fix state. A receipt becomes stale when either the head or base changes, so new commits and stacked-PR retargeting require fresh verification.

If `review.auto_fix_review_comments` is true, blocking reviews remove `ready-for-human`, add `ready-for-agent`, and add `symphony-review:auto-fix-N` until `review.number_of_auto_fix_iterations` is exhausted. If a blocking review repeats on the same head SHA, Symphony waits for a human immediately instead of spending more iterations on a PR that did not change. Once exhausted, Symphony leaves the PR `ready-for-human` instead of reviewing or fixing the same PR forever.

`review.shepherd_pull_requests` is independent of `review.enabled`. With shepherding enabled, Symphony performs a lightweight five-minute reconciliation of its open PRs. New external inline review feedback or prioritized PR conversation comments re-queue the existing PR branch through the ordinary review-fix path, including feedback from GitHub review bots such as Codex. A configured blocking priority such as Codex `P0`/`P1` blocks; unprioritized inline review comments also block, while unprioritized PR conversation chatter is ignored. A fresh Codex thumbs-up reaction posted after the current head commit is treated as a passing external review. Feedback cursors, the observed head SHA, reaction baselines, and round counts are stored in a dedicated durable PR comment, so shepherding works even when Symphony's own reviewer is disabled and unchanged PRs stay quiet. A head change invalidates pending feedback and requires a newly observed approval reaction. The JSON is bookkeeping for deduplication and merge receipts; the external comment or reaction supplies the verdict.

`review.max_feedback_rounds` bounds repeated repair attempts for blocking external feedback. Non-blocking follow-up batches do not consume that blocking-round budget. Priorities listed in `review.non_blocking_feedback_priorities` are routed as follow-up work rather than merge blockers; the repair agent is instructed to create a linked issue instead of extending the PR. If that follow-up pass leaves the reviewed head unchanged, Symphony records the external review as passing evidence and can continue through the normal deterministic merge policy. CI interpretation and flaky-job reruns remain repository-owned rather than generic Symphony behavior.

When GitHub rejects a label write because a managed label does not exist yet, Symphony creates the missing label and retries the write. Hook output is streamed live, but Symphony only retains a bounded tail in memory for verdict parsing and error messages; override the default with `SYMPHONY_HOOK_CAPTURE_LIMIT_BYTES` if needed.

## Autonomous merge policy

Autonomous merging is repository opt-in and deterministic:

```yaml
merge:
  enabled: true
  dry_run: false
  method: squash
  default_risk: standard
  policy_version: my-repo-v1
  require_independent_reviews: true
  required_evidence:
    standard: [review]
    elevated: [review, test]
  substantive_ignored_paths: ["**/*.test.*", "**/*.md", generated/**]
  rules:
    - risk: elevated
      any_labels: [security]
      paths: [.github/workflows/**, WORKFLOW.md, migrations/**]
    - risk: elevated
      min_changed_lines: 800
      min_changed_files: 30
    - risk: prohibited
      target_branches: [production]
```

The highest matching risk wins. Rules may match labels, changed-file globs, target branches, or substantive line/file thresholds; matching rules may also add evidence requirements without raising the tier. `standard` requires one fresh passing review, `elevated` requires two, and `prohibited` never merges autonomously. With `require_independent_reviews`, reviewer execution IDs must be distinct and cannot equal the authoring execution. Changing `policy_version` invalidates older receipts, and Symphony automatically binds receipts to the SHA-256 of the complete workflow file so prompt or hook changes also require fresh verification.

A merge also requires every configured evidence kind, an open non-draft PR, a clean merge state, a linked issue, available and successful GitHub checks, no blocking/pause label, current head/base SHAs, and an expected-head-SHA merge request. `dry_run: true` evaluates and records eligibility without merging. Every assessment, including blocked decisions, is written to the episode ledger with the policy version, substantive change size, evidence, and gate reasons. Symphony does not ask an LLM to loosen deterministic merge policy.

When autonomous merge and native epics are both enabled, Symphony also promotes stacked PRs after a predecessor merges: it retargets the child to the surviving base branch, clears stale review labels, and queues fresh review. The prior receipts no longer count because the base changed.

## Scheduled loops

Loops are deliberately small interval triggers, not a workflow engine:

```yaml
loops:
  - id: weekly-quality
    enabled: true
    interval_ms: 604800000
    prompt: Inspect one bounded area and create only evidence-backed issues.
    provider: codex
```

One due trigger starts one agent run in a durable `_loops/<id>` workspace. The trigger is written to the local episode ledger before dispatch, so a restart does not immediately duplicate it. Each prompt receives a bounded newest-first episode summary; repository-specific skills, QA policy, and issue-creation rules belong in that repository's `WORKFLOW.md`. Scheduled discovery loops can create normal `ready-for-agent` issues, which then use the ordinary isolated implementation, verification, review, and merge path.

## Notes

- `WORKFLOW.md` contains YAML front matter for config + a Markdown prompt template body.
- `symphony.config.yml` only coordinates repos. Each repo still owns its own `WORKFLOW.md`, labels, hooks, prompt, workspace root, and agent commands.
- `--workflow` is resolved by searching up parent directories when omitted, or can be passed explicitly as a relative path from the Symphony repo.
- If `tracker.token` resolves to null, Symphony will try `gh auth token` and use that token (and set `GITHUB_TOKEN` for hooks/agent subprocesses for this run).
- GitHub API rate-limit responses pause repo polling until GitHub's reset/retry window instead of continuing to fan out failed issue fetches.
- `usage_limit_check_command` is optional and provider-specific: exit `0` allows dispatch, exit `1` blocks dispatch for that provider group, and exit `2` means "unknown" so Symphony logs the check result but does not block.
- `codexbar` commands are supported directly at runtime: when a check command invokes `codexbar` with `--provider` and `--format json`, Symphony parses usage percentages and blocks when any active window is at or above 90% used. A missing command, non-zero exit, or unparseable snapshot blocks that provider group instead of dispatching without quota information.
  If it can parse a `resetsAt` value for a blocked window, it uses that as a short-lived block backoff until that window resets.
- `symphony doctor` checks tools referenced inside shell-wrapped providers and hooks (including `codex`, `claude`, `codexbar`, `jq`, and package managers), verifies at least 5 GiB is free under each workspace root, confirms lifecycle labels, and exits non-zero when a required dependency is missing.
- `workspace.strategy` is optional and defaults to today's durable per-issue workspace behavior. Supported strategies are `durable_issue_workspace`, `pooled_isolated`, `none_or_readonly`, and `durable_epic_workspace`; hooks and agent commands receive the selected value as `symphony.workspace_strategy` / `SYMPHONY_WORKSPACE_STRATEGY`. Planning agents that must inspect repository files should use `durable_issue_workspace` together with a read-only `handoff_command`; `none_or_readonly` intentionally creates no checkout and is only suitable for source-independent prompts.
- Each workflow workspace root has a single-runner lock at `.symphony/orchestrator.lock`; a second Symphony process for the same repo skips dispatch while the live owner is running. After a restart, Symphony recovers orphaned `agent-running` claims from older runs by cancelling the stale worker PID when possible, clearing `agent-running`, and re-queueing the issue unless it now has an ignored label.
- `needs-info`, `interactive`, `ready-for-human`, and `blocked` are always non-queueable, including for epic auto-labeling and durable retries.
- `run` writes daily structured logs beside its controlling config under `.symphony/logs/`, with owner-only permissions, sensitive-field redaction, and 30-day retention.
- If a workspace exists but is missing `.git`, Symphony will clear the workspace contents and re-run `hooks.after_create` (to recover from interrupted runs).
- Hook scripts (`hooks.after_create`, `hooks.before_run`, `hooks.after_run`) are rendered as Liquid templates with `issue.*` available.
- Agent commands are rendered as Liquid templates with `issue.*` and `symphony.prompt_path` / `symphony.workspace_path` / `symphony.agent_provider` / `symphony.agent_thread_id` available.
- Agent commands also receive `symphony.session_id` plus `SYMPHONY_SESSION_ID`, `SYMPHONY_RUN_ARTIFACT_DIR`, `SYMPHONY_AGENT_LOG_PATH`, and `SYMPHONY_LAST_MESSAGE_PATH`. Review hooks should treat `SYMPHONY_REVIEW_PR_*` as authoritative in PR-review mode.
- Legacy `codex.command` workflows still work; Symphony converts them into a default `codex` provider internally.
- Issue and PR creation remain agent/toolchain responsibilities (`gh`, MCP, etc.); Symphony itself owns lifecycle comments/labels and policy-gated merges.

## Unattended macOS operation

Before leaving a Mac unattended, run the repository tests/build and then run the doctor against the exact multi-repo config that the service will use:

```bash
yarn install --frozen-lockfile
yarn typecheck
yarn test
yarn build
yarn cli doctor --config ./symphony.config.yml
codexbar --provider codex --format json --json-only --no-color
codexbar --provider claude --format json --json-only --no-color
gh auth status -h github.com
git ls-remote git@github.com:mangoappstudio/mdedit.git HEAD
```

Run Symphony under a supervisor rather than from an interactive terminal. [`ops/com.mangoappstudio.symphony.plist.example`](ops/com.mangoappstudio.symphony.plist.example) is a launchd template with `RunAtLoad`, `KeepAlive`, throttled restart, fixed working directory/PATH, and persistent stdout/stderr logs. Replace every `__...__` placeholder on the runner Mac, copy it to `~/Library/LaunchAgents/com.mangoappstudio.symphony.plist`, then load and inspect it:

```bash
mkdir -p "$HOME/Library/Logs/Symphony"
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.mangoappstudio.symphony.plist" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.mangoappstudio.symphony.plist"
launchctl kickstart -k "gui/$(id -u)/com.mangoappstudio.symphony"
launchctl print "gui/$(id -u)/com.mangoappstudio.symphony"
tail -F "$HOME/Library/Logs/Symphony/symphony.out.log" "$HOME/Library/Logs/Symphony/symphony.err.log"
```

Keep the runner on AC power and disable system sleep while plugged in (`pmset -g custom` should show AC sleep disabled). Verify that the checkout, Node binary, configured tools, and log paths in the plist all exist on that Mac. After startup, confirm the logs show successful polling and no repeated `usage_limit`, GitHub authentication/rate-limit, workspace-lock, or hook failures before leaving it unattended.
