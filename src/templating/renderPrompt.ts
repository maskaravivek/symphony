import { Liquid } from 'liquidjs';

import type { Issue } from '../domain/issue.js';

const engine = new Liquid({
  strictVariables: false,
  strictFilters: false,
  jsTruthy: true,
});

engine.registerFilter('join', (input: unknown, sep: unknown) => {
  if (!Array.isArray(input)) return '';
  const separator = typeof sep === 'string' ? sep : ',';
  return input.join(separator);
});

export async function renderPrompt(
  template: string,
  issue: Issue,
  extraContext: Record<string, unknown> = {},
): Promise<string> {
  return renderTemplate(template, { issue, ...extraContext });
}

export async function renderTemplate(template: string, context: Record<string, unknown>): Promise<string> {
  return engine.parseAndRender(template, context);
}
