// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 dootaang — 로어북 추출기. Licensed under GNU GPL v3 (see LICENSE).
'use strict';
const assert = require('assert');
const { extractGlossary, buildGlossaryText } = require('./glossary.js');

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

const entries = [
  { uid: 'e0', name: '성은하', keys: ['은하', '성은하', 'Eun-ha', 'Eun ha', 'Sung Eun-ha'], secondaryKeys: [], content: 'x' },
  { uid: 'e1', name: 'Combat System', keys: ['sword', 'battle'], secondaryKeys: [], content: 'x' },   // 한글 후보 없음 → ko 빈칸
  { uid: 'e2', name: '북방 왕국', keys: ['Northern Kingdom', '북왕국'], secondaryKeys: [], content: 'x' },
  { uid: 'e3', name: '중복', keys: ['Eun-ha'], secondaryKeys: [], content: 'x' },   // 전체 중복 → 1회만
  { uid: 'f', name: '폴더', keys: [], isFolder: true, secondaryKeys: [], content: '' },
  { uid: 'e4', name: '정규식', keys: ['(eun|ha)+'], secondaryKeys: [], content: 'x' },   // 정규식스러움 → 제외
];
const rows = extractGlossary(entries);

ok('결정론 짝: 엔트리 안 한글↔비한글 (LLM 0회)', () => {
  const r = rows.find((x) => x.term === 'Eun-ha');
  assert.equal(r.ko, '성은하');   // 한글 이름이 대표 표기
  assert.equal(r.auto, true);
  assert.equal(rows.find((x) => x.term === 'Northern Kingdom').ko, '북방 왕국');
});
ok('한글 후보 없는 엔트리 → ko 빈칸(LLM 채움 대상)', () => {
  const r = rows.find((x) => x.term === 'sword');
  assert.equal(r.ko, '');
  assert.equal(r.auto, false);
});
ok('전체 중복 term은 1회 + 정규식/폴더 제외', () => {
  assert.equal(rows.filter((x) => x.term.toLowerCase() === 'eun-ha').length, 1);
  assert.ok(!rows.some((x) => /\(eun\|ha\)/.test(x.term)));
});
ok('프롬프트 텍스트: 쌍만 포함·형식', () => {
  const t = buildGlossaryText(rows);
  assert.ok(t.startsWith('[번역 용어집]'));
  assert.ok(t.includes('Eun-ha = 성은하') && t.includes('Northern Kingdom = 북방 왕국'));
  assert.ok(!t.includes('sword'));   // 빈 번역은 제외
  assert.equal(buildGlossaryText([]), '');
});

console.log(`glossary: 모든 검사 통과 ✓ (${n})`);
