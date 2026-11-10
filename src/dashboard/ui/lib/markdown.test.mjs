import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, parseInline, extractGroomingResult } from './markdown.js';

test('block structure', () => {
  const blocks = parseMarkdown('# Title\n\nFirst line\nsecond line\n\n- one\n- two\n\n1. a\n2. b\n\n```ts\nconst x = 1;\n```\n\n> quoted\n\n---');
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'paragraph', 'list', 'list', 'code', 'quote', 'rule']);
  assert.equal(blocks[0].level, 1);
  assert.deepEqual(blocks[1].inline, [{ type: 'text', text: 'First line second line' }]);
  assert.equal(blocks[2].ordered, false);
  assert.equal(blocks[2].items.length, 2);
  assert.equal(blocks[3].ordered, true);
  assert.deepEqual(blocks[4], { type: 'code', lang: 'ts', text: 'const x = 1;' });
});

test('unterminated code fence keeps the rest as code', () => {
  const blocks = parseMarkdown('```\nline 1\nline 2');
  assert.deepEqual(blocks, [{ type: 'code', lang: null, text: 'line 1\nline 2' }]);
});

test('HTML is never interpreted, only kept as text', () => {
  const blocks = parseMarkdown('<script>alert(1)</script> and <b>bold</b>');
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].inline, [{ type: 'text', text: '<script>alert(1)</script> and <b>bold</b>' }]);
});

test('inline code, strong, em and links', () => {
  assert.deepEqual(parseInline('run `yarn test` now'), [
    { type: 'text', text: 'run ' }, { type: 'code', text: 'yarn test' }, { type: 'text', text: ' now' },
  ]);
  assert.deepEqual(parseInline('**bold** and *it*'), [
    { type: 'strong', children: [{ type: 'text', text: 'bold' }] }, { type: 'text', text: ' and ' }, { type: 'em', children: [{ type: 'text', text: 'it' }] },
  ]);
  assert.deepEqual(parseInline('[docs](https://example.com/a)'), [{ type: 'link', href: 'https://example.com/a', children: [{ type: 'text', text: 'docs' }] }]);
  // unsafe schemes become plain text
  assert.deepEqual(parseInline('[x](javascript:alert(1))').some((n) => n.type === 'link'), false);
  // bare URLs
  const bare = parseInline('see https://github.com/a/b/issues/1.');
  assert.equal(bare[1].type, 'link');
  assert.equal(bare[1].href, 'https://github.com/a/b/issues/1');
  // snake_case words are not emphasis
  assert.deepEqual(parseInline('retry_reason_field'), [{ type: 'text', text: 'retry_reason_field' }]);
});

test('extractGroomingResult finds the trailing JSON', () => {
  const text = 'Summary here\n\nSYMPHONY_GROOMING_RESULT\n```json\n{"outcome":"ready","summary":"ok","scope":"small"}\n```\n';
  assert.deepEqual(extractGroomingResult(text), { outcome: 'ready', summary: 'ok', scope: 'small' });
  assert.equal(extractGroomingResult('no marker'), null);
  assert.equal(extractGroomingResult('SYMPHONY_GROOMING_RESULT {broken'), null);
});
