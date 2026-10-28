#!/usr/bin/env node
// Use the installed Symphony loader, label inventory and GitHub client as the source of truth.
import path from 'node:path';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  'symphony-root': { type: 'string' }, workflow: { type: 'string' }, config: { type: 'string' },
  apply: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
} });
if (values.help) {
  console.log('Usage: node ensure-labels.mjs --symphony-root PATH (--workflow PATH | --config PATH) [--apply]');
  process.exit(0);
}
try {
  if (!values['symphony-root'] || Boolean(values.workflow) === Boolean(values.config)) {
    throw new Error('Provide --symphony-root and exactly one of --workflow or --config.');
  }
  const root = await fs.realpath(path.resolve(values['symphony-root']));
  const require = createRequire(path.join(root, 'package.json'));
  const { tsImport } = await import(pathToFileURL(require.resolve('tsx/esm/api')).href);
  const source = relative => tsImport(pathToFileURL(path.join(root, 'src', relative)).href, import.meta.url);
  const [{ loadWorkflowFromFile }, { loadServerConfigFromFile }, { labelsForWorkflow, routingProblems }, { GithubIssueTrackerClient }] = await Promise.all([
    source('workflow/loadWorkflow.ts'), source('server/loadServerConfig.ts'), source('doctor/labels.ts'), source('github/githubClient.ts'),
  ]);
  const repos = values.workflow
    ? [{ id: 'workflow', workflow: path.resolve(values.workflow) }]
    : (await loadServerConfigFromFile(path.resolve(values.config))).repos.filter(repo => repo.enabled);
  const planned = [];
  const seen = new Set();
  // Validate every workflow and read every inventory before making any external mutation.
  for (const repo of repos) {
    const { config } = await loadWorkflowFromFile(repo.workflow);
    const problems = routingProblems(config.agents);
    if (problems.length) throw new Error(`${repo.id}: ${problems.join('; ')}`);
    const repository = `${config.tracker.owner}/${config.tracker.repo}`;
    const client = new GithubIssueTrackerClient(config.tracker);
    const existing = new Set((await client.listLabels()).map(label => label.name));
    const missing = labelsForWorkflow(config).filter(label => !existing.has(label));
    const unique = missing.filter(label => {
      const key = `${repository}:${label}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    planned.push({ repository, client, missing: unique });
  }
  let created = 0;
  for (const { repository, client, missing } of planned) {
    console.log(`${repository}: ${missing.length} missing labels${missing.length ? `: ${missing.join(', ')}` : ''}`);
    if (values.apply) {
      for (const label of missing) {
        await client.createLabelIfMissing(label);
        created++;
      }
      const after = new Set((await client.listLabels()).map(label => label.name));
      if (missing.some(label => !after.has(label))) throw new Error(`${repository}: verification found labels still missing`);
    }
  }
  console.log(values.apply ? `Created or reconciled ${created} labels; existing labels and issue assignments preserved.` : 'Preview only. Use --apply for authorized onboarding to create missing labels.');
} catch (error) {
  // Provider/network errors can carry credentials: do not dump raw errors or stack traces.
  if (error instanceof Error && (/^(Provide |workflow: |[\w.-]+: )/.test(error.message))) console.error(error.message);
  else console.error('Label provisioning failed. Check the Symphony source path, dependencies, workflow, GitHub authentication, and access. Completed label creations can be safely reconciled by rerunning.');
  process.exitCode = 1;
}
