// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 dootaang — 로어북 추출기. Licensed under GNU GPL v3 (see LICENSE).
// repack + applyCard 왕복 검증 — 실파일(charx=항상[샘플], risum/png/jpeg=있을 때만).
'use strict';
const assert = require('assert');
const fs = require('fs');
const { unzipSync } = require('fflate');
const { parseCard } = require('./parseCard.js');
const { repackCard, repackCharx, rpackEncode, zipStartInBytes } = require('./repack.js');
const { encodeJson, encodeCharx, encodePng, pickPngBase } = require('./cardEncode.js');
const { cardAssetBytes } = require('./cardAssets.js');
const { DECODE_MAP, rpackDecode } = require('./risum.js');
const { extractLorebook } = require('../lorebook/normalize.js');
const { applyLorebookToCard } = require('../lorebook/applyCard.js');

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

ok('RPack 인코딩 = 디코딩의 역(왕복 동일)', () => {
  const src = new Uint8Array(256).map((_, i) => i);
  assert.deepEqual(Array.from(rpackDecode(rpackEncode(src))), Array.from(src));
  assert.equal(new Set(DECODE_MAP).size, 256);   // 전단사 확인
});

// ── charx 왕복(샘플 = 항상 실행) ──
const CHARX = __dirname + '/../../샘플/New_TSF.charx';
if (fs.existsSync(CHARX)) {
  ok('charx(폴리글랏 포함) 수술: 로어북만 바뀌고 에셋 바이트 동일', () => {
    const orig = new Uint8Array(fs.readFileSync(CHARX));
    const isJpeg = orig[0] === 0xff && orig[1] === 0xd8;   // New_TSF = 그림 뒤 charx 부착(공유용 폴리글랏)
    const p = parseCard(orig, 't.charx', { lazy: true });
    const lore = extractLorebook(p.card);
    const entries = lore.entries.map((e, i) => (i === 0 ? { ...e, name: '수정된 이름', content: '수정된 본문', keys: e.keys.concat(['ジャ테스트']) } : e));
    const json = applyLorebookToCard(p.card, lore.kind, entries);
    const { bytes, ext } = repackCard(orig, json);
    assert.equal(ext, isJpeg ? 'jpeg' : 'charx');
    const p2 = parseCard(bytes, 't2.' + ext, { lazy: true });
    const l2 = extractLorebook(p2.card);
    assert.equal(l2.entries.length, lore.entries.length);
    assert.equal(l2.entries[0].name, '수정된 이름');
    assert.equal(l2.entries[0].content, '수정된 본문');
    assert.ok(l2.entries[0].keys.includes('ジャ테스트'));
    assert.equal(l2.entries[1].content, lore.entries[1].content);   // 나머지 무변경
    // 에셋 무손실: zip 엔트리 수·첫 에셋 바이트 동일(폴리글랏은 zip 부분만 비교) + 그림 바이트 보존
    const zipOf = (b) => { const zs = isJpeg ? zipStartInBytes(b) : 0; return { z: unzipSync(b.subarray(zs)), zs }; };
    const A = zipOf(orig), B = zipOf(bytes);
    if (isJpeg) assert.deepEqual(bytes.subarray(0, B.zs), orig.subarray(0, A.zs));
    assert.equal(Object.keys(A.z).length, Object.keys(B.z).length);
    const asset = Object.keys(A.z).find((k) => k !== 'card.json');
    if (asset) assert.deepEqual(B.z[asset], A.z[asset]);
    // 로어북 밖 카드 필드 보존
    assert.equal(p2.card.data.name, p.card.data.name);
  });
} else console.log('  (charx 왕복 스킵 — 샘플 없음)');

