import type { AgentRouteConfig, AgentsConfig } from '../workflow/types.js';

export function labelsMatchRoute(labels: string[], route: AgentRouteConfig): boolean {
  const set = new Set(labels.map(label => label.trim().toLowerCase()));
  if (route.none_labels.some(label => set.has(label))) return false;
  if (route.all_labels.some(label => !set.has(label))) return false;
  if (route.any_labels.length > 0 && !route.any_labels.some(label => set.has(label))) return false;
  return route.default || route.any_labels.length > 0 || route.all_labels.length > 0 || route.none_labels.length > 0;
}

export function routedProviderId(agents: AgentsConfig, labels: string[]): string {
  return agents.routes.find(route => labelsMatchRoute(labels, route))?.provider ?? agents.default;
}
