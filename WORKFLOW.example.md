---
tracker:
  kind: github
  owner: mangoappstudio
  repo: mdedit
  token: $GITHUB_TOKEN
  active_states:
    - open
  terminal_states:
    - closed
  required_labels:
    - ready-for-agent
  ignored_labels:
    - blocked
    - ready-for-human
    - wontfix
  # Default ordering keeps priority labels first, then issue creation time.
  # Set to ready_for_agent_labeled_at to dispatch by when ready-for-agent
  # was most recently applied, oldest active label first.
  candidate_order: priority_then_created_at
  epics:
    enabled: true
    relationship_source: native_subissues
    auto_label_children: true
    parent_mode: coordinator_only
    execution_mode: independent
    max_depth: 8
  priority_labels:
    "priority:p0": 1
    "priority:p1": 2
    "priority:p2": 3
    "priority:p3": 4
  # Produces flat branches like symphony-123-short-title.
  # Avoid "/" here unless you intentionally want nested Git refs.
  branch_prefix: symphony

polling:
  interval_ms: 30000

# Repository-owned autonomous merge policy. Disabled unless explicitly enabled.
merge:
  enabled: false
  dry_run: false
  require_checks: true
  method: squash
  default_risk: standard
  policy_version: example-v1
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
      any_labels: [no-automerge]
      target_branches: [production]

# Simple interval triggers: one due trigger starts one agent run. Keep product-
# specific loop prompts and skill names in the target repository.
loops:
  - id: weekly-quality
    enabled: false
    interval_ms: 604800000
    prompt: Inspect one bounded area, deduplicate findings, and create evidence-backed issues.
    provider: codex

workspace:
  root: ~/.symphony/workspaces/mdedit
  clean_on_terminal: true
  checkout:
    kind: linked_worktree
    source: . # Resolve relative to this workflow; keep the primary checkout outside workspace.root.
    base_branch: main
  storage_maintenance:
    enabled: true
    interval_ms: 86400000
    warm_pool_slots: 1
    max_pool_slots: 4
    max_cache_gib: 10
  strategy:
    implementation: pooled_isolated
    # Planning still needs repository context; the agent uses handoff_command
    # below, which runs Codex with a read-only sandbox.
    planning: durable_issue_workspace
    epic:
      stacked: durable_epic_workspace
      independent: pooled_isolated

hooks:
  after_create: |
    set -euo pipefail
    # Symphony creates and owns the linked checkout before repository hooks run.
    git rev-parse --show-toplevel >/dev/null
  before_run: |
    set -euo pipefail

    base_branch="${SYMPHONY_STACK_BASE_BRANCH:-main}"
    git fetch origin "$base_branch"

    if [ -n "$(git status --porcelain)" ]; then
      if [ "${SYMPHONY_WORKSPACE_STRATEGY:-}" = "pooled_isolated" ]; then
        echo "Found stale local changes in pooled workspace; discarding before base checkout."
      else
        echo "Found local changes in workspace; discarding before base checkout."
      fi
      git reset --hard
    fi
    git clean -fdx -e .symphony/ -e node_modules/ -e .next/ -e .turbo/ -e .gradle/ -e .kotlin/ -e .cxx/ -e .build/ -e build/ -e dist/ -e coverage/ -e DerivedData/ -e .swiftpm/ -e local.properties

    git checkout --detach "origin/$base_branch"
    git reset --hard "origin/$base_branch"

    exclude_file="$(git rev-parse --git-path info/exclude)"
    mkdir -p "$(dirname "$exclude_file")"
    touch "$exclude_file"
    grep -qxF '.symphony/' "$exclude_file" || echo '.symphony/' >> "$exclude_file"

    if ! git config user.email >/dev/null; then git config user.email "symphony@localhost"; fi
    if ! git config user.name >/dev/null; then git config user.name "Symphony"; fi

    gh auth status -h github.com

    if git ls-remote --exit-code --heads origin "{{ issue.branch_name }}" >/dev/null 2>&1; then
      git fetch origin "{{ issue.branch_name }}"
      git checkout -B "{{ issue.branch_name }}" FETCH_HEAD
    else
      git checkout -B "{{ issue.branch_name }}"
    fi

    if [ "${SYMPHONY_AGENT_MODE:-}" = "grooming" ]; then
      echo "Grooming reads repository context without installing build dependencies."
      exit 0
    fi

    # These discovery passes inspect source/GitHub/telemetry without building apps.
    # Keep QA and implementation preparation unchanged.
    case "${SYMPHONY_LOOP_ID:-}" in
      daily-steward|weekly-observability|weekly-evolve)
        echo "Read-only discovery loop: skipping build dependency installation."
        exit 0
        ;;
    esac

    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    if [ -s "$NVM_DIR/nvm.sh" ]; then
      . "$NVM_DIR/nvm.sh"
      nvm use 24
      hash -r
    fi
    unset npm_config_user_agent npm_node_execpath npm_execpath
    echo "Using node $(node -v) from $(command -v node)"
    echo "Using yarn $(yarn -v) from $(command -v yarn)"

    cache_root="${SYMPHONY_CACHE_ROOT:-$HOME/.symphony/cache/mdedit}"
    yarn_cache="$cache_root/yarn"
    mkdir -p "$yarn_cache" .symphony

    YARN_CACHE_FOLDER="$yarn_cache" node "$SYMPHONY_DEPENDENCY_HELPER" -- yarn install --frozen-lockfile --non-interactive --prefer-offline
  after_run: |
    set -euo pipefail

    base_branch="${SYMPHONY_STACK_BASE_BRANCH:-main}"
    if [ -n "$(git status --porcelain)" ] && [ "$(git rev-list --count "origin/$base_branch"..HEAD)" -eq 0 ]; then
      echo "WARNING: workspace has uncommitted changes but no commits on branch."
    fi

    echo "Symphony artifacts:"
    echo "  prompt: .symphony/prompt.md"
    echo "  codex:  .symphony/codex.jsonl"
    echo "  last:   .symphony/last_message.md"

    git status

    if [ -n "${SYMPHONY_REVIEW_PROMPT_PATH:-}" ] && [ -f "$SYMPHONY_REVIEW_PROMPT_PATH" ]; then
      echo "Review prompt: $SYMPHONY_REVIEW_PROMPT_PATH"
      echo "Review PR: ${SYMPHONY_REVIEW_PR_NUMBER:-} ${SYMPHONY_REVIEW_PR_HEAD_REF:-}@${SYMPHONY_REVIEW_PR_HEAD_SHA:-unknown}"
      echo "Run your review agent with this prompt and print exactly one SYMPHONY_REVIEW_RESULT JSON payload."
    fi
  timeout_ms: 120000

