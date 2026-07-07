// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 dootaang — LogPapa. Licensed under GNU GPL v3 (see LICENSE).
// core/card/cardEncode.js
// 봇카드 포맷 쓰기(변환) — charx ↔ png ↔ json. 읽기는 우리 parseCard(charx/png/json), 쓰기만 신규(RisuAI/ccardlib 카드 포맷 방식).
//   risum은 소스(읽기)만 = 타깃 아님. 입력 = parseCard 결과(parsed.card=card.json 객체, parsed.assets) + getBytes(asset)→Uint8Array.
//   포맷별 에셋 이식성: JSON=data:URI 인라인 · CharX=assets/ 전부 · PNG=tEXt 청크(아바타 1장 베이스 + 추가 에셋). 카드 데이터(디스크립션/로어북 등)는 보존.
'use strict';
const { zipSync, strToU8 } = require('fflate');
const { mimeFor, bytesToBase64 } = require('./assets.js');

const toBytes = (x) => (x instanceof Uint8Array ? x : new Uint8Array(x));
const u32be = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, false); return b; };
function cat(arrs) { let len = 0; for (const a of arrs) len += a.length; const o = new Uint8Array(len); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; }

// CRC32(PNG 청크 검사값)
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
function crc32(bytes) { let c = 0xffffffff; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

const cloneCard = (parsed) => JSON.parse(JSON.stringify(parsed.card || {}));

// → JSON(self-contained): 에셋을 data: URI로 인라인. Uint8Array(utf-8).
function encodeJson(parsed, getBytes) {
  const card = cloneCard(parsed); const data = card.data || (card.data = {});
  if (Array.isArray(data.assets)) data.assets = data.assets.map((a, i) => {
    const asset = (parsed.assets || [])[i]; const by = asset ? getBytes(asset) : null;
    return by ? Object.assign({}, a, { uri: `data:${mimeFor(a.ext)};base64,${bytesToBase64(toBytes(by))}` }) : a;
  });
  return strToU8(JSON.stringify(card));
}

// → CharX(ZIP: card.json + assets/<i>.<ext>). uri를 embeded://assets/<i>.<ext>로 재작성.
function encodeCharx(parsed, getBytes) {
  const card = cloneCard(parsed); const data = card.data || (card.data = {}); const files = {};
  if (Array.isArray(data.assets)) data.assets = data.assets.map((a, i) => {
    const asset = (parsed.assets || [])[i]; const by = asset ? getBytes(asset) : null;
    if (!by) return a;
    const pth = `assets/${i}.${(a.ext || 'png').toLowerCase()}`; files[pth] = toBytes(by);
    return Object.assign({}, a, { uri: 'embeded://' + pth });
  });
  files['card.json'] = strToU8(JSON.stringify(card));
  return zipSync(files);
}

// tEXt 청크: [len BE][("tEXt"+keyword\0data)][CRC32]
function tEXtChunk(keyword, dataStr) {
  const body = cat([strToU8(keyword), new Uint8Array([0]), strToU8(dataStr)]);
  const typed = cat([strToU8('tEXt'), body]);
  return cat([u32be(body.length), typed, u32be(crc32(typed))]);
}
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const isPngBytes = (b) => PNG_SIG.every((v, i) => b[i] === v);

// → PNG 카드: 베이스 PNG(아바타/메인)에 ccv3 tEXt(base64 JSON) + 추가 에셋 chara-ext-asset_:N 주입(IEND 앞).
//   baseBytes = 유효 PNG. main(표지)은 베이스 자체(ccdefault: 유지) — 추가 에셋만 청크로(uri=__asset:N).
function encodePng(parsed, baseBytes, getBytes) {
  const b = toBytes(baseBytes);
  if (b.length < 8 || !isPngBytes(b)) throw new Error('PNG 카드로 변환하려면 베이스 이미지가 PNG여야 합니다.');
  const card = cloneCard(parsed); const data = card.data || (card.data = {}); const chunks = [];
  if (Array.isArray(data.assets)) data.assets = data.assets.map((a, i) => {
    const asset = (parsed.assets || [])[i]; const by = asset ? getBytes(asset) : null;
    if (/^ccdefault:/i.test(a.uri || '') || !by) return a;   // main=베이스 자체, 바이트 없는 건 그대로
    chunks.push(tEXtChunk('chara-ext-asset_:' + i, bytesToBase64(toBytes(by))));
    return Object.assign({}, a, { uri: '__asset:' + i });
  });
  const ccv3 = tEXtChunk('ccv3', bytesToBase64(strToU8(JSON.stringify(card))));
  // IEND 청크 시작 위치 찾기(그 앞에 삽입)
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let off = 8, iend = b.length;
  while (off + 8 <= b.length) { const len = dv.getUint32(off); const ty = String.fromCharCode(b[off + 4], b[off + 5], b[off + 6], b[off + 7]); if (ty === 'IEND') { iend = off; break; } off += 12 + len; }
  return cat([b.subarray(0, iend), ccv3, ...chunks, b.subarray(iend)]);
}

// 변환 타깃에 쓸 베이스 PNG 고르기(PNG 카드용): main/icon 우선, 없으면 첫 PNG 이미지 에셋. 없으면 null(PNG 변환 불가).
function pickPngBase(parsed, getBytes) {
  const assets = parsed.assets || [];
  const pngs = assets.filter((a) => /png/i.test(a.ext || '') || /image\/png/.test(a.mime || ''));
  const main = pngs.find((a) => /^(main|icon|iconx)$/i.test(a.name || '')) || pngs[0];
  if (!main) return null;
  const by = getBytes(main); return (by && isPngBytes(toBytes(by))) ? toBytes(by) : null;
}

module.exports = { encodeJson, encodeCharx, encodePng, pickPngBase, crc32, isPngBytes };
