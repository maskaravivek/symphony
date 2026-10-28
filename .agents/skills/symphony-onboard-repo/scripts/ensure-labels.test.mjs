import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('./ensure-labels.mjs', import.meta.url));
const symphony = fileURLToPath(new URL('../../../../', import.meta.url));

test('previews, applies, verifies and reruns without modifying existing labels or issues', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-onboarding-labels-'));
  const workflow = path.join(root, 'WORKFLOW.md');
  const existing = { name: 'ready-for-agent', color: 'abcdef', description: 'Keep my description' };
  const labels = new Map([[existing.name, existing]]);
  let writes = 0;
  let unexpected = 0;
  const server = http.createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url.split('?')[0] !== '/repos/test/app/labels') {
      unexpected++; response.writeHead(404); response.end('{}'); return;
    }
    if (request.method === 'GET') { response.end(JSON.stringify([...labels.values()])); return; }
    if (request.method !== 'POST') { unexpected++; response.writeHead(405); response.end('{}'); return; }
    let body = '';
    for await (const chunk of request) body += chunk;
    const label = JSON.parse(body);
    writes++; labels.set(label.name, label);
    response.writeHead(201); response.end(JSON.stringify(label));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const yaml = routes => `---
tracker:
  owner: test
  repo: app
  token: local-test-token
  api_base_url: http://127.0.0.1:${server.address().port}
  priority_labels:
    'priority: test': 1
agents:
  providers:
    codex:
      command: codex exec -
  routes:
${routes}
---
Prompt.
`;
  const normal = yaml('    - provider: codex\n      default: true');
  await fs.writeFile(workflow, normal);
  const invoke = (...args) => exec(process.execPath, [script, '--symphony-root', symphony, '--workflow', workflow, ...args]);
  assert.match((await invoke()).stdout, /Preview only/);
  assert.equal(writes, 0);
  assert.match((await invoke('--apply')).stdout, /Created or reconciled/);
  assert(writes > 0);
  assert(labels.has('planning'));
  assert(labels.has('priority: test'));
  const count = writes;
  assert.match((await invoke('--apply')).stdout, /0 missing labels/);
  assert.equal(writes, count);
  assert.deepEqual(labels.get('ready-for-agent'), existing);
  assert.equal(await fs.readFile(workflow, 'utf8'), normal);
  assert.equal(unexpected, 0);
  // Invalid routes must fail before attempting to fill a newly missing label.
  labels.delete('planning');
  await fs.writeFile(workflow, yaml('    - provider: codex\n      default: true\n    - provider: codex\n      any_labels: [ui]'));
  await assert.rejects(invoke('--apply'), /must be last|shadowed/);
  assert.equal(writes, count);
});
