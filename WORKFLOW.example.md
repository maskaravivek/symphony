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
  method: squash
  default_risk: standard
  rules:
    - risk: elevated
      any_labels: [security]
      paths: [.github/workflows/**, WORKFLOW.md, migrations/**]
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
  clean_on_terminal: false
  strategy:
    implementation: pooled_isolated
    planning: none_or_readonly
    epic:
      stacked: durable_epic_workspace
      independent: pooled_isolated

hooks:
  after_create: |
    set -euo pipefail

    cache_root="${SYMPHONY_CACHE_ROOT:-$HOME/.symphony/cache/mdedit}"
    mirror="$cache_root/repo.git"
    mirror_lock="$cache_root/repo.git.lock"
    mkdir -p "$cache_root"

    until mkdir "$mirror_lock" 2>/dev/null; do
      echo "Waiting for shared Git cache lock: $mirror_lock"
      sleep 2
    done
    trap 'rmdir "$mirror_lock" 2>/dev/null || true' EXIT

    if [ -d "$mirror" ]; then
      git -C "$mirror" remote update --prune
    else
      git clone --mirror git@github.com:mangoappstudio/mdedit.git "$mirror"
    fi

    rmdir "$mirror_lock"
    trap - EXIT

    git clone --reference-if-able "$mirror" git@github.com:mangoappstudio/mdedit.git .
    mkdir -p .git/info
    touch .git/info/exclude
    grep -qxF '.symphony/' .git/info/exclude || echo '.symphony/' >> .git/info/exclude
  before_run: |
    set -euo pipefail

    git fetch origin
    base_branch="${SYMPHONY_STACK_BASE_BRANCH:-main}"
    git checkout -B "$base_branch" "origin/$base_branch"
    git reset --hard "origin/$base_branch"
    git clean -fdx -e .symphony/ -e node_modules/

    mkdir -p .git/info
    touch .git/info/exclude
    grep -qxF '.symphony/' .git/info/exclude || echo '.symphony/' >> .git/info/exclude

    if ! git config user.email >/dev/null; then git config user.email "symphony@localhost"; fi
    if ! git config user.name >/dev/null; then git config user.name "Symphony"; fi

    gh auth status -h github.com

    git checkout -B "{{ issue.branch_name }}"

    cache_root="${SYMPHONY_CACHE_ROOT:-$HOME/.symphony/cache/mdedit}"
    yarn_cache="$cache_root/yarn"
    mkdir -p "$yarn_cache" .symphony

    lock_hash="$(shasum -a 256 yarn.lock | awk '{print $1}')"
    install_stamp=".symphony/yarn-install-$lock_hash.stamp"
    node_modules_cache="$cache_root/node_modules/$lock_hash"

    if [ ! -d node_modules ] && [ -d "$node_modules_cache/node_modules" ]; then
      echo "Seeding node_modules from $node_modules_cache"
      cp -R "$node_modules_cache/node_modules" node_modules
      touch "$install_stamp"
    fi

    if [ -d node_modules ] && [ -f "$install_stamp" ]; then
      echo "Skipping yarn install; yarn.lock hash is unchanged ($lock_hash)."
    else
      YARN_CACHE_FOLDER="$yarn_cache" yarn install --frozen-lockfile --non-interactive --prefer-offline
      rm -f .symphony/yarn-install-*.stamp
      touch "$install_stamp"
    fi

    if [ -d node_modules ] && [ ! -d "$node_modules_cache/node_modules" ]; then
      mkdir -p "$(dirname "$node_modules_cache")"
      node_modules_lock="$node_modules_cache.lock"
      if mkdir "$node_modules_lock" 2>/dev/null; then
        if [ ! -d "$node_modules_cache/node_modules" ]; then
          tmp_cache="$node_modules_cache.tmp.$$"
          rm -rf "$tmp_cache"
          mkdir -p "$tmp_cache"
          cp -R node_modules "$tmp_cache/node_modules"
          mv "$tmp_cache" "$node_modules_cache"
        fi
        rmdir "$node_modules_lock"
      fi
    fi
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
      echo "Run your review agent with this prompt and print a final REVIEW_VERDICT: PASS or REVIEW_VERDICT: BLOCK line."
    fi
  timeout_ms: 120000

review:
  auto_fix_review_comments: false
  number_of_auto_fix_iterations: 1

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
      handoff_command: bash -lc 'set -o pipefail; codex exec --json -s read-only -C . --output-last-message .symphony/last_message.md - < "{{ symphony.prompt_path }}" | tee .symphony/codex.jsonl'
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
    codex-spark:
      provider_group: codex
      provider_kind: codex
      command: bash -lc 'set -o pipefail; codex exec --model gpt-5.3-codex-spark --json --dangerously-bypass-approvals-and-sandbox -C . --output-last-message .symphony/last_message.md - < "{{ symphony.prompt_path }}" | tee .symphony/codex-spark.jsonl'
      resume_command: bash -lc 'set -o pipefail; codex exec resume --json --dangerously-bypass-approvals-and-sandbox --output-last-message .symphony/last_message.md "{{ symphony.agent_thread_id }}" - < "{{ symphony.prompt_path }}" | tee .symphony/codex-spark.jsonl'
      handoff_command: bash -lc 'set -o pipefail; codex exec --model gpt-5.3-codex-spark --json -s read-only -C . --output-last-message .symphony/last_message.md - < "{{ symphony.prompt_path }}" | tee .symphony/codex-spark.jsonl'
      output_log: .symphony/codex-spark.jsonl
      turn_timeout_ms: 3600000
      extract_codex_thread_id: true
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
   - This issue is in a stacked epic. Open a separate PR against base branch `{{ symphony.stack_base_branch }}`, not `main`.
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
