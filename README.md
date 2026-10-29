# Symphony

Symphony turns GitHub Issues into a queue for coding agents. It watches for eligible issues, creates an isolated workspace for each one, and runs the agent workflow defined by your repository.

```mermaid
flowchart TB
    server["🎼 Symphony server"]
    github[("GitHub Issues")]

    server -->|"Poll"| github
    github -.->|"ready-for-agent"| server

    router{"Issue labels"}
    server ==>|"Dispatch"| router

    subgraph runs["Parallel sessions"]
        direction LR
        claude1["#101<br/>New Claude session"]
        codex1["#102<br/>New Codex session"]
        claude2["#103<br/>New Claude session"]
    end

    router -->|"ui · ux · design"| claude1
    router -->|"default"| codex1
    router -->|"user-experience"| claude2

    claude1 --> delivery["✅ Pull requests"]
    codex1 --> delivery
    claude2 --> delivery
    delivery -->|"Update"| github

    classDef server fill:#6f42c1,color:#ffffff,stroke:#4c2889,stroke-width:3px
    classDef tracker fill:#24292f,color:#ffffff,stroke:#57606a,stroke-width:2px
    classDef route fill:#fff8c5,color:#1f2328,stroke:#9a6700,stroke-width:2px
    classDef codex fill:#ddf4ff,color:#1f2328,stroke:#0969da,stroke-width:2px
    classDef claude fill:#fff1e5,color:#1f2328,stroke:#bc4c00,stroke-width:2px
    classDef result fill:#dafbe1,color:#1f2328,stroke:#1a7f37,stroke-width:2px
    class server server
    class github tracker
    class router route
    class codex1 codex
    class claude1,claude2 claude
    class delivery result
```

## Background

This project is based on OpenAI's [original Symphony specification](https://openai.com/index/open-source-codex-orchestration-symphony/), adapted to use GitHub Issues instead of Linear.

The central idea is the same: your issue tracker is the control plane, while a repository-owned `WORKFLOW.md` defines how agents work, test, and hand off changes.

## Getting started

### 1. Install the prerequisites

You need:

