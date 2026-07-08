// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 dootaang — 로어북 추출기 (Lorebook Extractor). Licensed under GNU GPL v3 (see LICENSE).
// core/card/repack.js — 원본 카드 바이트에서 "카드 JSON만" 수술 교체(로어북 수정 반영 내보내기).
//
// 왜 재조립(cardEncode)이 아니라 수술인가: 우리 목적은 로어북만 바꾸는 것 — 에셋·메타를 디코드/재인코딩
// 하면 느리고(100MB급) 손실 위험. 수술 = 나머지 바이트 100% 보존.
//   .charx  : zip에서 card.json 한 엔트리만 교체(에셋은 무압축 통과 → 대형도 빠름)
//   .png    : ccv3 tEXt 청크만 교체(없으면 chara[V2]) — 아바타·chara-ext-asset 청크 그대로
//   .jpeg   : 그림 뒤에 붙은 charx zip(폴리글랏)의 card.json만 교체 후 재부착
//   .json   : 재직렬화
//   .risum  : RPack 인코딩(DECODE_MAP 역표)으로 메인 JSON 블록만 교체 — 에셋 블록 바이트 그대로
'use strict';
const { unzipSync, zipSync, strToU8, strFromU8 } = require('fflate');
const { DECODE_MAP, rpackDecode } = require('./risum.js');

const toBytes = (x) => (x instanceof Uint8Array ? x : new Uint8Array(x));
function cat(arrs) { let len = 0; for (const a of arrs) len += a.length; const o = new Uint8Array(len); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; }

// ── RPack 인코딩 = 디코드 표의 역치환(전단사) ──
const ENCODE_MAP = (() => { const t = new Uint8Array(256); for (let i = 0; i < 256; i++) t[DECODE_MAP[i]] = i; return t; })();
function rpackEncode(bytes) { const b = toBytes(bytes); const o = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) o[i] = ENCODE_MAP[b[i]]; return o; }

// ── charx: card.json 교체(+ 내장 module.risum이 있고 moduleJsonStr이 오면 그 메인 JSON도 교체) ──
//   ★리스AI는 charx에 module.risum이 있으면 그 lorebook을 card.json보다 우선하므로 둘 다 동기해야 한다.
function repackCharx(origBytes, cardJsonStr, moduleJsonStr) {
  const z = unzipSync(toBytes(origBytes));
  const out = {};
  let found = false;
  for (const name of Object.keys(z)) {
    if (name === 'card.json') { out[name] = [strToU8(cardJsonStr), { level: 6 }]; found = true; }
    else if (name === 'module.risum' && moduleJsonStr) out[name] = [repackRisum(z[name], moduleJsonStr), { level: 0 }];
    else out[name] = [z[name], { level: 0 }];   // 에셋(이미 압축된 미디어)은 무압축 통과 = 빠름·무손실
  }
  if (!found) throw new Error('charx 안에 card.json이 없습니다');
  return zipSync(out);
}

// charx(또는 JPEG 폴리글랏) 안에 내장된 module.risum → { bytes, json(메인 JSON 객체) } | null.
function charxEmbeddedModule(fileBytes) {
  const b = toBytes(fileBytes);
  let zip = null;
  if (b[0] === 0x50 && b[1] === 0x4b) zip = b;
  else if (b[0] === 0xff && b[1] === 0xd8) { const zs = zipStartInBytes(b); if (zs >= 0) zip = b.subarray(zs); }
  if (!zip) return null;
  try {
    const files = unzipSync(zip, { filter: (f) => f.name === 'module.risum' });
    const mod = files['module.risum'];
    if (!mod || mod[0] !== 0x6f) return null;
    const mainLen = new DataView(mod.buffer, mod.byteOffset + 2, 4).getUint32(0, true);
    return { bytes: mod, json: JSON.parse(strFromU8(rpackDecode(mod.subarray(6, 6 + mainLen)))) };
  } catch (_) { return null; }
}

