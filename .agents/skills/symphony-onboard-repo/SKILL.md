---
name: symphony-onboard-repo
description: Onboard a GitHub repository into the local Symphony orchestrator, or reconcile an existing onboarding, including WORKFLOW.md, repository registration, labels, routing, validated merge policy, storage retention, and Telegram visibility. Use when asked to add or configure a repository for Symphony.
---

# Symphony repository onboarding

Complete onboarding in one pass and verify the resulting setup. Re-running this skill should reconcile gaps without creating duplicate registrations or rewriting unrelated policy.

## Find the installations and preserve work

- Locate the Symphony source checkout and the target repo from the user's paths, existing central config, or nearby checkouts. On Utkarsha's Mac the usual Symphony checkout is `~/Documents/Projects/symphony`; treat that as a discovery hint, not a required path. The bundled script also accepts `--symphony-root`.
- Read target `AGENTS.md`, existing `WORKFLOW.md`, package/build manifests, and relevant CI. Inspect Git status and remotes before modifying anything. Verify the GitHub owner/name and default branch instead of guessing from the folder name. Adapt task hooks to that branch; the current background primary-checkout sync only supports main, so report that limitation for other default branches rather than renaming branches implicitly.
- Preserve dirty files, stashes, branches and unpushed commits. Clone a missing checkout without replacing an existing directory. Do not stash, reset, switch branches, or pull over local work unless the user authorized that action.
- Find both the running central config and its tracked source, when present. In this installation, Symphony's root `symphony.config.yml` is ignored; mdedit's tracked `symphony.config.yml` is its portable counterpart. Resolve workflow paths relative to each config's own directory.

## Choose the policy and author the workflow

Read [references/policies.md](references/policies.md) for this installation's established profiles and retention settings. Follow explicit user choices and existing repo policy. For a new small side project, use the established Codex-only, locally validated auto-merge profile; do not copy mdedit's review gate or multi-provider routing into it.

Use a similar configured side project's workflow as a structural starting point, or Symphony's `WORKFLOW.example.md` when advanced routing/review is actually wanted. Inspect and adapt the contents; neither is a drop-in template.

Ensure `WORKFLOW.md` covers:

- Correct tracker repo, readiness/pause labels, priority vocabulary, native epic behavior and five-minute polling.
- A unique Symphony workspace root, cleanup enabled, appropriate pooled/durable strategies, daily maintenance, and a finite retry budget.
- Clone/setup hooks confined to disposable task workspaces. Never run the workflow's destructive checkout hooks in the user's primary checkout while onboarding. Preserve `.symphony/`; preserve dependencies only when the install strategy validates their lockfile stamp.
- Available provider executables, session-specific `$SYMPHONY_LAST_MESSAGE_PATH`, read-only planning/handoff commands, and sensible timeouts. Do not configure Codex Spark. Do not copy a model alias or quota-check tool without checking that the installation supports it.
- Repository-specific validation derived from real scripts and CI. Include relevant lint/type/build/tests and docs-only handling when appropriate. Never invent a check, weaken validation to get a pass, or use deployment, paid calls, migrations, or production mutations as validation.
- A prompt and after-run behavior that honor `SYMPHONY_PAUSE`, planning-only output, PR finalization, and the selected review/merge policy. Planning and human pauses must not require a PR.

Register the repo once in the runtime config and tracked counterpart. Preserve global concurrency and unrelated entries; side-project concurrency is normally one. Preserve the existing twelve-hour primary-repository sync setting.

## Install issue-planning guidance

For a repo without a specialized issue planner, copy the current sibling `symphony-plan-issues` skill from Symphony's `.agents/skills/` into the target repo's `.agents/skills/symphony-plan-issues/`, including its UI metadata and references. Commit portable files, not a symlink to a sibling checkout. If the destination already exists, compare it with the canonical copy and reconcile deliberate local customizations instead of overwriting them blindly. Keep one canonical shared definition in Symphony and propagate shared updates consistently. Preserve mdedit's specialized `mdedit-issue-planner` rather than adding a competing planner there. Verify the copied skill reads the target repo's workflow and does not embed another repo's owner, review gate, or routing assumptions.

## Provision labels from the actual workflow

Use Symphony's normalized config and doctor helpers rather than maintaining a hand-written label list. The bundled helper previews missing labels by default:

```bash
node /absolute/path/to/this-skill/scripts/ensure-labels.mjs \
  --symphony-root /absolute/path/to/symphony \
  --workflow /absolute/path/to/new-repo/WORKFLOW.md
```

For authorized onboarding, add `--apply` to create missing labels. This preserves existing labels and issue assignments. `--config /absolute/path/to/symphony.config.yml` can replace `--workflow` to reconcile all enabled repositories. The helper checks routing before any writes and is safe to rerun after a partial failure; it never deletes or edits labels.

A request to onboard/configure the repo authorizes its normal workflow/config edits and missing label creation. A request merely to audit or preview does not authorize those mutations. Do not create sample issues, label existing work `ready-for-agent`, start coding agents, relax branch protection, merge PRs, or deploy as a side effect of onboarding. Commit and push only when requested; an existing explicit request remains authorization.

## Verify and finish

- Run `npm run cli -- doctor --workflow /absolute/path/to/new-repo/WORKFLOW.md` from the Symphony checkout, then `npm run cli -- doctor --config /absolute/path/to/runtime-config.yml`. Confirm config paths work from their actual locations. Report unrelated existing doctor failures separately.
- Re-run the helper without `--apply`; it should report no missing labels. Check route examples through `src/agents/routing.ts` when adding advanced routes: explicit overrides, tiny/docs/chore, low/medium UX, high/critical UX, and fallback. Route order is first-match; implicit provider/complexity inheritance from epic parents does not exist.
- Validate real target commands without running hooks that reset the primary checkout. Use an isolated validation workspace if executing them would alter existing user work. Run Symphony tests/typecheck/build only if its runtime code changed; policy-only onboarding needs config/label validation and the relevant target checks.
- The existing Telegram bridge uses the central config. Check whether it is installed/running and restart the existing bridge after changing its repo list so it reloads configuration; do not pair another bot, expose credentials, or send a test message without authorization. Starting a missing service requires the user's requested scope.
- Report the repo/profile, validation command, routing, all checks and remaining gaps, config files changed, Telegram reload, and commit/push status. Do not call onboarding complete if required checks or registration are still missing. If an external dependency blocks completion, leave the configured files reviewable and state exactly what remains.
