// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 dootaang — LogPapa. Licensed under GNU GPL v3 (see LICENSE).
// core/card/charx.js
// CCv3 .charx (zip) 캐릭터카드에서 에셋 추출. 순수(bytes in → 구조 out), fflate 사용.
// 구조: card.json 의 data.assets[] = {type, uri:"embeded://assets/...", name, ext}
//   uri의 embeded:// 접두사를 떼면 zip 내부 경로. name = 매핑 키.
'use strict';
const { unzipSync, strFromU8 } = require('fflate');
const { mimeFor, deriveTag, assetDataUrl, autoMap, buildImageMappings } = require('./assets.js');

function toBytes(x) { return x instanceof Uint8Array ? x : new Uint8Array(x); }

// 지연 색인: card.json만 압축해제(filter)하고 에셋 파일은 안 풂. zip 중앙디렉토리를 훑어
//   에셋 존재 여부(found)·원본 크기(size)만 색인. 대형 charx 메모리 절약.
function parseCharxIndex(bytes) {
  const b = toBytes(bytes);
  const names = new Set();
  const sizes = Object.create(null);
  // filter는 모든 엔트리에 대해 호출됨 → 이름/크기 수집(부수효과), card.json만 실제 압축해제(true).
  const files = unzipSync(b, { filter: (f) => { names.add(f.name); sizes[f.name] = f.originalSize; return f.name === 'card.json'; } });
  const cardRaw = files['card.json'];
  if (!cardRaw) throw new Error('card.json not found in .charx');
  const card = JSON.parse(strFromU8(cardRaw));
  const data = card.data || {};
  const cardAssets = Array.isArray(data.assets) ? data.assets : [];

  const assets = cardAssets.map((a) => {
    const uri = a.uri || '';
    const p = uri.replace(/^[a-z][\w+.-]*:\/\//i, '');
    let path = p, exists = names.has(p);
    if (!exists) { try { const d = decodeURIComponent(p); if (names.has(d)) { path = d; exists = true; } } catch (e) { /* ignore */ } }
    return {
      name: a.name, type: a.type, ext: a.ext, uri, path,
      tag: deriveTag(a.name, a.ext), mime: mimeFor(a.ext),
      found: exists, size: exists ? (sizes[path] || 0) : 0, bytes: null,
    };
  });
  return { spec: card.spec, specVersion: card.spec_version, name: data.name, assets, card, lazy: true, _bytes: b };
}

// 지연 에셋 1개를 압축해제(캐시). bytes는 색인에 쓴 원본 charx 버퍼.
function decodeCharxAsset(bytes, asset) {
  if (!asset) return null;
  if (asset.bytes) return asset.bytes;
  if (!asset.path || !asset.found) return null;
  const files = unzipSync(toBytes(bytes), { filter: (f) => f.name === asset.path });
  const fb = files[asset.path] || null;
  if (fb) { asset.bytes = fb; asset.size = fb.length; }
  return asset.bytes;
}

function parseCharx(bytes) {
  const files = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const cardRaw = files['card.json'];
  if (!cardRaw) throw new Error('card.json not found in .charx');
  const card = JSON.parse(strFromU8(cardRaw));
  const data = card.data || {};
  const cardAssets = Array.isArray(data.assets) ? data.assets : [];

  const assets = cardAssets.map((a) => {
    const uri = a.uri || '';
    const p = uri.replace(/^[a-z][\w+.-]*:\/\//i, ''); // embeded:// (리수 오타 스펠링) 등 스킴 접두사 제거
    let fileBytes = files[p];
    if (!fileBytes) { try { fileBytes = files[decodeURIComponent(p)]; } catch (e) { /* ignore */ } }
    return {
      name: a.name, type: a.type, ext: a.ext, uri, path: p,
      tag: deriveTag(a.name, a.ext),
      mime: mimeFor(a.ext),
      found: !!fileBytes,
      size: fileBytes ? fileBytes.length : 0,
      bytes: fileBytes || null,
    };
  });

  return { spec: card.spec, specVersion: card.spec_version, name: data.name, assets, card };
}

module.exports = { parseCharx, parseCharxIndex, decodeCharxAsset, assetDataUrl, autoMap, deriveTag, buildImageMappings };