// ── png: 카드 tEXt 청크 교체(ccv3 우선, 없으면 chara[V2]) ──
const b64encode = (bytes) => { let s = ''; const b = toBytes(bytes); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa ? btoa(s) : Buffer.from(b).toString('base64'); };
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
function crc32(bytes) { let c = 0xffffffff; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
const u32be = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, false); return b; };
function tEXtChunk(keyword, dataStr) {
  const body = cat([strToU8(keyword), new Uint8Array([0]), strToU8(dataStr)]);
  const typed = cat([strToU8('tEXt'), body]);
  return cat([u32be(body.length), typed, u32be(crc32(typed))]);
}
function repackPng(origBytes, cardJsonStr) {
  const b = toBytes(origBytes);
  if (!(b[0] === 0x89 && b[1] === 0x50)) throw new Error('PNG가 아닙니다');
  // 1패스: 어떤 카드 청크가 있는지(ccv3 우선)
  const keywords = [];
  let p = 8;
  while (p + 8 <= b.length) {
    const len = new DataView(b.buffer, b.byteOffset + p, 4).getUint32(0, false);
    const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    if (type === 'tEXt') {
      let q = p + 8; while (q < p + 8 + len && b[q] !== 0) q++;
      keywords.push(String.fromCharCode.apply(null, b.subarray(p + 8, q)));
    }
    p += 12 + len;
    if (type === 'IEND') break;
  }
  const target = keywords.includes('ccv3') ? 'ccv3' : (keywords.includes('chara') ? 'chara' : null);
  if (!target) throw new Error('PNG에 카드 청크(ccv3/chara)가 없습니다');
  const newChunk = tEXtChunk(target, b64encode(strToU8(cardJsonStr)));
  // 2패스: 교체 조립(대상 청크만 새 것, 나머지 바이트 그대로)
  const parts = [b.subarray(0, 8)];
  p = 8;
  while (p + 8 <= b.length) {
    const len = new DataView(b.buffer, b.byteOffset + p, 4).getUint32(0, false);
    const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    let isTarget = false;
    if (type === 'tEXt') {
      let q = p + 8; while (q < p + 8 + len && b[q] !== 0) q++;
      isTarget = String.fromCharCode.apply(null, b.subarray(p + 8, q)) === target;
    }
    parts.push(isTarget ? newChunk : b.subarray(p, p + 12 + len));
    p += 12 + len;
    if (type === 'IEND') break;
  }
  return cat(parts);
}

// ── jpeg 폴리글랏: 뒤에 붙은 charx zip 경계(EOCD 역산 — parseCard와 동일 방식) ──
function zipStartInBytes(b) {
  const min = Math.max(0, b.length - 65557);
  for (let i = b.length - 22; i >= min; i--) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) {
      const dv = new DataView(b.buffer, b.byteOffset + i, 22);
      const cdSize = dv.getUint32(12, true), cdOfs = dv.getUint32(16, true);
      const start = i - cdSize - cdOfs;
      if (start >= 0 && b[start] === 0x50 && b[start + 1] === 0x4b) return start;
    }
  }
  return -1;
}
function repackJpegCharx(origBytes, cardJsonStr, moduleJsonStr) {
  const b = toBytes(origBytes);
  const zs = zipStartInBytes(b);
  if (zs < 0) throw new Error('JPEG 안에서 카드(zip)를 찾지 못했습니다');
  return cat([b.subarray(0, zs), repackCharx(b.subarray(zs), cardJsonStr, moduleJsonStr)]);
}

// ── risum: 메인 JSON 블록만 교체(에셋 블록 바이트 그대로) ──
function repackRisum(origBytes, mainJsonStr) {
  const b = toBytes(origBytes);
  if (b[0] !== 0x6f) throw new Error('risum이 아닙니다');
  const oldLen = new DataView(b.buffer, b.byteOffset + 2, 4).getUint32(0, true);
  const main = rpackEncode(strToU8(mainJsonStr));
  const lenLE = new Uint8Array(4); new DataView(lenLE.buffer).setUint32(0, main.length, true);
  return cat([b.subarray(0, 2), lenLE, main, b.subarray(6 + oldLen)]);
}

// ── 디스패처: 원본 바이트로 포맷 자동 판별. opts.moduleJsonStr = charx 계열의 내장 모듈 동기용 ──
function repackCard(origBytes, cardJsonStr, opts = {}) {
  const b = toBytes(origBytes);
  if (b[0] === 0x89 && b[1] === 0x50) return { bytes: repackPng(b, cardJsonStr), ext: 'png' };
  if (b[0] === 0x50 && b[1] === 0x4b) return { bytes: repackCharx(b, cardJsonStr, opts.moduleJsonStr), ext: 'charx' };
  if (b[0] === 0xff && b[1] === 0xd8) return { bytes: repackJpegCharx(b, cardJsonStr, opts.moduleJsonStr), ext: 'jpeg' };
  if (b[0] === 0x6f) return { bytes: repackRisum(b, cardJsonStr), ext: 'risum' };
  return { bytes: strToU8(cardJsonStr), ext: 'json' };   // 평문 JSON(risu-export 포함)
}

module.exports = { repackCard, repackCharx, repackPng, repackJpegCharx, repackRisum, rpackEncode, zipStartInBytes, charxEmbeddedModule };
