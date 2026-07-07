// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 dootaang — LogPapa. Licensed under GNU GPL v3 (see LICENSE).
// core/card/png.js
// CCv3 PNG 캐릭터카드에서 카드 JSON + 임베드 에셋 추출 (Pro 1.2 _extract_from_png 재현).
// 구조: PNG tEXt 청크 -
//   keyword 'ccv3'(또는 'chara') = base64 → 카드 JSON. data.assets[].uri = "__asset:N".
//   keyword 'chara-ext-asset_:N' = base64 → 이미지 바이트. uri의 N과 매칭.
'use strict';
const { strFromU8 } = require('fflate');
const { mimeFor, base64ToBytes, deriveTag, assetDataUrl, autoMap, buildImageMappings } = require('./assets.js');

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(b) { return PNG_SIG.every((v, i) => b[i] === v); }

// keyword/uri 끝의 숫자 id 추출: 'chara-ext-asset_:12' → '12', '__asset:12' → '12'
function trailingId(s) { const m = String(s).match(/(\d+)\s*$/); return m ? m[1] : null; }

function parsePngCard(bytesIn) {
  const b = bytesIn instanceof Uint8Array ? bytesIn : new Uint8Array(bytesIn);
  if (!isPng(b)) throw new Error('not a PNG file');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);

  let card = null;
  const chunkById = {}; // id → Uint8Array (이미지 바이트)
  let off = 8;
  while (off + 8 <= b.length) {
    const length = dv.getUint32(off); off += 4;
    const type = String.fromCharCode(b[off], b[off + 1], b[off + 2], b[off + 3]); off += 4;
    const data = b.subarray(off, off + length); off += length;
    off += 4; // CRC
    if (type === 'tEXt') {
      const z = data.indexOf(0);
      const keyword = strFromU8(data.subarray(0, z < 0 ? 0 : z));
      const text = data.subarray((z < 0 ? 0 : z) + 1);
      if (keyword === 'ccv3' || keyword === 'chara') {
        try { card = JSON.parse(strFromU8(base64ToBytes(strFromU8(text)))); } catch (e) { /* ignore */ }
      } else if (keyword.includes('_')) {
        const id = trailingId(keyword);
        if (id != null) { try { chunkById[id] = base64ToBytes(strFromU8(text)); } catch (e) { /* ignore */ } }
      }
    }
    if (type === 'IEND') break;
  }
  if (!card) throw new Error('no character card (ccv3/chara tEXt) in PNG');

  const data = card.data || {};
  const cardAssets = Array.isArray(data.assets) ? data.assets : [];
  const isCcDefault = (uri) => /^ccdefault:/i.test(uri);
  const assets = cardAssets.map((a) => {
    const uri = a.uri || '';
    let bytes = null;
    if (isCcDefault(uri)) bytes = b;           // 'main' = 카드 표지 이미지(PNG 자신)
    else { const id = trailingId(uri); bytes = id != null ? chunkById[id] : null; } // "__asset:N"
    const mime = isCcDefault(uri) ? 'image/png' : mimeFor(a.ext);
    return {
      name: a.name, type: a.type, ext: a.ext || (isCcDefault(uri) ? 'png' : a.ext), uri,
      tag: deriveTag(a.name, a.ext),
      mime,
      found: !!bytes,
      size: bytes ? bytes.length : 0,
      bytes: bytes || null,
    };
  });

  return { spec: card.spec, specVersion: card.spec_version, name: data.name, assets, card };
}

module.exports = { parsePngCard, isPng, assetDataUrl, autoMap, buildImageMappings };
