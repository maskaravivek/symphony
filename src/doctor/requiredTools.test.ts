import assert from 'node:assert/strict';
import test from 'node:test';

import { requiredToolsForWorkflow } from './requiredTools.js';
import type { WorkflowConfig } from '../workflow/types.js';

test('finds tools nested inside shell-wrapped provider commands and hooks', () => {
  const config = {
    hooks: {
      after_create: 'git clone "$REPOSITORY" .',
      before_run: 'yarn install --frozen-lockfile && gh auth status',
      after_run: null,
      timeout_ms: 120_000,
    },
    agents: {
      default: 'codex',
      providers: {
        codex: {
          command: 'bash -lc \'codex exec --json\'',
          resume_command: null,
          handoff_command: null,
          usage_limit_check_command: 'codexbar --provider codex --format json | jq -e .',
        },
        claude: {
          command: 'claude --output-format stream-json',
          resume_command: null,
          handoff_command: null,
          usage_limit_check_command: null,
        },
      },
      routes: [],
    },
  } as unknown as WorkflowConfig;

  assert.deepEqual(requiredToolsForWorkflow(config), ['bash', 'claude', 'codex', 'codexbar', 'gh', 'git', 'jq', 'yarn']);
});

test('does not mistake command arguments or prose for executables', () => {
  const config = {
    hooks: { after_create: null, before_run: null, after_run: null, timeout_ms: 120_000 },
    agents: {
      default: 'codex',
      providers: {
        codex: {
          command: 'codex exec --model gpt-5',
          resume_command: null,
          handoff_command: null,
          usage_limit_check_command: null,
        },
      },
      routes: [],
    },
  } as unknown as WorkflowConfig;

  assert.deepEqual(requiredToolsForWorkflow(config), ['codex']);
});
