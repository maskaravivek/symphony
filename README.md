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

### 3. Validate the setup

Create the lifecycle labels referenced by your workflow, authenticate GitHub, and run the built-in checks:

```bash
gh auth status
yarn cli doctor --workflow ../your-repo/WORKFLOW.md
```

`doctor` checks the workflow, required tools, GitHub labels, workspace storage, and agent configuration.

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

## Features

- **GitHub-native queue:** Selects work through issue labels, priorities, native dependencies, and native sub-issue epics.
- **Isolated execution:** Creates a dedicated workspace and durable run artifacts for each issue.
- **Repository-owned policy:** Keeps agent commands, hooks, prompts, review rules, and merge policy in `WORKFLOW.md`.
- **Multiple agents:** Routes work to configured providers such as Codex or Claude Code, with per-provider concurrency and usage checks.
- **Recovery and retries:** Resumes agent threads, retries transient failures, and recovers interrupted work after a restart.
- **Review and delivery:** Can shepherd external PR feedback and apply an opt-in, deterministic autonomous merge policy.
- **Local visibility:** Provides a read-only dashboard, CLI status tools, logs, run artifacts, and a SQLite event ledger.
- **Multi-repository operation:** Runs one workflow or coordinates several repositories from a central config.

For private Telegram questions, replies, and outcome notifications alongside your existing orchestrator, see the optional [Telegram bridge setup](docs/telegram.md).

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
