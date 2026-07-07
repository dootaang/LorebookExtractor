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

ok('결정론 짝 = 로마자 유사도 게이트(음차만, LLM 0회)', () => {
  const r = rows.find((x) => x.term === 'Eun-ha');
  assert.equal(r.ko, '은하');   // 음차로 가장 가까운 한글 후보
  assert.equal(r.auto, true);
  assert.equal(rows.find((x) => x.term === 'Sung Eun-ha').ko, '성은하');
});
ok('음차 아닌 짝은 안 지음(번역 관계 ≠ 음차 — 빈칸=LLM 대상)', () => {
  assert.equal(rows.find((x) => x.term === 'Northern Kingdom').ko, '');   // 북방 왕국은 번역이지 음차가 아님
  const r = rows.find((x) => x.term === 'sword');
  assert.equal(r.ko, '');
  assert.equal(r.auto, false);
});
ok('연동 키 봇(여러 인물 키가 한 엔트리) — 오짝 없음 + 등가 자음(v→b)', () => {
  const multi = extractGlossary([{ uid: 'm', name: '💎 아르반(마왕의 검)', keys: ['Arvan', '아르반', 'mal', 'Maren', '멜', '마렌', 'Demon King', '마왕'], secondaryKeys: [], content: 'x' }]);
  assert.equal(multi.find((x) => x.term === 'Arvan').ko, '아르반');    // v→b 등가로 음차 매칭
  assert.equal(multi.find((x) => x.term === 'Maren').ko, '마렌');      // 자기 짝으로만
  assert.equal(multi.find((x) => x.term === 'mal').ko, '');            // 3자 약칭=모호 → 보수적으로 빈칸(LLM행)
  assert.equal(multi.find((x) => x.term === 'Demon King').ko, '');     // 몰아주기 금지(예전 버그)
});
ok('전체 중복 term은 1회 + 정규식/폴더 제외', () => {
  assert.equal(rows.filter((x) => x.term.toLowerCase() === 'eun-ha').length, 1);
  assert.ok(!rows.some((x) => /\(eun\|ha\)/.test(x.term)));
});
ok('프롬프트 텍스트: 쌍만 포함·형식', () => {
  const t = buildGlossaryText(rows);
  assert.ok(t.startsWith('[번역 용어집]'));
  assert.ok(t.includes('Eun-ha = 은하') && t.includes('Sung Eun-ha = 성은하'));
  assert.ok(!t.includes('sword') && !t.includes('Northern Kingdom'));   // 빈 번역(비음차 포함)은 제외
  assert.equal(buildGlossaryText([]), '');
});

console.log(`glossary: 모든 검사 통과 ✓ (${n})`);
