// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 dootaang — LogPapa. Licensed under GNU GPL v3 (see LICENSE).
// core/card/cardAssets.js
// 관리실 에셋 추출기 — 전 포맷(charx/png/json/risum) 내부 에셋을 ★지연(lazy)으로 꺼낸다.
//   기존 파서 재사용(새 디코더 0): parseCard({lazy}) + 포맷별 on-demand 복호(decodeRisumAsset/decodeCharxAsset).
//   risum/charx는 인덱스만 먼저(큰 모듈 668MB도 메모리 안 터짐) → 누른 에셋만 복호. png/json은 즉시(작음).
'use strict';
const { parseCard } = require('./parseCard.js');
const { decodeRisumAsset } = require('./risum.js');
const { decodeCharxAsset } = require('./charx.js');

function toBytes(x) { return x instanceof Uint8Array ? x : new Uint8Array(x); }

// 소스 바이트 → {format, name, assets:[{name,type,ext,mime,size,found,bytes,...}], _bytes, lazy}.
//   risum/charx = 지연 인덱스(bytes=null, _bytes 보관) · png/json = 즉시(bytes 채워짐).
function parseCardAssets(bytes, fileName) {
  return parseCard(toBytes(bytes), fileName, { lazy: true });
}

// 에셋 1개 바이트: 이미 있으면 그대로, 없으면 포맷별 on-demand 복호(캐시됨). 큰 모듈도 누른 것만.
function cardAssetBytes(parsed, asset) {
  if (!asset) return null;
  if (asset.bytes) return asset.bytes;
  try {
    if (parsed && parsed.format === 'risum') return decodeRisumAsset(parsed._bytes, asset);
    if (parsed && parsed.format === 'charx') return decodeCharxAsset(parsed._bytes, asset);
  } catch (_) { /* 깨진 에셋은 null */ }
  return asset.bytes || null;
}

module.exports = { parseCardAssets, cardAssetBytes };
