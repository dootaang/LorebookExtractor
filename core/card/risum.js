// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 dootaang — LogPapa. Licensed under GNU GPL v3 (see LICENSE).
// core/card/risum.js
// RisuAI .risum / module.risum (RPack) 파서.
// RPack = 바이트 치환 암호(압축 아님). 256바이트 DECODE 테이블로 out[i]=DECODE[in[i]].
// 구조: [0x6F 매직][버전][uint32 LE mainLen][RPack(JSON)] 그다음 ([0x01][uint32 LE len][RPack(asset)])* [0x00]
// DECODE_MAP 출처: @risuai/ccardlib (MIT, 저자 kwaroran)의 RPack 변환표 — GPL-호환(MIT).
//   (옛 주석의 komodoD/RisuToki는 CC BY-NC=GPL 비호환이라 출처를 정식 MIT 라이브러리로 정정.)
'use strict';
const { strFromU8 } = require('fflate');
const { mimeFor, deriveTag, assetDataUrl, autoMap, buildImageMappings } = require('./assets.js');

const DECODE_MAP = new Uint8Array([
  44, 247, 132, 139, 201, 101, 251, 182, 159, 174, 179, 3, 45, 1, 105, 116,
  31, 228, 163, 236, 238, 92, 52, 33, 147, 74, 15, 106, 226, 98, 2, 158,
  34, 156, 253, 60, 252, 113, 199, 198, 173, 89, 103, 5, 112, 109, 138, 68,
  18, 250, 36, 134, 95, 175, 209, 122, 71, 206, 254, 80, 99, 221, 81, 6,
  111, 24, 224, 82, 168, 9, 157, 86, 115, 76, 184, 83, 108, 195, 160, 14,
  25, 207, 62, 13, 126, 7, 50, 104, 70, 234, 72, 249, 153, 46, 171, 164,
  73, 32, 94, 85, 53, 56, 12, 188, 211, 177, 88, 22, 121, 40, 10, 26,
  225, 242, 205, 196, 57, 219, 162, 186, 96, 114, 118, 125, 149, 239, 127, 200,
  192, 222, 55, 148, 191, 181, 20, 129, 146, 37, 69, 172, 231, 245, 102, 167,
  43, 54, 90, 193, 19, 227, 75, 58, 232, 141, 131, 27, 124, 39, 176, 154,
  66, 235, 135, 170, 220, 84, 142, 120, 38, 210, 87, 41, 212, 183, 248, 47,
  143, 137, 117, 240, 65, 119, 194, 30, 255, 216, 21, 17, 229, 4, 151, 23,
  243, 49, 208, 155, 0, 215, 202, 180, 79, 42, 59, 217, 178, 107, 218, 93,
  161, 63, 48, 97, 189, 145, 61, 78, 230, 223, 190, 77, 130, 140, 29, 35,
  16, 152, 100, 244, 133, 51, 123, 144, 67, 187, 169, 136, 241, 214, 165, 28,
  246, 204, 110, 185, 91, 11, 150, 237, 213, 233, 197, 203, 8, 166, 128, 64,
]);

function rpackDecode(input) {
  const out = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = DECODE_MAP[input[i]];
  return out;
}

// .risum 바이너리 → { module(JSON), assetBlobs([Uint8Array]) }
function parseRisum(bytesIn) {
  const b = bytesIn instanceof Uint8Array ? bytesIn : new Uint8Array(bytesIn);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b[0] !== 0x6f) throw new Error(`invalid risum magic 0x${b[0].toString(16)} (expected 0x6f)`);
  let off = 2; // magic + version
  const mainLen = dv.getUint32(off, true); off += 4;
  const module = JSON.parse(strFromU8(rpackDecode(b.subarray(off, off + mainLen)))); off += mainLen;
  const assetBlobs = [];
  while (off < b.length) {
    const marker = b[off++];
    if (marker === 0x00) break;
    if (marker !== 0x01) throw new Error(`unexpected risum asset marker 0x${marker.toString(16)}`);
    const len = dv.getUint32(off, true); off += 4;
    assetBlobs.push(rpackDecode(b.subarray(off, off + len))); off += len;
  }
  return { module, assetBlobs };
}

