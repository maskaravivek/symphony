import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { writeRunState } from '../runState.js';
import { DashboardNotFoundError } from './context.js';
import { resolveDashboardSources } from './sources.js';
import { commandsFor, loadTaskDetail, parseGroomingMessage } from './taskState.js';
import { createDashboardFixture, fixtureRunState, FIXTURE_NOW } from './testFixtures.js';

test('loadTaskDetail joins run state, timeline, sessions, commands and epic for an issue', async () => {
  const fixture = await createDashboardFixture();
  const sources = await resolveDashboardSources({ config: fixture.configPath, fresh: true });
  const detail = await loadTaskDetail(sources, 'x', 1, { now: FIXTURE_NOW });

  assert.equal(detail.task.task_key, 'x/1');
  assert.equal(detail.run_state?.issue_number, 1);
  assert.deepEqual(detail.timeline.map((entry) => entry.event), ['workflow.started', 'merge.blocked']);
  assert.equal(detail.timeline[1]!.level, 'bad');
  assert.equal(detail.timeline[1]!.kind, 'merge');
  assert.equal(detail.sessions.length, 1);
  assert.equal(detail.sessions[0]!.session_id, 'sess-1');
  assert.equal(detail.sessions[0]!.usage?.input_tokens, 100);
  assert.equal(detail.commands.cd, `cd ${path.join(fixture.workspaceRoot, '_pool_1')}`);
  assert.equal(detail.commands.resume, 'codex resume --include-non-interactive thread-1');
  assert.equal(detail.commands.exec, 'codex exec resume thread-1 -');
  assert.equal(detail.commands.editor_url, `vscode://file${path.join(fixture.workspaceRoot, '_pool_1')}`);
  assert.equal(detail.epic, null);

  const epic = await loadTaskDetail(sources, 'x', 10, { now: FIXTURE_NOW });
  assert.equal(epic.task.kind, 'epic');
  assert.equal(epic.epic?.total_children, 2);

  const failed = await loadTaskDetail(sources, 'x', 2, { now: FIXTURE_NOW });
  assert.equal(failed.timeline.length, 2, 'consecutive identical retries collapse');
  assert.equal(failed.timeline[0]!.repeat_count, 2);
  assert.ok(failed.timeline[0]!.first_at);
  assert.doesNotMatch(failed.timeline[0]!.summary, /×|since/, 'repeat count is structured, not in the summary');
  assert.equal(failed.timeline[1]!.event, 'workflow.failed');

  await assert.rejects(loadTaskDetail(sources, 'x', 999), DashboardNotFoundError);
});

test('loadTaskDetail serves loops and parses grooming results', async () => {
  const fixture = await createDashboardFixture();
  const sources = await resolveDashboardSources({ config: fixture.configPath, fresh: true });
  const loop = await loadTaskDetail(sources, 'x', { loopId: 'daily' }, { now: FIXTURE_NOW });
  assert.equal(loop.task.kind, 'loop');
  assert.equal(loop.loop?.status, 'completed');
  assert.deepEqual(loop.timeline.map((entry) => entry.event), ['loop.triggered', 'loop.completed']);
  await assert.rejects(loadTaskDetail(sources, 'x', { loopId: 'weekly' }), DashboardNotFoundError);

  const workspace = path.join(fixture.workspaceRoot, 'acme_widget_9');
  const lastMessage = path.join(workspace, '.symphony', 'last_message.md');
  await writeRunState(
    workspace,
    fixtureRunState(workspace, {
      issue_number: 9,
      issue_id: 'issue-9',
      issue_identifier: 'acme/widget#9',
      agent_mode: 'grooming',
      codex_mode: 'grooming',
      status: 'completed',
      labels: ['ready-for-agent'],
      workflow_state: 'ready-for-agent',
      last_message_path: lastMessage,
    }),
  );
  await fs.writeFile(
    lastMessage,
    `Done.\nSYMPHONY_GROOMING_RESULT\n${JSON.stringify({ outcome: 'ready', summary: 'Make it blue', scope: 'CSS only' })}\nEND_SYMPHONY_GROOMING_RESULT\n`,
    'utf8',
  );
  const groomed = await loadTaskDetail(sources, 'x', 9, { now: FIXTURE_NOW });
  assert.equal(groomed.task.kind, 'grooming');
  assert.equal(groomed.grooming?.outcome, 'ready');
  assert.equal(groomed.grooming?.scope, 'CSS only');
});

test('parseGroomingMessage and commandsFor handle edge cases', () => {
  assert.equal(parseGroomingMessage('no marker here'), null);
  assert.equal(parseGroomingMessage('SYMPHONY_GROOMING_RESULT\nnot json'), null);
  assert.equal(parseGroomingMessage('SYMPHONY_GROOMING_RESULT\n{"outcome":"human","summary":"Ask"}')?.outcome, 'human');
  const claude = commandsFor(fixtureRunState('/w/a b', { agent_provider: 'claude', agent_provider_kind: 'claude' }), '/w/a b');
  assert.equal(claude.resume, null);
  assert.equal(claude.cd, "cd '/w/a b'");
  assert.equal(claude.editor_url, 'vscode://file/w/a%20b');
});
