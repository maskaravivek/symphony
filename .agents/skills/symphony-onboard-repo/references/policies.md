# Established Symphony policies

These are Utkarsha's installation preferences, not universal Symphony requirements. Preserve stronger existing repo policy unless the user asks to change it. Read the installed loader/types and a current workflow when writing exact YAML; these notes describe intent and important field values.

## Small side project: default for new repos

- Codex only: provider `codex`, `provider_group: codex`, `provider_kind: codex`, one unconditional final default route. No mandatory reviews and no Spark provider. Do not add Claude routes simply because the app has a UI.
- `review.enabled: false`, `review.shepherd_pull_requests: false`, `merge.enabled: true`, `merge.required_reviews: 0`, `merge.require_independent_reviews: false`, `merge.dry_run: false`. Preserve the repo's merge method; squash is the existing side-project convention.
- `merge.required_evidence.standard: [validation]` and `.elevated: [validation]`, with a meaningful `merge.validation_command` and a repo-specific policy version. `require_checks: false` allows repos without mandatory GitHub CI; pending/failing GitHub checks still block merges. This does not bypass branch protection.
- Auto-merge remains gated on actual successful validation and local/remote head/base consistency. Genuine human decisions, blockers and dirty/stale checkouts must still stop merging. Missing native prerequisites are documented skips for all seven side projects; they do not require human input or block merging. Actual code/test failures still block. An agent's successful exit is not sufficient.
- `agent.max_attempts: 3`; repo concurrency one. Issue polling is `300000` ms. Require `ready-for-agent`; honor `blocked`, `interactive`, `needs-info`, `ready-for-human`, `symphony-failed`, and `wontfix`.
- Reuse the repo's existing priority labels. Current side projects use `priority: urgent`, `priority: high`, `priority: medium`, `priority: low` mapped to 1–4. mdedit uses `priority:p0` through `priority:p3`; do not mix vocabularies accidentally.
- Native epics default to independent execution, coordinator-only parents, and `auto_label_children: false` for new side projects. Children need their own readiness and routing labels. Preserve explicit exceptions: mdedit and taskdrop currently auto-label eligible children.

Native side-project validation uses the portable `scripts/symphony-native-check.mjs` copied from this skill's `scripts/native-check.mjs`. Probe before native work; never spend the coding turn installing SDKs, booting devices or obtaining private native configuration. Wrap Android/macOS validation commands so recognized unavailable infrastructure is skipped, while code failures remain nonzero. Report every skip in the PR/issue. Keep web/static/unit checks that can run. Open a non-draft PR once available checks pass; if a genuine human decision remains, publish completed work as a draft before pausing. Do not describe skipped checks as passed or merging as deployment.

## Existing mdedit / advanced profile

mdedit retains a fresh external Codex review approval, PR shepherding and its risk/evidence rules. `review.enabled: false` disables Symphony's own review run, not the external GitHub review bot. Never copy or remove this gate as a side effect of onboarding another repo. If a new repo's risk warrants a different policy, establish that from the user's intent and existing policy rather than assuming all repos match mdedit.

The advanced route order in mdedit and Symphony's current example is:

1. `agent:codex` → regular Codex, including when both overrides are present.
2. `agent:claude` + high/critical complexity → the configured stronger Claude provider; other `agent:claude` work → Claude.
3. UX/UI/design + high/critical complexity → the configured stronger Claude provider.
4. Tiny/docs/chore work → regular Codex.
5. Other UX/UI/design work, including low/medium complexity → Claude.
6. Default → regular Codex.

Explicit override labels must not be defeated by task labels. Use the installed workflow's supported providers; do not hardcode a model alias from these notes. Ordinary side projects need none of this advanced routing.

## Workspace and storage settings

```yaml
workspace:
  root: ~/.symphony/workspaces/REPO_ID
  clean_on_terminal: true
  strategy:
    implementation: pooled_isolated
    planning: durable_issue_workspace
    epic:
      stacked: durable_epic_workspace
      independent: pooled_isolated
  storage_maintenance:
    enabled: true
    interval_ms: 86400000
    min_free_gib: 20
    idle_days: 7
    retention_days: 30
    max_artifact_gib: 2
    max_pool_slots: 8
    max_cache_gib: 10
```

These are current runtime defaults, but stating the daily policy in a new workflow makes onboarding reviewable. An optional `cache_root` must be an exclusively Symphony-owned cache, never a user's checkout or shared system cache. Dependency snapshot hooks should touch the snapshot directory when reused. Git mirrors are preserved because clones can reference them via alternates.

Maintenance runs under Symphony's workflow lock while the repo is idle, on the first eligible tick and every 24 hours afterward, with its cadence persisted. It preserves protected work rather than enforcing a hard total disk cap. Archived evidence expires; do not promise permanent retention. Removed repo roots, unknown directories, episode history, Git mirrors, external launchd logs and system-wide caches are not automatically deleted.

## Central config and Telegram

Preserve global concurrency (currently four), issue polling `300000` ms and `repository_sync.enabled: true` with `interval_ms: 43200000`. The sync only fast-forwards eligible primary main checkouts; task workspaces fetch independently. Paths in a tracked portable config should be relative to that config where practical; runtime paths must resolve to the actual local checkout.

Telegram is an existing paired service with 30-second long polling. Adding a repo to the central config and reloading the existing bridge supplies visibility. Do not reset pairing, cursors or credentials. On the current Mac, the bridge launchd label is `com.mangoappstudio.symphony-telegram`; discover whether it is running before reloading it. Onboarding does not start the coding orchestrator.
