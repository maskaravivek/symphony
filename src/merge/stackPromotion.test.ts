import assert from 'node:assert/strict';
import test from 'node:test';

import { resolvePromotedBase } from './stackPromotion.js';

test('resolves a merged predecessor chain to the surviving base branch', () => {
  assert.equal(
    resolvePromotedBase('symphony-2-second', [
      { head_ref: 'symphony-2-second', base_ref: 'symphony-1-first' },
      { head_ref: 'symphony-1-first', base_ref: 'main' },
    ]),
    'main',
  );
});

test('keeps the current base when no predecessor was merged', () => {
  assert.equal(resolvePromotedBase('release', [{ head_ref: 'other', base_ref: 'main' }]), 'release');
});
