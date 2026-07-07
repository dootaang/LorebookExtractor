// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 dootaang — LogPapa. Licensed under GNU GPL v3 (see LICENSE).
// core/card/parseCard.js
// 매직 바이트로 카드 포맷 자동 판별 → 적절한 파서. 모든 파서는 동일한 {spec,name,assets,card} 모양 반환.
//   .charx(zip PK) / .png(PNG sig, ccv3 tEXt) / .jpeg·.json(평문 JSON)
'use strict';
const { parseCharx, parseCharxIndex } = require('./charx.js');
const { parsePngCard, isPng } = require('./png.js');
const { parseJsonCard } = require('./json.js');
const { parseRisumCard, parseRisumIndex } = require('./risum.js');

function toBytes(x) { return x instanceof Uint8Array ? x : new Uint8Array(x); }

function detectFormat(b) {
  if (isPng(b)) return 'png';
  if (b[0] === 0x50 && b[1] === 0x4b) return 'charx';   // 'PK' zip (.charx / .module.charx)
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpeg';     // JPEG SOI
  if (b[0] === 0x6f) return 'risum';                     // RPack 매직 'o' (.risum 모듈)
  return 'json';
}

// JPEG 폴리글랏(그림 뒤에 charx zip을 통째로 붙인 공유용 카드) 감지 — zip 시작 오프셋(프리픽스 길이).
//   스캔 대신 정확 계산: 파일 끝 EOCD(PK\x05\x06)의 중앙디렉토리 크기·오프셋에서 역산.
//   zip이 없으면(-1) 기존 경로(평문 JSON 붙은 jpeg 등) 유지.
function embeddedZipStart(b) {
  const min = Math.max(0, b.length - 65557);   // EOCD(22B) + 최대 코멘트(65535B)
  for (let i = b.length - 22; i >= min; i--) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) {
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const cdSize = dv.getUint32(i + 12, true), cdOff = dv.getUint32(i + 16, true);
      const start = i - cdSize - cdOff;
      return (start >= 0 && start < b.length) ? start : -1;
    }
  }
  return -1;
}

// opts.lazy: risum 모듈을 색인만 하고 블롭은 필요 시 디코딩(대형 모듈 메모리 절약). 다른 포맷은 무시(즉시).
function parseCard(bytes, hintName, opts = {}) {
  const b = toBytes(bytes);
  let fmt = detectFormat(b);
  let parsed;
  if (fmt === 'jpeg') {
    // JPEG 폴리글랏: 뒤에 charx zip이 붙어 있으면 그 지점부터 charx로(에셋·변환 전부 동작).
    // zip이 아니거나(우연한 EOCD 패턴) 파싱 실패면 기존 jpeg 경로(평문 JSON)로 폴백.
    const zs = embeddedZipStart(b);
    if (zs > 0) {
      try { const sub = b.subarray(zs); parsed = opts.lazy ? parseCharxIndex(sub) : parseCharx(sub); fmt = 'charx'; }
      catch (_) { parsed = null; }
    }
  }
  if (!parsed) {
    if (fmt === 'png') parsed = parsePngCard(b);
    else if (fmt === 'charx') parsed = opts.lazy ? parseCharxIndex(b) : parseCharx(b);
    else if (fmt === 'risum') parsed = opts.lazy ? parseRisumIndex(b) : parseRisumCard(b);
    else parsed = parseJsonCard(b); // jpeg(평문 JSON) / json
  }
  return Object.assign({ format: fmt, source: hintName || null }, parsed);
}

module.exports = { parseCard, detectFormat, embeddedZipStart };
