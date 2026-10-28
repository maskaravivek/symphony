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
    if (key !== 'labels' && value[key].length === 0) throw new Error(`Grooming ${key} cannot be empty`);
  }
  value.labels = [...new Set(value.labels.map(l => l.trim().toLowerCase()))];
  if (value.labels.some(l => lifecycle.has(l) || !knownLabels.has(l) || l.startsWith('symphony-review:'))) throw new Error('Grooming selected an unsupported or lifecycle label');
  const priorityLabels = Object.keys(config.tracker.priority_labels ?? {});
  if (priorityLabels.length && value.labels.filter(l => priorityLabels.includes(l)).length !== 1) throw new Error('Grooming must select exactly one configured priority');
  if (JSON.stringify(value).length > 40_000) throw new Error('Grooming result exceeds the brief size limit');
  return value;
}
export function groomingBrief(result: GroomingResult): string {
  return `## Groomed issue brief\n\n${result.summary}\n\n### Scope and boundaries\n${result.scope}\n\n### Acceptance criteria\n${result.acceptance_criteria.map(v => `- ${v}`).join('\n')}\n\n### Observable verification\n${result.verification.map(v => `- ${v}`).join('\n')}\n\n### Evidence and assumptions\n${result.evidence.map(v => `- ${v}`).join('\n')}\n\nDisposition: ${result.outcome === 'ready' ? 'Ready for the configured agent workflow.' : 'Human attention required; implementation is not queued.'}\n\nOriginal capture and attachments remain in the issue body.`;
}
export function groomingInstructions(knownLabels: string[], config: WorkflowConfig): string {
  return `\n\n## Intake grooming (overrides implementation and issue-publishing instructions)
This issue is a rough capture tagged requires-grooming, authorizing investigation, grooming, and automatic queuing of clearly scoped bounded work after successful grooming. Read the repository's symphony-plan-issues skill, or its specialized issue planner such as mdedit-issue-planner, and apply its scoping, deduplication, priority and verification guidance. Inspect relevant code/docs, attachments when accessible, issue comments, and existing GitHub issues. Do not implement, edit repo files, commit, push, open PRs, create issues/epics, change labels, or mutate GitHub yourself. Symphony publishes your brief and performs validated label transitions.
Preserve the reporter's intent. Distinguish evidence from assumptions; do not invent product requirements, reproduction results or tests run. Do not create arbitrary complexity/agent labels. Existing labels: ${JSON.stringify(knownLabels)}. Priority map: ${JSON.stringify(config.tracker.priority_labels)}.
If a required intent/product/safety decision is unclear, use SYMPHONY_PAUSE with a concrete question and useful options. The existing Telegram bridge will deliver it; a reply resumes grooming, not implementation. If work is a duplicate, spans an unapproved epic, is unsupported, or needs human action instead of clarification, return outcome human and explain why. For clearly scoped work, return ready with concrete acceptance criteria, real verification steps, and one configured priority. Preserve existing explicit agent, planning, risk and priority labels unless the reporter clearly superseded them; describe conflicts and return human instead of guessing.
Otherwise finish with exactly:
SYMPHONY_GROOMING_RESULT
{"outcome":"ready","summary":"desired behavior","scope":"bounded scope and non-goals","acceptance_criteria":["observable result"],"verification":["real command/flow and expected result"],"evidence":["repo/source references and any explicit assumptions"],"labels":["one configured priority and appropriate existing labels"]}
END_SYMPHONY_GROOMING_RESULT
Do not use the structured ready result to bypass an unanswered question. Original capture and existing unrelated labels will be preserved.\n`;
}
