import type { AgentRouteConfig, AgentsConfig, WorkflowConfig } from '../workflow/types.js';
import { routedProviderId } from '../agents/routing.js';

/** Includes labels needed to use configured routes, priorities and built-in execution modes. */
export function labelsForWorkflow(config: WorkflowConfig): string[] {
  const labels = new Set([
    ...config.tracker.required_labels,
    ...(config.tracker.any_required_labels ?? []),
    ...config.tracker.ignored_labels,
    ...Object.keys(config.tracker.priority_labels ?? {}),
    ...config.agents.routes.flatMap(route => [...route.any_labels, ...route.all_labels, ...route.none_labels]),
    'agent-running', 'blocked', 'ready-for-human', 'needs-info', 'interactive', 'symphony-failed',
    'requires-grooming', 'planning', 'task:spec',
    ...(config.tracker.epics.enabled ? ['epic', 'epic:stacked', 'epic:independent'] : []),
  ].map(label => label.trim().toLowerCase()).filter(Boolean));
  return [...labels].sort();
}

/** Each route is a small DNF: mandatory labels plus zero or one of its any_labels. */
function terms(route: AgentRouteConfig): Set<string>[] {
  if (!route.default && !route.any_labels.length && !route.all_labels.length && !route.none_labels.length) return [];
  return (route.any_labels.length ? route.any_labels : [null])
    .map(label => new Set([...route.all_labels, ...(label ? [label] : [])]))
    .filter(term => !route.none_labels.some(label => term.has(label)));
}

/** Reports definite single-rule shadowing and concrete counterexamples to explicit agent overrides. */
export function routingProblems(agents: AgentsConfig): string[] {
  const problems: string[] = [];
  for (const [index, route] of agents.routes.entries()) {
    const possibilities = terms(route);
    if (!possibilities.length) problems.push(`route ${index + 1} (${route.provider}) cannot match any labels`);
    const shadow = agents.routes.slice(0, index).findIndex(earlier => possibilities.length > 0 && possibilities.every(term =>
      earlier.none_labels.every(label => route.none_labels.includes(label)) && terms(earlier).some(prior => [...prior].every(label => term.has(label)))));
    if (shadow >= 0) problems.push(`route ${index + 1} (${route.provider}) is shadowed by route ${shadow + 1}`);
    if (route.default && index !== agents.routes.length - 1) problems.push(`default route ${index + 1} must be last`);
    if (route.default && (route.any_labels.length || route.all_labels.length || route.none_labels.length)) {
      problems.push(`default route ${index + 1} must not have label conditions`);
    }
  }
  const labels = new Set(agents.routes.flatMap(route => [...route.any_labels, ...route.all_labels, ...route.none_labels]));
  for (const explicit of [...labels].filter(label => label.startsWith('agent:'))) {
    const expected = explicit.slice('agent:'.length);
    if (!Object.values(agents.providers).some(provider => provider.id === expected || provider.provider_group === expected)) continue;
    const contexts = [[], ...[...labels].map(label => [label]), ...agents.routes.flatMap(route => terms(route).map(term => [...term]))];
    for (const context of contexts) {
      if (context.some(label => label.startsWith('agent:') && label !== explicit)) continue;
      const sample = [...new Set([explicit, ...context])];
      const selected = routedProviderId(agents, sample);
      if (selected !== expected && agents.providers[selected]?.provider_group !== expected) {
        problems.push(`${sample.join(' + ')} routes to ${selected}, overriding ${explicit}`);
        break;
      }
    }
  }
  return problems;
}