- Node.js 22.5 or newer
- Yarn 1.22
- Git and the [GitHub CLI](https://cli.github.com/), authenticated with access to your target repository
- At least one coding-agent CLI referenced by your workflow, such as Codex or Claude Code

Clone and install Symphony:

```bash
git clone https://github.com/maskaravivek/symphony.git
cd symphony
yarn install --frozen-lockfile
```

### 2. Add a workflow to your repository

Copy [`WORKFLOW.example.md`](WORKFLOW.example.md) into the repository you want Symphony to manage:

```bash
cp WORKFLOW.example.md ../your-repo/WORKFLOW.md
```

Edit the new `WORKFLOW.md` in your target repository. At minimum, update:

- `tracker.owner`, `tracker.repo`, labels, and authentication
- `workspace.root` and the repository clone commands in `hooks`
- the agent providers, commands, and routing you intend to use
- the Markdown prompt below the YAML front matter

The example is a full starting point, not a drop-in configuration. Remove optional providers, quota checks, review rules, and merge behavior that you do not need. Commit `WORKFLOW.md` to the target repository so its agent policy is reviewed and versioned with the code.

For repeatable onboarding, use the repository's [symphony-onboard-repo skill](.agents/skills/symphony-onboard-repo/SKILL.md). It covers workflow authoring, central registration, merge/routing/storage policy, idempotent GitHub label provisioning, doctor checks, and the existing Telegram bridge. Invoke it with `$symphony-onboard-repo` and the target repo path; it does not start agents or queue issues as an onboarding side effect.

### 3. Validate the setup

Create the lifecycle labels referenced by your workflow, authenticate GitHub, and run the built-in checks:

```bash
gh auth status
yarn cli doctor --workflow ../your-repo/WORKFLOW.md
```

`doctor` checks the workflow, required tools, GitHub lifecycle/routing/priority/planning/epic labels, workspace storage, and agent configuration. It also reports impossible or shadowed routes, misplaced default routes, and concrete cases where an explicit `agent:*` label selects another provider group.

### 4. Run Symphony

```bash
yarn dev run --workflow ../your-repo/WORKFLOW.md
```

In development mode, Symphony starts the orchestrator and opens a local read-only dashboard. Add the workflow's required label—`ready-for-agent` in the example—to a well-scoped GitHub issue to queue it.

Useful commands:

```bash
yarn cli status --workflow ../your-repo/WORKFLOW.md
yarn cli tail 123 --workflow ../your-repo/WORKFLOW.md
yarn cli history 123 --workflow ../your-repo/WORKFLOW.md
```

Replace `123` with a GitHub issue number. To run multiple repositories from one Symphony process, start with [`symphony.config.example.yml`](symphony.config.example.yml) and pass `--config` instead of `--workflow`.

For those repositories, optional primary-checkout sync keeps local workflows and other files current with remote `main`:

```yaml
repository_sync:
  enabled: true
  interval_ms: 43200000 # 12 hours
```

When enabled, Symphony runs a sync pass before polling repository agents, initially at startup and then every 12 hours. The last attempt is saved in `.symphony/repository-sync.json` beside the central config, so restarts do not reset the interval. Each enabled workflow's containing Git checkout is deduplicated and fetched from `origin/main`, then updated only by a fast-forward. Dirty or divergent checkouts, other branches, Git operations in progress, linked task worktrees, and repositories with active agents are skipped until the next scheduled pass. Local and ignored files are preserved; sync never resets, cleans, stashes, or switches branches. Outcomes are logged, and a failed repository does not block the others or normal task polling. This does not update or restart Symphony itself. New task workspaces continue fetching their base branch before each run independently of this schedule. The feature is disabled by default.

## TaskDrop intake and grooming

TaskDrop GitHub captures automatically receive `requires-grooming`; a selected `ready-for-agent` label is replaced by the intake gate. Symphony polls intake alongside its normal five-minute queue, using the default provider's read-only handoff command and shared/specialized issue planner guidance. Grooming consumes normal concurrency and usage/disk limits, inspects the repo and issue conversation, and requires structured scope, acceptance criteria, verification and evidence. Ready results require exactly one configured priority; human-attention results can omit priority and preserve existing classification. Multiple or conflicting priorities remain invalid. It preserves the raw capture and attachments and posts the enriched brief as an idempotent issue comment, so implementation receives it through normal run context. Grooming does not implement, create PRs/epics, or run the PR finalization hook.

Clear bounded work is labeled for the normal workflow, with the intake gate removed last. Existing unrelated, risk and explicit agent labels remain intact. Required user decisions use the normal pause protocol; the paired Telegram bridge sends the question, records your answer, and requeues grooming. Duplicate/large/unsupported work can be marked for human attention. The intake label blocks implementation and auto-merge even if readiness is accidentally also present; removing it manually opts out of grooming. Invalid output, stale input or operational failures do not make an issue ready, and retry limits still apply. Restarts recover durable finalization before dispatch. GitHub issues created outside TaskDrop can opt into the same pipeline by adding the intake label. Linear destinations are unchanged.

## Issue planning

Use [`$symphony-plan-issues`](.agents/skills/symphony-plan-issues/SKILL.md) to turn plans and findings into repo-aware GitHub issues or native epics. The shared skill reads the target workflow for priorities, agent routing, validation and readiness. Portable copies are installed in the seven smaller repositories; mdedit retains its specialized issue planner. The canonical shared definition lives here, and onboarding installs it for new repos without a specialized planner. Creating issues does not queue them unless execution is authorized.

## Label routing

Routes use the first matching rule. In the example workflow, explicit `agent:codex` comes first (and wins if both overrides are present). `agent:claude` selects Claude, or `claude-fable` for high/critical complexity, before any task-based rule. High/critical UX work selects `claude-fable`; tiny/docs/chore tasks use regular Codex; other UX work, including low/medium complexity, uses Claude. Everything else uses Codex. No Spark provider is configured.

All execution modes still require `ready-for-agent` and respect blocking/human-attention labels. `planning` or `task:spec` requests a planning-only run. Epic coordination uses native GitHub sub-issues; provider/complexity labels do not inherit from the parent. With `auto_label_children: false`, label each child `ready-for-agent` explicitly. Legacy aliases such as `agent-ready` do not queue work. The seven configured side projects intentionally use a single default Codex route.

## Daily storage maintenance

Symphony runs storage maintenance on the first eligible tick and every 24 hours afterward, in both single- and multi-repository mode. Each workspace root saves its completed pass in `.symphony/storage-maintenance.json`, so restarting does not reset the schedule. Maintenance holds the workflow lock and defers while the repository has active workers. It does not need GitHub to be available. No separate scheduled job is needed; Symphony must be running.

Defaults can be overridden in each repository's `WORKFLOW.md`:

```yaml
workspace:
  storage_maintenance:
    enabled: true
    interval_ms: 86400000
    min_free_gib: 20
    idle_days: 7
    retention_days: 30
    max_artifact_gib: 2
    max_pool_slots: 8
    # Optional, exclusively owned Symphony cache; never point at a primary checkout.
    cache_root: ~/.symphony/cache/my-repo
    max_cache_gib: 10
```

- Archives expire after 30 days and have a 2 GiB budget per repository. Archiving moves artifacts within the same filesystem instead of temporarily duplicating them.
- Session evidence is limited to 50 sessions and 2 GiB per workspace, across issues sharing a pool. The current/latest session is protected even if it exceeds the budget. Daily pruning covers completed, failed and cancelled runs; dispatch also prunes before starting another session. Active, paused, retrying and finalizing evidence is preserved.
- After seven idle days, completed, failed and cancelled workspaces may be reclaimed even if their issue is still open, when `clean_on_terminal` is enabled. Maintenance requires a clean checkout, no stashes or Git operation in progress, and all local branch/tag/HEAD commits reachable from remote-tracking refs. Unknown ignored files prevent removal; only `.symphony`, root dependency folders and known root build outputs are disposable. Run evidence is archived first. Linked worktrees, symlinks, invalid/missing run state and recoverable local work are preserved.
- Pool growth is capped at eight slots or configured agent concurrency, whichever is larger. Existing reserved slots above the cap can still resume. Exhaustion leaves tasks queued without spending retry attempts.
- Hook logs expire after 30 days, with 100 MiB per workspace's hook-log directory. Persistent application logs are pruned during runtime writes as dates change and rotate at 25 MiB, retaining three rotated files per day.
- An explicitly configured cache keeps at most three dependency snapshots, up to 10 GiB total, expiring after 14 days without use. Yarn v6 package entries have a separate 10 GiB / 30-day limit. Cache locks prevent cache pruning. Git mirrors are preserved because clones can reference their objects through alternates. Hooks that reuse dependency snapshots should touch their snapshot directory to record use; mdedit does this.

Before new issue/review/conflict/loop work, Symphony checks for at least 20 GiB free. Low space or an unavailable filesystem pauses dispatch while reconciliation and active jobs continue. Dispatch resumes automatically when space returns. The Telegram bridge reports pause and recovery transitions once; it reads `.symphony/storage-status.json` without changing task lifecycle labels. This guard remains enabled when periodic maintenance is disabled.

Maintenance intentionally leaves removed repositories, unknown directories, episode history, Git mirrors, shared system caches, and launchd stdout/stderr logs untouched. It does not promise a hard total disk cap: protected work and an active build can exceed retention budgets or consume the free-space reserve. Outcomes and failures are logged; the completion record includes removed workspace counts and artifact/cache bytes, excluding bytes removed with a checkout.

## Features

- **GitHub-native queue:** Selects work through issue labels, priorities, native dependencies, and native sub-issue epics.
- **Isolated execution:** Creates a dedicated workspace and durable run artifacts for each issue.
- **Repository-owned policy:** Keeps agent commands, hooks, prompts, review rules, and merge policy in `WORKFLOW.md`.
- **Multiple agents:** Routes work to configured providers such as Codex or Claude Code, with per-provider concurrency and usage checks.
- **Recovery and retries:** Resumes agent threads, retries transient failures, and recovers interrupted work after a restart.
- **Review and delivery:** Can shepherd external PR feedback and apply an opt-in, deterministic autonomous merge policy.
- **Local visibility:** Provides a read-only dashboard, CLI status tools, logs, run artifacts, and a SQLite event ledger.
- **Multi-repository operation:** Runs one workflow or coordinates several repositories from a central config.

For Telegram issue intake with text/images, private questions, replies, and outcome notifications alongside your existing orchestrator, see the optional [Telegram bridge setup](docs/telegram.md).

By default, autonomous merging requires one fresh passing review for both standard and elevated changes. With PR shepherding enabled, a fresh Codex review bot approval can supply that review even when Symphony's own post-run review is disabled. Elevated changes still require any additional verification evidence configured in the workflow. Blocking findings, human pauses, prohibited changes, and unsuccessful checks continue to prevent automatic merging.

For projects that ship without code review, set `review.enabled: false`, `review.shepherd_pull_requests: false`, and configure local validation:

```yaml
merge:
  enabled: true
  required_reviews: 0
  require_checks: false
  validation_command: |
    yarn install --frozen-lockfile
    yarn test
    yarn build
```

Use the project's actual check commands. Symphony runs them after successful PR finalization, requires a clean workspace with matching local and remote head/base commits, and records validation evidence without inventing a review approval. A failed or interrupted rerun invalidates the previous success. Eligible PRs merge on a subsequent polling cycle; pending or failing GitHub checks still block merging even when checks are optional. Paused, blocked, closed, and actively running linked issues are excluded. Recovery revalidates interrupted runs. An agent's successful exit alone is insufficient, and repositories using the default review policy are unaffected.

## Limitations

- Symphony is an early-stage, self-hosted tool. It is not a managed service or multi-tenant control plane, and its configuration may change.
- This implementation supports GitHub Issues, not Linear or other issue trackers.
- It is currently run from source and is not published as an npm package.
- The dashboard is for local, read-only operational visibility; project management stays in GitHub.
- Results depend on clear issues, strong repository instructions, and reliable tests. Ambiguous work still benefits from an interactive agent session.
- `WORKFLOW.md` contains executable shell commands. Those commands inherit the host and agent permissions you configure. Review the example's approval and sandbox settings before running it against a repository.
- GitHub writes, commits, pushes, and pull requests are performed by the configured agent and tools; Symphony primarily schedules work, manages lifecycle state, and records outcomes.

## Persistent linked workspaces

Managed repositories can use a Symphony-owned bare repository and a persistent pool of linked worktrees:

```yaml
workspace:
  root: ~/.symphony/workspaces/your-repo
  checkout:
    kind: linked_worktree
    source: .
    base_branch: main
  clean_on_terminal: true
  strategy:
    implementation: pooled_isolated
  storage_maintenance:
    enabled: true
    interval_ms: 86400000
    warm_pool_slots: 1
    max_pool_slots: 4
```

`source` resolves relative to WORKFLOW.md and must be an existing checkout outside the workspace root. Its origin supplies the remote. Symphony seeds its own bare repository locally (sharing immutable Git object files where Git supports it), fetches the remote base, and creates detached linked worktrees before repository hooks run. The primary checkout's files, branch and index are not changed. Per-task branches stay isolated in the worktrees; hooks must start from a detached base instead of trying to check out main in multiple slots. Use `git rev-parse --git-path` for Git metadata paths, because `.git` is a file in a linked worktree.

Terminal cleanup archives run artifacts and releases managed pool slots while preserving dependencies, install fingerprints, tracked configuration within `.symphony`, and generated caches. Ignored Symphony artifact files remain disposable even when tracked configuration prevents Git from listing their parent directory as wholly ignored. Slots with paused/retry/running work, uncommitted changes, unpushed commits, stashes or unknown ignored files remain protected. New slots use linked worktrees. Clean standalone clones with remotely accounted-for commits migrate on preparation, moving dependencies and artifacts without copying them. Dirty/unpublished legacy clones remain intact for recovery. Daily maintenance keeps the configured number of idle warm slots, unregisters excess slots after the idle period, and prunes stale/over-budget ignored build output. Installed dependencies in retained slots are preserved; the cache limit is not a hard cap on all dependency trees or protected work. Unknown worktrees and the shared Git repository are not automatically deleted.

Hooks, validation commands and agents receive `SYMPHONY_DEPENDENCY_HELPER`. Run `node "$SYMPHONY_DEPENDENCY_HELPER" -- npm ci` or `node "$SYMPHONY_DEPENDENCY_HELPER" -- yarn install --frozen-lockfile --non-interactive --prefer-offline`. The helper fingerprints manifests, lockfiles, package-manager configuration, repository install scripts, install arguments, Node/package-manager versions, platform and architecture. It reuses an installation only when the fingerprint and package-manager integrity marker match. Failed installs invalidate the stamp. `SYMPHONY_FORCE_INSTALL=1` forces a reinstall. Each concurrent slot owns its mutable dependencies; no node_modules symlink is shared between agents. Preserve dependencies/caches in checkout hooks, and never clean unknown user files to obtain a free slot.

Regular issue setup and scheduled-loop setup reserve their global/repository/provider capacity immediately, then prepare in the background. A slow checkout or install does not block polling other repositories. Status shows `preparing` until the agent starts. Coordinator-owned preparation leases live outside the checkout, protecting pooled slots and cleanup without breaking clone hooks. When a task branch is still attached to another owned, clean idle slot, preparation detaches that slot at its existing commit before checkout. Active, paused, retrying and protected work remains untouched. Cancelling setup terminates its hook process group; interrupted setup retries the preparation phase without spending an agent attempt.

For installed Yarn Classic 1.22.x (including 1.22.19 and 1.22.22), the dependency helper creates a verified Symphony-local runner that replaces the quadratic front-removal file-copy queue with an indexed queue. Global Yarn and Corepack packages are left unchanged, and normal lifecycle scripts, lockfile checks and dependency validation still run. Other Yarn versions use their normal runner. A complete first install is still required for each cold slot; subsequent matching installs reuse the validated dependencies.


Codex handoff/grooming commands use an explicit `symphony-readonly-network` permission profile (Codex CLI 0.165.0 or newer): project files are read-only, public network access is enabled for GitHub and attachments, and only system temporary directories are writable for downloaded context. Legacy `-s read-only` also disables networking and prevents these investigations; do not combine that flag with the profile. This profile is passed per command. When the global Codex configuration still uses `sandbox_mode`, migrate that key to the equivalent `default_permissions` built-in first; legacy sandbox settings override permission profiles. For example, `sandbox_mode = "danger-full-access"` becomes `default_permissions = ":danger-full-access"`, preserving the global access level.


Hooks and workers receive `SYMPHONY_NODE_EXECUTABLE`, defaulting to the Node executable running Symphony. Run the service with the intended supported LTS version. The dependency helper re-executes under that exact executable before version checks or fingerprinting, then prepends a Node-only shim directory so install/lifecycle scripts inherit it without replacing the repo's package-manager executable. A login shell selecting another Node therefore cannot silently change install behavior. Worker prompts also instruct build/test shells to select that executable explicitly. Installed Yarn 1.22.x versions retain their pinned version and use the optimized queue only after source-shape verification; other release lines use their normal runner.


Setup failures (checkout, dependency installation and preparation hooks) use durable retries with a separate consecutive-failure backoff counter; they do not consume coding-agent attempts. Resource deferrals and shutdowns also preserve the attempt. A corrected environment is retried automatically; setup failures never queue implementation before setup succeeds. Normal agent failures still honor `agent.max_attempts`. Setup status is posted on the issue, and Telegram sends one blockage alert plus one recovery alert when the coding agent starts.

Warm-slot reuse recognizes ignored OpenNext, Playwright/test output and Yarn error logs as generated artifacts. Daily cache retention/budget pruning covers these outputs while preserving dependencies. Modified tracked `.symphony/verification.json` is releasable only for a terminal run when its bytes match the session's archived verification snapshot and its head SHA matches the checkout. The evidence is archived and the tracked original restored. Staged changes, other source edits, unarchived evidence, stashes, unpublished commits and unknown ignored files remain protected.