// ── 형식 변환(내보내기 포맷 선택 배선) — 샘플 = JPEG 폴리글랏 New_TSF ──
if (fs.existsSync(CHARX)) {
  const orig = new Uint8Array(fs.readFileSync(CHARX));
  const p = parseCard(orig, 'New_TSF.charx', { lazy: true });
  const lore = extractLorebook(p.card);
  const entries = lore.entries.map((e, i) => (i === 0 ? { ...e, name: '변환 이름', content: '변환 본문' } : e));
  const json = applyLorebookToCard(p.card, lore.kind, entries);
  const gb = (a) => cardAssetBytes(p, a);
  const reparse = (bytes, name) => extractLorebook(parseCard(bytes, name, { lazy: true }).card);

  if (orig[0] === 0xff && orig[1] === 0xd8) {
    ok('폴리글랏→charx 수술: PK 매직·로어북 반영·zip 엔트리 수 동일', () => {
      const zs = zipStartInBytes(orig);
      assert.ok(zs > 0);
      const out = repackCharx(orig.subarray(zs), json);
      assert.ok(out[0] === 0x50 && out[1] === 0x4b);   // 진짜 charx(zip)로 시작
      const l2 = reparse(out, 'c.charx');
      assert.equal(l2.entries.length, lore.entries.length);
      assert.equal(l2.entries[0].name, '변환 이름');
      assert.equal(Object.keys(unzipSync(out)).length, Object.keys(unzipSync(orig.subarray(zs))).length);
    });
  }
  ok('charx 재조립(encodeCharx): 로어북 반영·에셋 전부 포함', () => {
    const out = encodeCharx({ ...p, card: JSON.parse(json) }, gb);
    assert.ok(out[0] === 0x50 && out[1] === 0x4b);
    const p2 = parseCard(out, 'c2.charx', { lazy: true });
    const l2 = extractLorebook(p2.card);
    assert.equal(l2.entries[0].content, '변환 본문');
    assert.equal(p2.assets.length, p.assets.length);
    assert.ok(p2.assets.every((a) => a.found));
  });
  ok('png 변환(encodePng): 베이스 없으면 null 가드·있으면 ccv3 재파싱', () => {
    // New_TSF 에셋은 ext=png 거짓말(실제 RIFF/WebP) → 베이스 불가 = null(UI가 toast로 안내하는 경로)
    assert.equal(pickPngBase(p, gb), null);
    // 합성 최소 PNG(sig+IHDR+IEND — 청크 구조만 유효하면 됨)를 베이스로 인코딩 자체를 검증
    const be = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; };
    const s = (t) => Uint8Array.from(t, (c) => c.charCodeAt(0));
    const base = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ...be(13), ...s('IHDR'), ...new Uint8Array(13), 0, 0, 0, 0,
      ...be(0), ...s('IEND'), 0, 0, 0, 0]);
    const out = encodePng({ ...p, card: JSON.parse(json) }, base, gb);
    assert.ok(out[0] === 0x89 && out[1] === 0x50);
    const p2 = parseCard(out, 'c.png', { lazy: true });
    const l2 = extractLorebook(p2.card);
    assert.equal(l2.entries[0].name, '변환 이름');
    assert.equal(p2.assets.length, p.assets.length);
    assert.ok(p2.assets.every((a) => a.found));
  });
  ok('json 변환(encodeJson): data URI 인라인·로어북 반영', () => {
    const out = encodeJson({ ...p, card: JSON.parse(json) }, gb);
    const card = JSON.parse(Buffer.from(out).toString('utf8'));
    assert.ok((card.data.assets || []).every((a) => /^data:/.test(a.uri)));
    const l2 = reparse(out, 'c.json');
    assert.equal(l2.entries.length, lore.entries.length);
    assert.equal(l2.entries[0].name, '변환 이름');
  });
}