// .risum → 표준 카드 모양 {spec,name,assets,card}. 에셋 entry = [name, ref(보통 빈문자), ext], 블롭은 위치순.
// opts.onlyTags 주면 그 이름의 블롭만 디코드(나머지는 스킵) → 대형 모듈(수백MB) 메모리 절약.
function parseRisumCard(bytesIn, opts = {}) {
  const { onlyTags = null } = opts;
  const b = bytesIn instanceof Uint8Array ? bytesIn : new Uint8Array(bytesIn);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b[0] !== 0x6f) throw new Error(`invalid risum magic 0x${b[0].toString(16)} (expected 0x6f)`);
  let off = 2;
  const mainLen = dv.getUint32(off, true); off += 4;
  const root = JSON.parse(strFromU8(rpackDecode(b.subarray(off, off + mainLen)))); off += mainLen;
  const m = (root && root.module) || root || {};
  const entries = Array.isArray(m.assets) ? m.assets : [];
  const want = onlyTags ? new Set(onlyTags) : null;

  const blobs = new Array(entries.length).fill(null);
  let i = 0;
  while (off < b.length) {
    const marker = b[off++];
    if (marker === 0x00) break;
    if (marker !== 0x01) throw new Error(`unexpected risum asset marker 0x${marker.toString(16)}`);
    const len = dv.getUint32(off, true); off += 4;
    const decode = i < entries.length && (!want || want.has(Array.isArray(entries[i]) ? entries[i][0] : entries[i].name));
    if (decode) blobs[i] = rpackDecode(b.subarray(off, off + len));
    off += len; i++;
  }

  const assets = entries.map((e, idx) => {
    const name = Array.isArray(e) ? e[0] : (e.name || '');
    const ext = Array.isArray(e) ? e[2] : (e.ext || '');
    const bytes = blobs[idx] || null;
    return {
      name, type: 'module-asset', ext, uri: '',
      tag: deriveTag(name, ext), mime: mimeFor(ext),
      found: !!bytes, size: bytes ? bytes.length : 0, bytes,
    };
  });
  return { spec: 'risu-module', specVersion: root && root.type, name: m.name, namespace: m.namespace, assets, card: root, module: m };
}

// ── 지연(lazy) 색인: 블롭을 복호하지 않고 위치만 기록 → 대형 모듈(수백MB) 메모리 절약 ──
// parseRisumIndex(bytes): 모듈 JSON만 복호 + 에셋별 {_off,_len} 색인(bytes=null, found=true).
// decodeRisumAsset(bytes, asset): 그 슬라이스만 rpack 복호(asset.bytes에 캐시).
function toBytes(x) { return x instanceof Uint8Array ? x : new Uint8Array(x); }

function parseRisumIndex(bytesIn) {
  const b = toBytes(bytesIn);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b[0] !== 0x6f) throw new Error(`invalid risum magic 0x${b[0].toString(16)} (expected 0x6f)`);
  let off = 2;
  const mainLen = dv.getUint32(off, true); off += 4;
  const root = JSON.parse(strFromU8(rpackDecode(b.subarray(off, off + mainLen)))); off += mainLen;
  const m = (root && root.module) || root || {};
  const entries = Array.isArray(m.assets) ? m.assets : [];

  const locs = []; // 위치순 {off,len} (복호 안 함, 스캔만)
  while (off < b.length) {
    const marker = b[off++];
    if (marker === 0x00) break;
    if (marker !== 0x01) throw new Error(`unexpected risum asset marker 0x${marker.toString(16)}`);
    const len = dv.getUint32(off, true); off += 4;
    locs.push({ off, len }); off += len;
  }

  const assets = entries.map((e, idx) => {
    const name = Array.isArray(e) ? e[0] : (e.name || '');
    const ext = Array.isArray(e) ? e[2] : (e.ext || '');
    const loc = locs[idx];
    return {
      name, type: 'module-asset', ext, uri: '',
      tag: deriveTag(name, ext), mime: mimeFor(ext),
      found: !!loc, size: loc ? loc.len : 0, bytes: null,
      _off: loc ? loc.off : -1, _len: loc ? loc.len : 0, // rpack은 길이 보존(치환) → _len = 복호 길이
    };
  });
  return { spec: 'risu-module', specVersion: root && root.type, name: m.name, namespace: m.namespace, assets, card: root, module: m, lazy: true, _bytes: b };
}

// 지연 에셋 1개를 복호(캐시). bytes는 parseRisumIndex가 쓴 _bytes(또는 동일 버퍼)여야 함.
function decodeRisumAsset(bytes, asset) {
  if (!asset) return null;
  if (asset.bytes) return asset.bytes;
  if (asset._off == null || asset._off < 0) return null;
  const b = toBytes(bytes);
  asset.bytes = rpackDecode(b.subarray(asset._off, asset._off + asset._len));
  asset.found = true; asset.size = asset.bytes.length;
  return asset.bytes;
}

module.exports = { parseRisum, parseRisumCard, parseRisumIndex, decodeRisumAsset, rpackDecode, DECODE_MAP, assetDataUrl, autoMap, buildImageMappings };
