// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 dootaang — 로어북 추출기. Licensed under GNU GPL v3 (see LICENSE).
// normalize.js 검증 — 합성 픽스처(항상) + 실파일 회귀(로컬에 있을 때만, CI에선 자동 스킵).
'use strict';
const assert = require('assert');
const fs = require('fs');
const { extractLorebook, splitDecorators, groupByFolder, loreStats, buildCharacterBook, buildMarkdown } = require('./normalize.js');

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

// ── 합성: CCv3 카드 ──
const ccv3 = { spec: 'chara_card_v3', data: { name: '봇', character_book: { name: '북', entries: [
  { keys: ['sword', 'battle'], secondary_keys: ['war'], comment: 'Combat', content: '@@depth 4\n\n전투 설정', enabled: true, constant: false, selective: true, insertion_order: 2 },
  { keys: [], comment: 'Always', content: '상시 설정', enabled: true, constant: true, insertion_order: 1 },
  { keys: ['off'], comment: 'Off', content: 'x', enabled: false, insertion_order: 3 },
] } } };
const L1 = extractLorebook(ccv3);
ok('CCv3: kind/개수/북이름', () => { assert.equal(L1.kind, 'card'); assert.equal(L1.entries.length, 3); assert.equal(L1.bookName, '북'); });
ok('CCv3: 필드 매핑', () => { const e = L1.entries[0]; assert.deepEqual(e.keys, ['sword', 'battle']); assert.deepEqual(e.secondaryKeys, ['war']); assert.equal(e.name, 'Combat'); assert.equal(e.selective, true); assert.equal(e.order, 2); });
ok('CCv3: constant/enabled', () => { assert.equal(L1.entries[1].constant, true); assert.equal(L1.entries[2].enabled, false); });
ok('데코레이터 분리', () => { const d = splitDecorators(L1.entries[0].content); assert.deepEqual(d.decorators, ['@@depth 4']); assert.equal(d.body.trim(), '전투 설정'); });
ok('통계', () => { const s = loreStats(L1.entries); assert.equal(s.total, 3); assert.equal(s.constant, 1); assert.equal(s.disabled, 1); });

// ── 합성: 리스 모듈 ──
const risum = { module: { name: '모듈', lorebook: [
  { key: 'F', comment: '폴더A', content: '', mode: 'folder', insertorder: 0 },
  { key: '오키, Aoi', secondkey: '학교', comment: 'Oki', content: '설정', mode: 'normal', alwaysActive: true, selective: true, useRegex: false, insertorder: 1, folder: 'F' },
  { key: 'b', comment: '루트', content: 'r', insertorder: 2 },
] }, type: 'risuModule' };
const L2 = extractLorebook(risum);
ok('risum: kind/개수', () => { assert.equal(L2.kind, 'module'); assert.equal(L2.entries.length, 3); });
ok('risum: 쉼표 키 분해·매핑', () => { const e = L2.entries[1]; assert.deepEqual(e.keys, ['오키', 'Aoi']); assert.deepEqual(e.secondaryKeys, ['학교']); assert.equal(e.constant, true); assert.equal(e.folder, 'F'); });
ok('폴더 그룹핑', () => { const g = groupByFolder(L2.entries); assert.equal(g.length, 2); assert.equal(g[0].folder, null); assert.equal(g[0].items.length, 1); assert.equal(g[1].folder.name, '폴더A'); assert.equal(g[1].items[0].name, 'Oki'); });

// ── 내보내기 ──
ok('CCv3 JSON 왕복(키 원문 고정)', () => {
  const tr = { e0: { name: '전투', content: '번역본' } };
  const j = buildCharacterBook(L1, tr, 'tr');
  assert.deepEqual(j.data.entries[0].keys, ['sword', 'battle']);   // 키는 절대 번역 안 됨
  assert.equal(j.data.entries[0].comment, '전투');
  assert.equal(j.data.entries[0].content, '번역본');
  const j2 = buildCharacterBook(L1, tr, 'orig');
  assert.equal(j2.data.entries[0].comment, 'Combat');              // 이름 원문 유지 모드
});
// Synthetic: RisuAI standalone lorebook export JSON.
const risuExport = { type: 'risu', ver: 1, data: [
  { key: 'alpha, beta', secondkey: 'gamma', comment: 'Standalone', content: 'body', mode: 'normal', alwaysActive: true, selective: true, useRegex: true, insertorder: 7 },
] };
const L3 = extractLorebook(risuExport);
ok('risu export: kind/count', () => { assert.equal(L3.kind, 'risu-export'); assert.equal(L3.entries.length, 1); });
ok('risu export: fields', () => {
  const e = L3.entries[0];
  assert.deepEqual(e.keys, ['alpha', 'beta']);
  assert.deepEqual(e.secondaryKeys, ['gamma']);
  assert.equal(e.name, 'Standalone');
  assert.equal(e.constant, true);
  assert.equal(e.useRegex, true);
  assert.equal(e.order, 7);
});

ok('Markdown 빌드', () => { const md = buildMarkdown(L2, null, 'orig'); assert.ok(md.includes('폴더A') && md.includes('오키, Aoi')); });

// ── 실파일 회귀(있을 때만 — CI 스킵) ──
function findNamedFile(dir, filename) {
  if (!fs.existsSync(dir)) return null;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = dir + '/' + ent.name;
    if (ent.isFile() && ent.name === filename) return p;
    if (ent.isDirectory()) {
      const found = findNamedFile(p, filename);
      if (found) return found;
    }
  }
  return null;
}

const RISU_EXPORT_SAMPLE = findNamedFile(process.cwd(), 'lorebook_export.json');
if (RISU_EXPORT_SAMPLE) {
  const { parseCard } = require('../card/parseCard.js');
  ok('sample: lorebook_export.json parses as risu export', () => {
    const p = parseCard(fs.readFileSync(RISU_EXPORT_SAMPLE), 'lorebook_export.json', { lazy: true });
    const l = extractLorebook(p.card);
    assert.equal(p.spec, 'risu-lorebook-export');
    assert.equal(l.kind, 'risu-export');
    assert.equal(l.entries.length, 13);
    assert.ok(l.entries[0].name.includes('RP'));
    assert.equal(l.entries[0].constant, true);
  });
}

const REAL = 'C:/pro 1.2/캐릭터파일';
if (fs.existsSync(REAL)) {
  const { parseCard } = require('../card/parseCard.js');
  ok('실파일: 메리시스터즈 charx = 91개', () => {
    const p = parseCard(fs.readFileSync(REAL + '/Merry Sisters! - Final.charx'), 'm.charx', { lazy: true });
    const l = extractLorebook(p.card); assert.equal(l.entries.length, 91); assert.equal(l.kind, 'card');
  });
  ok('실파일: 오키 아오이 risum = 5개', () => {
    const p = parseCard(fs.readFileSync(REAL + '/모듈봇/오키 아오이(Oki Aoi).risum'), 'o.risum', { lazy: true });
    const l = extractLorebook(p.card); assert.equal(l.entries.length, 5); assert.equal(l.kind, 'module'); assert.ok(l.entries[0].keys.length >= 2);
  });
  ok('실파일: Flandre module.charx = 2개', () => {
    const p = parseCard(fs.readFileSync(REAL + '/모듈봇/Flandre1.1.module.charx'), 'f.charx', { lazy: true });
    const l = extractLorebook(p.card); assert.equal(l.entries.length, 2);
  });
} else console.log('  (실파일 회귀 스킵 — 캐릭터파일 폴더 없음)');

console.log(`normalize: 모든 검사 통과 ✓ (${n})`);
