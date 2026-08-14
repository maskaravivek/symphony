# Symphony

Symphony turns GitHub Issues into a queue for coding agents. It watches for eligible issues, creates an isolated workspace for each one, and runs the agent workflow defined by your repository.

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
git clone https://github.com/mangoappstudio/symphony.git
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

## Features

- **GitHub-native queue:** Selects work through issue labels, priorities, native dependencies, and native sub-issue epics.
- **Isolated execution:** Creates a dedicated workspace and durable run artifacts for each issue.
- **Repository-owned policy:** Keeps agent commands, hooks, prompts, review rules, and merge policy in `WORKFLOW.md`.
- **Multiple agents:** Routes work to configured providers such as Codex or Claude Code, with per-provider concurrency and usage checks.
- **Recovery and retries:** Resumes agent threads, retries transient failures, and recovers interrupted work after a restart.
- **Review and delivery:** Can shepherd external PR feedback and apply an opt-in, deterministic autonomous merge policy.
- **Local visibility:** Provides a read-only dashboard, CLI status tools, logs, run artifacts, and a SQLite event ledger.
- **Multi-repository operation:** Runs one workflow or coordinates several repositories from a central config.

## Limitations

- Symphony is an early-stage, self-hosted tool. It is not a managed service or multi-tenant control plane, and its configuration may change.
- This implementation supports GitHub Issues, not Linear or other issue trackers.
- It is currently run from source and is not published as an npm package.
- The dashboard is for local, read-only operational visibility; project management stays in GitHub.
- Results depend on clear issues, strong repository instructions, and reliable tests. Ambiguous work still benefits from an interactive agent session.
- `WORKFLOW.md` contains executable shell commands. Those commands inherit the host and agent permissions you configure. Review the example's approval and sandbox settings before running it against a repository.
- GitHub writes, commits, pushes, and pull requests are performed by the configured agent and tools; Symphony primarily schedules work, manages lifecycle state, and records outcomes.