review:
  enabled: true
  auto_fix_review_comments: false
  number_of_auto_fix_iterations: 1
  shepherd_pull_requests: false
  max_feedback_rounds: 5
  non_blocking_feedback_priorities: [p2, p3]
  lenses: [staff-engineer, security-and-data-safety]

agent:
  max_concurrent_agents: 2
  max_retry_backoff_ms: 300000
  max_concurrent_agents_by_state:
    open: 2

agents:
  default: codex
  providers:
    codex:
      provider_group: codex
      provider_kind: codex
      command: bash -lc 'set -o pipefail; codex exec --json --dangerously-bypass-approvals-and-sandbox -C . --output-last-message .symphony/last_message.md - < "{{ symphony.prompt_path }}" | tee .symphony/codex.jsonl'
      resume_command: bash -lc 'set -o pipefail; codex exec resume --json --dangerously-bypass-approvals-and-sandbox --output-last-message .symphony/last_message.md "{{ symphony.agent_thread_id }}" - < "{{ symphony.prompt_path }}" | tee .symphony/codex.jsonl'
      handoff_command: bash -lc 'set -o pipefail; codex exec --json -c default_permissions=symphony-readonly-network -c permissions.symphony-readonly-network.extends=:read-only -c permissions.symphony-readonly-network.network.enabled=true -c permissions.symphony-readonly-network.filesystem.:slash_tmp=write -c permissions.symphony-readonly-network.filesystem.:tmpdir=write -C . --output-last-message .symphony/last_message.md - < "{{ symphony.prompt_path }}" | tee .symphony/codex.jsonl'
      output_log: .symphony/codex.jsonl
      turn_timeout_ms: 3600000
      # Proactive quota check: Symphony runs this command before each dispatch tick.
      # Exit 0 → within limit, dispatch proceeds.
      # Exit non-zero or command failure/timeout → dispatch is skipped for this tick and re-checked next tick.
      # This avoids relying on fixed-duration backoffs when you don't know when a provider's
      # quota window resets (e.g. 5-hour or weekly limits for Codex / Claude).
      # Uses CodexBar usage snapshots directly.
      usage_limit_check_command: |
        codexbar --provider codex --format json --json-only --no-color
    claude:
      provider_group: claude
      provider_kind: claude
      command: bash -lc 'set -o pipefail; claude -p < "{{ symphony.prompt_path }}" | tee .symphony/claude.log .symphony/last_message.md'
      output_log: .symphony/claude.log
      turn_timeout_ms: 3600000
      max_concurrent: 1
      # Uses CodexBar usage snapshots directly.
      usage_limit_check_command: |
        codexbar --provider claude --format json --json-only --no-color
    claude-fable:
      provider_group: claude
      provider_kind: claude
      command: bash -lc 'set -o pipefail; claude -p --model fable < "{{ symphony.prompt_path }}" | tee .symphony/claude-fable.log .symphony/last_message.md'
      output_log: .symphony/claude-fable.log
      turn_timeout_ms: 3600000
      max_concurrent: 1
  routes:
    - provider: codex
      any_labels: [agent:codex]
    - provider: claude-fable
      any_labels: [complexity:high, complexity:critical]
      all_labels: [agent:claude]
    - provider: claude
      any_labels: [agent:claude]
    - provider: claude-fable
      any_labels: [user-experience, ui, ux, design]
      all_labels: [complexity:critical]
    - provider: claude-fable
      any_labels: [user-experience, ui, ux, design]
      all_labels: [complexity:high]
    - provider: codex
      any_labels: [complexity:tiny, task:docs, chore]
    - provider: claude
      any_labels: [user-experience, ui, ux, design]
    - provider: codex
      default: true