// ── risum 왕복(실파일 있을 때만) ──
const RISUM = 'C:/pro 1.2/캐릭터파일/모듈봇/오키 아오이(Oki Aoi).risum';
if (fs.existsSync(RISUM)) {
  ok('risum 수술: 메인 JSON만 교체·에셋 블록 바이트 동일', () => {
    const orig = new Uint8Array(fs.readFileSync(RISUM));
    const p = parseCard(orig, 'o.risum', { lazy: true });
    const lore = extractLorebook(p.card);
    const entries = lore.entries.map((e, i) => (i === 0 ? { ...e, content: '모듈 수정 본문' } : e));
    const json = applyLorebookToCard(p.card, lore.kind, entries);
    const { bytes, ext } = repackCard(orig, json);
    assert.equal(ext, 'risum');
    const p2 = parseCard(bytes, 'o2.risum', { lazy: true });
    const l2 = extractLorebook(p2.card);
    assert.equal(l2.entries.length, lore.entries.length);
    assert.equal(l2.entries[0].content, '모듈 수정 본문');
    assert.equal(p2.card.module.name, p.card.module.name);
    // 에셋 블록 바이트 동일(메인 뒤 꼬리 비교)
    const oldLen = new DataView(orig.buffer, orig.byteOffset + 2, 4).getUint32(0, true);
    const newLen = new DataView(bytes.buffer, bytes.byteOffset + 2, 4).getUint32(0, true);
    assert.deepEqual(bytes.subarray(6 + newLen), orig.subarray(6 + oldLen));
  });
} else console.log('  (risum 왕복 스킵)');

// ── png / jpeg 폴리글랏(실파일 있을 때만) ──
const PNG = 'C:/pro 1.2/캐릭터파일/타로PNG.png';
if (fs.existsSync(PNG)) {
  ok('png 수술: ccv3 청크 교체·왕복', () => {
    const orig = new Uint8Array(fs.readFileSync(PNG));
    const p = parseCard(orig, 't.png', { lazy: true });
    const lore = extractLorebook(p.card) || { kind: 'card', entries: [] };
    const entries = lore.entries.concat([{ uid: 'n1', name: '새 로어', keys: ['테스트키'], secondaryKeys: [], content: '새 본문', enabled: true, constant: false, selective: false, useRegex: false, order: 1, position: '', folder: '', isFolder: false, raw: null }]);
    const json = applyLorebookToCard(p.card, 'card', entries);
    const { bytes, ext } = repackCard(orig, json);
    assert.equal(ext, 'png');
    const l2 = extractLorebook(parseCard(bytes, 't2.png', { lazy: true }).card);
    assert.equal(l2.entries.length, lore.entries.length + 1);
    assert.equal(l2.entries[l2.entries.length - 1].name, '새 로어');
  });
} else console.log('  (png 왕복 스킵)');
const JPEG = 'C:/pro 1.2/캐릭터파일/타로JPEG.jpeg';
if (fs.existsSync(JPEG)) {
  ok('jpeg 폴리글랏 수술: 그림 보존·카드만 교체', () => {
    const orig = new Uint8Array(fs.readFileSync(JPEG));
    const p = parseCard(orig, 't.jpeg', { lazy: true });
    const lore = extractLorebook(p.card) || { kind: 'card', entries: [] };
    const entries = lore.entries.concat([{ uid: 'n1', name: 'JPEG 로어', keys: ['k'], secondaryKeys: [], content: 'c', enabled: true, constant: false, selective: false, useRegex: false, order: 1, position: '', folder: '', isFolder: false, raw: null }]);
    const json = applyLorebookToCard(p.card, 'card', entries);
    const { bytes, ext } = repackCard(orig, json);
    assert.equal(ext, 'jpeg');
    assert.ok(bytes[0] === 0xff && bytes[1] === 0xd8);   // 여전히 JPEG로 시작(그림 보존)
    const l2 = extractLorebook(parseCard(bytes, 't2.jpeg', { lazy: true }).card);
    assert.equal(l2.entries.length, lore.entries.length + 1);
  });
} else console.log('  (jpeg 왕복 스킵)');

console.log(`repack: 모든 검사 통과 ✓ (${n})`);
