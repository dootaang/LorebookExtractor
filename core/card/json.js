// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 dootaang — LogPapa. Licensed under GNU GPL v3 (see LICENSE).
// core/card/json.js
// 카드 JSON 추출: 순수 .json 카드 + 이미지(JPEG 등)에 평문 JSON이 덧붙은 형식.
// 'chara_card' 마커를 찾아 감싸는 {...} 를 브레이스 매칭으로 떼어 파싱(바이트 단위, 포터블).
// 에셋: data: uri는 바이트로 디코드. embeded:// uri는 별도 바이너리 컨테이너(rpack)라 여기선 미해결(found:false).
'use strict';
const { strFromU8 } = require('fflate');
const { mimeFor, base64ToBytes, deriveTag, assetDataUrl, autoMap, buildImageMappings } = require('./assets.js');

const OPEN = 0x7b, CLOSE = 0x7d, QUOTE = 0x22, BSL = 0x5c;

function findBytes(b, str, from = 0) {
  const t = [];
  for (let i = 0; i < str.length; i++) t.push(str.charCodeAt(i));
  outer: for (let i = from; i <= b.length - t.length; i++) {
    for (let j = 0; j < t.length; j++) if (b[i + j] !== t[j]) continue outer;
    return i;
  }
  return -1;
}

// 'chara_card' 마커를 감싸는 최상위 JSON 객체 바이트 범위 [start,end]
function findCardJsonRange(b) {
  const marker = findBytes(b, 'chara_card');
  if (marker < 0) return null;
  let start = -1;
  for (let i = marker; i >= 0; i--) if (b[i] === OPEN) { start = i; break; }
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < b.length; i++) {
    const ch = b[i];
    if (inStr) { if (esc) esc = false; else if (ch === BSL) esc = true; else if (ch === QUOTE) inStr = false; }
    else { if (ch === QUOTE) inStr = true; else if (ch === OPEN) depth++; else if (ch === CLOSE) { depth--; if (depth === 0) return [start, i]; } }
  }
  return null;
}

function decodeDataUri(uri) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(uri);
  if (!m) return null;
  const mime = m[1] || 'application/octet-stream';
  const bytes = m[2] ? base64ToBytes(m[3]) : new Uint8Array([...decodeURIComponent(m[3])].map((c) => c.charCodeAt(0)));
  return { mime, bytes };
}

function parseJsonCard(bytesIn) {
  const b = bytesIn instanceof Uint8Array ? bytesIn : new Uint8Array(bytesIn);
  const range = findCardJsonRange(b);
  let card;
  if (range) {
    card = JSON.parse(strFromU8(b.subarray(range[0], range[1] + 1)));
  } else {
    card = JSON.parse(strFromU8(b));
    const isRisuLorebookExport = card && typeof card === 'object' && card.type === 'risu' && Array.isArray(card.data);
    const isRisuLorebookArray = Array.isArray(card) && card.every((e) => e && typeof e === 'object' && ('content' in e || 'key' in e || 'comment' in e));
    const isPlainCardJson = card && typeof card === 'object' && (card.spec || card.data || card.character_book || card.module);
    if (!isRisuLorebookExport && !isRisuLorebookArray && !isPlainCardJson) throw new Error('no character card JSON found');
  }
  const data = card.data || {};
  const cardAssets = Array.isArray(data.assets) ? data.assets : [];

  let embeddedUnresolved = 0;
  const assets = cardAssets.map((a) => {
    const uri = a.uri || '';
    let bytes = null, mime = mimeFor(a.ext);
    if (/^data:/i.test(uri)) { const d = decodeDataUri(uri); if (d) { bytes = d.bytes; mime = d.mime; } }
    else if (uri) embeddedUnresolved++; // embeded:// 등 — rpack 컨테이너 필요(미해결)
    return {
      name: a.name, type: a.type, ext: a.ext, uri,
      tag: deriveTag(a.name, a.ext), mime,
      found: !!bytes, size: bytes ? bytes.length : 0, bytes: bytes || null,
    };
  });

  const isRisuLorebookExport = card && typeof card === 'object' && card.type === 'risu' && Array.isArray(card.data);
  const isRisuLorebookArray = Array.isArray(card);
  return {
    spec: isRisuLorebookExport || isRisuLorebookArray ? 'risu-lorebook-export' : card.spec,
    specVersion: isRisuLorebookExport ? card.ver : card.spec_version,
    name: data.name || card.name || card.title || (isRisuLorebookExport || isRisuLorebookArray ? 'RisuAI Lorebook' : undefined),
    assets,
    card,
    embeddedUnresolved,
  };
}

module.exports = { parseJsonCard, findCardJsonRange, assetDataUrl, autoMap, buildImageMappings };
