import assert from 'node:assert/strict';
import test from 'node:test';
import { intakeAliases, resolveIntake, type IntakeRepository } from './intakeRouting.js';

const repositories = ['mdedit', 'pdfkit.app', 'ai-photographer', 'taskdrop', 'ratelens', 'myaarti', 'freecalculator', 'markdownlist']
  .map(id => ({ id, repository: `owner/${id}`, aliases: intakeAliases(id) }));

test('all requested names route to their configured repositories and preserve task text', () => {
  for (const [name, id] of Object.entries({ mdedit: 'mdedit', pdfkit: 'pdfkit.app', 'camera coach': 'ai-photographer', taskdrop: 'taskdrop', ratelens: 'ratelens', aarti: 'myaarti', calculator: 'freecalculator' })) {
    const result = resolveIntake(`${name.toUpperCase()} Improve this\nKeep context.`, repositories);
    assert.equal(result.kind, 'matched');
    if (result.kind === 'matched') {
      assert.equal(result.repo.id, id);
      assert.equal(result.text, 'Improve this\nKeep context.');
    }
  }
});

test('unique substrings work, while ambiguous and unknown selectors cannot route', () => {
  const result = resolveIntake('lens Improve charts', repositories);
  assert.equal(result.kind, 'matched');
  if (result.kind === 'matched') assert.equal(result.repo.id, 'ratelens');
  assert.deepEqual(resolveIntake('md Improve charts', [...repositories, { id: 'mdtools', repository: 'owner/mdtools' }]), { kind: 'ambiguous', ids: ['mdedit', 'mdtools'] });
  assert.deepEqual(resolveIntake('unknown Improve charts', repositories), { kind: 'unknown' });
  assert.deepEqual(resolveIntake('pdfkit Fix export', repositories.filter(repo => repo.id !== 'pdfkit.app')), { kind: 'unknown' });
});

test('exact names beat substrings and repeated matching names do not cause ambiguity', () => {
  const repos: IntakeRepository[] = [...repositories, { id: 'pdf', repository: 'owner/pdf', aliases: ['pdf'] }];
  const result = resolveIntake('pdf Improve export', repos);
  assert.equal(result.kind, 'matched');
  if (result.kind === 'matched') assert.equal(result.repo.id, 'pdf');
  assert.equal(resolveIntake('taskdrop Fix export', repositories).kind, 'matched');
});

test('complete multiword alias without a task is rejected instead of treating its last word as a task', () => {
  for (const input of ['', 'camera coach', 'pdfkit', 'camera coach\n']) {
    assert.deepEqual(resolveIntake(input, repositories), { kind: 'invalid' });
  }
  assert.deepEqual(resolveIntake('camera coaching Improve hints', repositories), { kind: 'matched', repo: repositories[2]!, text: 'coaching Improve hints' });
});
