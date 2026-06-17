import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadWorkflowFromFile } from './loadWorkflow.js';

async function writeWorkflow(frontMatter: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-workflow-'));
  const workflowPath = path.join(dir, 'WORKFLOW.md');
  await fs.writeFile(workflowPath, `---\n${frontMatter}---\n\nPrompt body\n`, 'utf8');
  return workflowPath;
}

test('loads bounded retry attempts', async () => {
  const workflowPath = await writeWorkflow(`
tracker:
  kind: github
  owner: mangoappstudio
  repo: mdedit
  token: token
agent:
  max_attempts: 3
codex:
  command: codex exec -
`);

  const loaded = await loadWorkflowFromFile(workflowPath);
  assert.equal(loaded.config.agent.max_attempts, 3);
});

test('rejects invalid bounded retry attempts', async () => {
  const workflowPath = await writeWorkflow(`
tracker:
  kind: github
  owner: mangoappstudio
  repo: mdedit
  token: token
agent:
  max_attempts: 0
codex:
  command: codex exec -
`);

  await assert.rejects(() => loadWorkflowFromFile(workflowPath), /agent.max_attempts must be a positive number/);
});
