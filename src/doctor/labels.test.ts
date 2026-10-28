import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadWorkflowFromFile } from '../workflow/loadWorkflow.js';
import { labelsForWorkflow, routingProblems } from './labels.js';
import { routedProviderId } from '../agents/routing.js';
import type { AgentRouteConfig } from '../workflow/types.js';

async function workflow() {
  return (await loadWorkflowFromFile(fileURLToPath(new URL('../../WORKFLOW.example.md', import.meta.url)), { GITHUB_TOKEN: 'test' })).config;
}
const route = (provider: string, match: Partial<AgentRouteConfig>): AgentRouteConfig => ({ provider, any_labels: [], all_labels: [], none_labels: [], default: false, ...match });

test('explicit agent overrides win over task and complexity routes', async () => {
  const { agents } = await workflow();
  const examples: Array<[string[], string]> = [
    [['agent:codex', 'ui', 'complexity:critical'], 'codex'],
    [['agent:codex', 'task:docs'], 'codex'],
    [['agent:claude', 'complexity:low'], 'claude'],
    [['agent:claude', 'chore'], 'claude'],
    [['agent:claude', 'complexity:high'], 'claude-fable'],
    [['agent:claude', 'complexity:critical', 'task:docs'], 'claude-fable'],
    [['agent:codex', 'agent:claude', 'complexity:high'], 'codex'],
    [['ui', 'complexity:low'], 'claude'],
    [['ui', 'complexity:medium'], 'claude'],
    [['ui', 'complexity:high'], 'claude-fable'],
    [['ui', 'complexity:tiny'], 'codex'],
    [['task:docs'], 'codex'],
    [['chore'], 'codex'],
    [[], 'codex'],
    [['  UI ', 'Complexity:Medium'], 'claude'],
  ];
  for (const [labels, expected] of examples) assert.equal(routedProviderId(agents, labels), expected, labels.join(' + '));
  assert.deepEqual(routingProblems(agents), []);
});

test('doctor checks route exclusions, priorities, planning and epic labels', async () => {
  const config = await workflow();
  config.agents.routes[0]!.none_labels = ['agent:excluded'];
  const labels = labelsForWorkflow(config);
  for (const expected of ['agent:codex', 'agent:claude', 'agent:excluded', 'planning', 'task:spec', 'epic:stacked', ...Object.keys(config.tracker.priority_labels ?? {})]) {
    assert(labels.includes(expected), `missing ${expected}`);
  }
  assert.equal(labels.length, new Set(labels).size);
});

test('doctor reports unreachable routes and misplaced defaults', async () => {
  const { agents } = await workflow();
  agents.routes = [route('codex', { default: true }), route('claude', { any_labels: ['ui'] })];
  assert(routingProblems(agents).some(problem => /default route 1 must be last/.test(problem)));
  assert(routingProblems(agents).some(problem => /route 2 .*shadowed/.test(problem)));
  agents.routes = [route('claude', { all_labels: ['ui'], none_labels: ['ui'] })];
  assert(routingProblems(agents).some(problem => /cannot match/.test(problem)));
});

test('doctor detects explicit agent overrides defeated by a task route', async () => {
  const { agents } = await workflow();
  agents.routes = [
    route('codex', { any_labels: ['chore'] }),
    route('claude', { any_labels: ['agent:claude'] }),
    route('codex', { default: true }),
  ];
  assert(routingProblems(agents).some(problem => /agent:claude \+ chore routes to codex/.test(problem)));
});
