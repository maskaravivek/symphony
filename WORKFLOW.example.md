---
tracker:
  kind: github
  owner: maskaravivek
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
  epics:
    enabled: true
    relationship_source: native_subissues
    auto_label_children: true
    parent_mode: coordinator_only
    max_depth: 8
  priority_labels:
    "priority: urgent": 1
    "priority: high": 2
    "priority: medium": 3
    "priority: low": 4
  branch_prefix: symphony

polling:
  interval_ms: 30000

workspace:
  root: ~/.symphony/workspaces/mdedit
  clean_on_terminal: false

hooks:
  after_create: |
    set -euo pipefail
    git clone git@github.com:maskaravivek/mdedit.git .
    mkdir -p .git/info
    touch .git/info/exclude
    grep -qxF '.symphony/' .git/info/exclude || echo '.symphony/' >> .git/info/exclude
  before_run: |
    set -euo pipefail

    git fetch origin
    git checkout main
    git reset --hard origin/main
    git clean -fdx -e .symphony/

    mkdir -p .git/info
    touch .git/info/exclude
    grep -qxF '.symphony/' .git/info/exclude || echo '.symphony/' >> .git/info/exclude

    if ! git config user.email >/dev/null; then git config user.email "symphony@localhost"; fi
    if ! git config user.name >/dev/null; then git config user.name "Symphony"; fi

    gh auth status -h github.com

    git checkout -B "{{ issue.branch_name }}"

    yarn install
  after_run: |
    set -euo pipefail

    if [ -n "$(git status --porcelain)" ] && [ "$(git rev-list --count origin/main..HEAD)" -eq 0 ]; then
      echo "WARNING: workspace has uncommitted changes but no commits on branch."
    fi

    echo "Symphony artifacts:"
    echo "  prompt: .symphony/prompt.md"
    echo "  codex:  .symphony/codex.jsonl"
    echo "  last:   .symphony/last_message.md"

    git status
  timeout_ms: 120000

agent:
  max_concurrent_agents: 2
  max_retry_backoff_ms: 300000
  max_concurrent_agents_by_state:
    open: 2

codex:
  command: bash -lc 'set -o pipefail; codex exec --json --dangerously-bypass-approvals-and-sandbox -C . --output-last-message .symphony/last_message.md - < "{{ symphony.prompt_path }}" | tee .symphony/codex.jsonl'
  turn_timeout_ms: 3600000
---

You are working on a GitHub issue for mdedit.ai.

Issue:
- Identifier: {{ issue.identifier }}
- Title: {{ issue.title }}
- URL: {{ issue.url }}
- Labels: {{ issue.labels | join: ", " }}

Description:

{{ issue.description }}

Instructions:

1. Understand the issue and inspect the repository.
2. Read the repo's agent instructions and relevant local docs before editing.
3. Make the smallest safe change that solves the issue.
4. Add or update tests when behavior changes.
5. Run the strongest local checks that are practical for the touched area.
6. If you are blocked by a product, architecture, security, data-loss, cost, or irreversible decision, do not guess. End your final response with the `SYMPHONY_PAUSE` block shown below.
7. Commit changes to branch `{{ issue.branch_name }}` (already checked out).
8. Push the branch to origin.
9. Open or update a pull request:
   - PR title should match the issue title.
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