---

You are working on a GitHub issue for mdedit.ai.

Issue:
- Identifier: {{ issue.identifier }}
- Title: {{ issue.title }}
- URL: {{ issue.url }}
- Labels: {{ issue.labels | join: ", " }}

Priority:
- Symphony sorts queued work by `priority:p0`, `priority:p1`, `priority:p2`, then `priority:p3`.
- The mdedit Project board maps `priority:p0` and `priority:p1` to High, `priority:p2` to Medium, and `priority:p3` to Low through the repo's issue-priority sync workflow.
- Preserve priority labels unless the issue scope is clearly wrong. If you create a follow-up issue, apply exactly one `priority:p*` label using `docs/agents/issue-tracker.md` and `docs/agents/product-priorities.md`.

Description:

{{ issue.description }}

Instructions:

1. Understand the issue and inspect the repository.
   - If this issue belongs to a native sub-issue epic, check the parent epic labels for execution hints like `epic:stacked` or `epic:independent`.
2. Read the repo's agent instructions and relevant local docs before editing.
   - For QA, maturity, or follow-up issue work, read `docs/agents/product-priorities.md`, `docs/agents/issue-tracker.md`, and the relevant QA/stewardship docs.
3. Make the smallest safe change that solves the issue.
4. Add or update tests when behavior changes.
5. Run the strongest local checks that are practical for the touched area.
6. If you are blocked by a product, architecture, security, data-loss, cost, or irreversible decision, do not guess. End your final response with the `SYMPHONY_PAUSE` block shown below.
7. Commit changes to branch `{{ issue.branch_name }}` (already checked out).
8. Push the branch to origin.
9. Open or update a pull request:
   - PR title should match the issue title.
   {% if symphony.stack_base_branch %}
   - This issue is in a stacked epic. Open a separate PR against base branch `{{ symphony.stack_base_branch }}`.
   - Do not combine this issue with its predecessor issue.
   {% endif %}
   - PR body MUST contain `Fixes #{{ issue.number }}` so GitHub auto-closes the issue after the PR is merged.
   - PR body should be comprehensive and include:
     - What changed
     - Why this approach was chosen
     - User-visible behavior changes
     - Implementation notes and important tradeoffs
     - Tests/checks run, with exact commands
     - Screenshots or recordings for UI changes when practical
     - Risks, limitations, or follow-ups
10. Comment on the GitHub issue with:
   - Summary of changes
   - Tests/checks run
   - PR link
   - Any follow-up needed
11. Do not add, remove, or replace lifecycle labels (`ready-for-agent`, `agent-running`, `needs-info`, `ready-for-human`, `blocked`, `interactive`). Symphony owns lifecycle labels.

Pause protocol:

When you need user input before continuing, end with this exact block and do not open a PR:

```text
SYMPHONY_PAUSE
reason: <short reason>
question: <specific question for the user>
options:
- <option 1>
- <option 2>
END_SYMPHONY_PAUSE
```

Testing expectations:

- Inspect the nearest project manifest before choosing checks (`package.json`, Gradle files, Python requirements, Makefile, or equivalent).
- Prefer targeted checks for the changed area, then broaden to package/app/repo-level checks when practical.
- Run tests for behavior changes and build/type/lint checks for shared or release-sensitive changes when practical.
- If a broad check fails because of unrelated existing errors, run the narrowest meaningful check for the changed area and document the unrelated failure clearly.
- Do not claim a check passed unless it was actually run. If a check is skipped, explain why in both the PR body and issue comment.

Expected tooling (use `gh` CLI):
- Create PR with a comprehensive body, including `Fixes #{{ issue.number }}`.
- Minimal PR body shape:
  ```markdown
  Fixes #{{ issue.number }}

  ## Summary
  - ...

  ## Why
  - ...

  ## Implementation Notes
  - ...

  ## Tests
  - ...

  ## Risks / Follow-ups
  - ...
  ```
- Comment issue: `gh issue comment {{ issue.number }} --body "PR: <link>\n\nSummary:\n- ...\n\nTests:\n- ...\n\nFollow-ups:\n- ..."`

Failure mode:
- If you cannot create/push a PR (auth, permissions, CI, etc.), comment on the issue with the blocking reason. Do not change lifecycle labels; Symphony will update or retry based on run state.

Do not close the issue unless the workflow explicitly says to.
