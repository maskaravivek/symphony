import { createHash } from 'node:crypto';
import type { Issue } from '../domain/issue.js';
import type { WorkflowConfig } from '../workflow/types.js';

export const GROOMING_LABEL = 'requires-grooming';
const lifecycle = new Set([GROOMING_LABEL, 'ready-for-agent', 'agent-running', 'needs-info', 'ready-for-human', 'symphony-failed', 'blocked', 'interactive', 'wontfix']);
export function groomingSource(issue: Issue): string {
  return createHash('sha256').update(JSON.stringify([issue.title, issue.description, issue.labels.filter(l => !lifecycle.has(l)).sort()])).digest('hex');
}
export interface GroomingResult {
  outcome: 'ready' | 'human';
  summary: string;
  scope: string;
  acceptance_criteria: string[];
  verification: string[];
  evidence: string[];
  labels: string[];
}
export function parseGroomingResult(text: string, config: WorkflowConfig, knownLabels: Set<string>): GroomingResult {
  const match = /^SYMPHONY_GROOMING_RESULT\s*\n([\s\S]*?)\nEND_SYMPHONY_GROOMING_RESULT\s*$/m.exec(text);
  if (!match) throw new Error('Grooming output is missing its structured result');
  const value = JSON.parse(match[1]!) as GroomingResult;
  if (!['ready', 'human'].includes(value.outcome)) throw new Error('Invalid grooming outcome');
  for (const key of ['summary', 'scope'] as const) {
    if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 10_000) throw new Error(`Invalid grooming ${key}`);
  }
  for (const key of ['acceptance_criteria', 'verification', 'evidence', 'labels'] as const) {
    if (!Array.isArray(value[key]) || value[key].length > 50 || value[key].some(v => typeof v !== 'string' || !v.trim() || v.length > 10_000)) throw new Error(`Invalid grooming ${key}`);
    if (key === 'acceptance_criteria' && value[key].length === 0) throw new Error(`Grooming ${key} cannot be empty`);
  }
  value.labels = [...new Set(value.labels.map(l => l.trim().toLowerCase()))];
  if (value.labels.some(l => lifecycle.has(l) || !knownLabels.has(l) || l.startsWith('symphony-review:'))) throw new Error('Grooming selected an unsupported or lifecycle label');
  const priorityLabels = Object.keys(config.tracker.priority_labels ?? {});
  const selectedPriorities = value.labels.filter(l => priorityLabels.includes(l));
  if (selectedPriorities.length > 1 || (value.outcome === 'ready' && priorityLabels.length && selectedPriorities.length !== 1)) throw new Error('Grooming must select exactly one configured priority when ready, and at most one when human attention is needed');
  if (JSON.stringify(value).length > 40_000) throw new Error('Grooming result exceeds the brief size limit');
  return value;
}
export function groomingBrief(result: GroomingResult): string {
  const bullets = (items: string[]) => items.map(item => `- ${item}`).join('\n');
  const sections = [
    '## Groomed issue brief',
    result.summary,
    result.scope,
    bullets(result.acceptance_criteria),
  ];
  if (result.verification.length) sections.push(`### Specific checks\n${bullets(result.verification)}`);
  if (result.evidence.length) sections.push(`### Evidence and assumptions\n${bullets(result.evidence)}`);
  sections.push(result.outcome === 'ready' ? 'Ready for implementation.' : 'Human attention required.');
  return sections.join('\n\n');
}
export function groomingInstructions(knownLabels: string[], config: WorkflowConfig): string {
  return `\n\n## Intake grooming (overrides implementation and issue-publishing instructions)
For a clear, bounded task, aim for under 150 words: one sentence of intent, a brief scope, and one or two observable outcomes. Read the issue and relevant comments or attachments, and do only the source and duplicate checks needed to clarify the request. Use the repository's issue planner for ambiguous, broad, or risky work that needs deeper investigation. Do not implement or modify GitHub yourself. Symphony publishes the brief and updates labels.
Preserve the reporter's intent. Distinguish evidence from assumptions; do not invent product requirements, reproduction results or tests run. Do not create arbitrary complexity/agent labels. Existing labels: ${JSON.stringify(knownLabels)}. Priority map: ${JSON.stringify(config.tracker.priority_labels)}.
Queue implementation for bounded work. A request to investigate a bug, choose an implementation approach, or verify the fix is part of normal implementation. Only add planning or task:spec if the reporter explicitly wants a plan, research, or mockups as the deliverable before implementation.
Leave verification and evidence empty unless the task has a specific risk, requested check, or finding the implementer needs. Let the implementer choose focused checks and follow repository merge policy. Do not prescribe a routine test matrix, screenshots, or new tests for a clear small task.
If a required intent/product/safety decision is unclear, use SYMPHONY_PAUSE with a concrete question and useful options. A reply resumes grooming. If work is a duplicate, spans an unapproved epic, is unsupported, or needs human action, return outcome human and explain why. For clearly scoped work, return ready with one configured priority. Preserve existing explicit agent, planning, risk and priority labels unless the reporter clearly superseded them; describe conflicts and return human instead of guessing.
For outcome human, labels may be empty; a priority is optional. Existing classification is preserved unless you explicitly propose a compatible label. Never select multiple priorities.
Otherwise finish with exactly:
SYMPHONY_GROOMING_RESULT
{"outcome":"ready","summary":"desired behavior","scope":"bounded scope and non-goals","acceptance_criteria":["observable result"],"verification":["real command/flow and expected result"],"evidence":["repo/source references and any explicit assumptions"],"labels":["one configured priority and appropriate existing labels"]}
END_SYMPHONY_GROOMING_RESULT
Do not use the structured ready result to bypass an unanswered question. Original capture and existing unrelated labels will be preserved.\n`;
}
