// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const assert = require('assert');
const { diagnoseLorebook } = require('./diagnose.js');
const { simulateActivation } = require('./activate.js');
const { estimateTokens, estimateLorebookTokens, applyTokenBudget } = require('./tokens.js');

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

const lore = {
  bookName: 'Audit Sample',
  tokenBudget: 40,
  scanDepth: 4,
  entries: [
    { uid: 'f0', name: 'Folder', isFolder: true, raw: { id: 'folder-a', key: 'folder:folder-a' } },
    { uid: 'e0', name: 'Always', keys: [], secondaryKeys: [], content: 'Always active lore.', enabled: true, constant: true, selective: false, useRegex: false, order: 10, folder: '', isFolder: false, raw: {} },
    { uid: 'e1', name: 'Sword', keys: ['sword'], secondaryKeys: [], content: '@@depth 4\nSword lore.', enabled: true, constant: false, selective: false, useRegex: false, order: 20, folder: 'folder:folder-a', isFolder: false, raw: {} },
    { uid: 'e2', name: 'Battle', keys: ['battle'], secondaryKeys: ['war'], content: 'Battle lore.', enabled: true, constant: false, selective: true, useRegex: false, order: 30, folder: '', isFolder: false, raw: {} },
    { uid: 'e3', name: 'Bad Regex', keys: ['[broken'], secondaryKeys: [], content: 'Regex lore.', enabled: true, constant: false, selective: false, useRegex: true, order: 40, folder: '', isFolder: false, raw: {} },
    { uid: 'e4', name: 'Empty', keys: [], secondaryKeys: [], content: '', enabled: true, constant: false, selective: false, useRegex: false, order: 50, folder: 'missing', isFolder: false, raw: {} },
    { uid: 'e5', name: 'Duplicate', keys: ['sword'], secondaryKeys: [], content: '@@weird\nDup lore.', enabled: false, constant: false, selective: false, useRegex: false, order: 60, folder: '', isFolder: false, raw: {} },
  ],
};

ok('tokens: estimates non-empty text', () => {
  assert.ok(estimateTokens('hello world') > 0);
  const s = estimateLorebookTokens(lore.entries);
  assert.ok(s.total > 0);
  assert.ok(s.constant > 0);
});

ok('tokens: applies budget in insertion order', () => {
  const r = applyTokenBudget([{ uid: 'a', order: 2, tokens: 30 }, { uid: 'b', order: 1, tokens: 20 }], 25);
  assert.deepEqual(r.kept.map((x) => x.uid), ['b']);
  assert.deepEqual(r.dropped.map((x) => x.uid), ['a']);
});

ok('activate: detects constant, primary, and secondary matches', () => {
  const r = simulateActivation(lore, 'I draw a sword before the battle starts. War is coming.');
  assert.deepEqual(r.active.map((x) => x.uid), ['e0', 'e1', 'e2']);
  assert.equal(r.active.find((x) => x.uid === 'e1').reason, 'primary');
  assert.equal(r.active.find((x) => x.uid === 'e2').reason, 'primary_secondary');
});

ok('activate: explains misses and invalid regex', () => {
  const r = simulateActivation(lore, 'quiet scene');
  assert.ok(r.inactive.some((x) => x.uid === 'e1' && x.reason === 'primary_missing'));
  assert.ok(r.inactive.some((x) => x.uid === 'e3' && x.reason === 'invalid_regex'));
});

ok('diagnose: finds health issues', () => {
  const r = diagnoseLorebook(lore);
  const codes = r.issues.map((i) => i.code);
  assert.ok(codes.includes('empty_content'));
  assert.ok(codes.includes('invalid_regex'));
  assert.ok(codes.includes('duplicate_key'));
  assert.ok(codes.includes('orphan_folder'));
  assert.ok(codes.includes('unknown_decorator'));
  assert.ok(r.counts.error >= 2);
});

console.log(`analysis: all checks passed (${n})`);
