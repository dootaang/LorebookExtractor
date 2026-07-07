// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 dootaang — LogPapa. Licensed under GNU GPL v3 (see LICENSE).
// core/card/assets.js
// 카드 포맷(charx/png/json) 공통 에셋 유틸. 파서들이 같은 asset 모양을 만들고 여기서 매핑/dataURL.
'use strict';

const MIME = { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', avif: 'image/avif', apng: 'image/apng', bmp: 'image/bmp' };

function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return (typeof btoa !== 'undefined') ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64');
}

function base64ToBytes(b64) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function mimeFor(ext) { return MIME[(ext || '').toLowerCase()] || 'application/octet-stream'; }

// 확장자 제거된 베이스 이름.
function baseName(name, ext) {
  let s = name || '';
  if (ext && s.toLowerCase().endsWith('.' + String(ext).toLowerCase())) s = s.slice(0, -(String(ext).length + 1));
  return s;
}

// 에셋 이름에서 감정/짧은 태그 추정 (RisuAI 스프라이트 관례: "<char>.<emotion>.<ext>")
function deriveTag(name, ext) {
  const s = baseName(name, ext);
  const dot = s.indexOf('.');
  return dot >= 0 ? s.slice(dot + 1) : s; // "tarumaemaru.happy" → "happy", "iconx" → "iconx"
}

// ── 카드별 "태그 방식" 자동 감지 ──────────────────────────────────────────────
// 카드마다 에셋 이름 관례가 다름: 점("char.emotion") / 언더스코어("CWU_X_Icon") / 네임스페이스("aoi_angry").
// 베이스 이름 집합에서 지배적 구분자 + 공통 trailing 토큰을 감지해, 깔끔한 짧은 태그를 뽑는다.
const SEPARATORS = ['.', '_', ' ', '-'];
function detectTagScheme(bases) {
  const names = (bases || []).filter((s) => s && s.length);
  if (names.length < 2) return { sep: null, stripTrailing: null };
  let sep = null, best = 0;
  for (const s of SEPARATORS) {
    const c = names.filter((n) => n.includes(s)).length;
    if (c > best) { best = c; sep = s; }
  }
  // 절반 미만만 구분자를 가지면 신뢰 안 함(관례 없음)
  if (!sep || best < Math.max(2, names.length * 0.5)) return { sep: null, stripTrailing: null };
  // "첫 구분자 뒤" 부분들의 마지막 토큰이 전부 같으면 공통 접미사로 간주(예: "_Icon")
  const tails = names.filter((n) => n.includes(sep)).map((n) => n.slice(n.indexOf(sep) + sep.length));
  const lastToks = tails.map((t) => { const i = t.lastIndexOf(sep); return i >= 0 ? t.slice(i + sep.length) : null; });
  let stripTrailing = null;
  if (lastToks.length >= 2 && lastToks.every((t) => t && t === lastToks[0])) stripTrailing = lastToks[0];
  return { sep, stripTrailing };
}
function tagFromScheme(base, scheme) {
  if (!scheme || !scheme.sep || !base.includes(scheme.sep)) return base;
  let tail = base.slice(base.indexOf(scheme.sep) + scheme.sep.length); // 첫 구분자(=네임스페이스/캐릭터) 제거
  if (scheme.stripTrailing) {
    const suffix = scheme.sep + scheme.stripTrailing;
    if (tail.endsWith(suffix)) tail = tail.slice(0, -suffix.length);   // 공통 접미사(_Icon 등) 제거
  }
  return tail || base;
}
// parsed.assets 의 각 tag 를 카드 감지 스킴으로 재계산(아이콘 타입은 이름 유지). parsed.tagScheme 기록.
function applyTagScheme(parsed) {
  const sprites = parsed.assets.filter((a) => a.type !== 'icon');
  const scheme = detectTagScheme(sprites.map((a) => baseName(a.name, a.ext)));
  for (const a of parsed.assets) {
    if (a.type === 'icon') continue;
    a.tag = tagFromScheme(baseName(a.name, a.ext), scheme);
  }
  parsed.tagScheme = scheme;
  return parsed;
}

function assetDataUrl(asset) {
  if (!asset.bytes) return null;
  return `data:${asset.mime};base64,${bytesToBase64(asset.bytes)}`;
}

// 자동 매핑: byName(풀네임, 유일) / aliases(비충돌 감정태그) / collisions(공유 감정태그)
function autoMap(parsed) {
  const byName = {};
  const tagCount = {};
  for (const a of parsed.assets) {
    if (!a.found) continue;
    byName[a.name] = a;
    tagCount[a.tag] = (tagCount[a.tag] || 0) + 1;
  }
  const aliases = {};
  const collisions = [];
  for (const a of parsed.assets) {
    if (!a.found) continue;
    if (tagCount[a.tag] === 1) aliases[a.tag] = a.name;
    else if (!collisions.includes(a.tag)) collisions.push(a.tag);
  }
  return { byName, aliases, collisions };
}

// 이미지 태그 resolver용 매핑: tag → data URL. onlyTags 주면 그 태그만 생성(용량 절약).
function buildImageMappings(parsed, opts = {}) {
  const { includeAliases = true, onlyTags = null } = opts;
  const want = onlyTags ? new Set(onlyTags) : null;
  const map = {};
  const am = autoMap(parsed);
  for (const a of parsed.assets) {
    if (!a.found) continue;
    if (!want || want.has(a.name)) map[a.name] = assetDataUrl(a);
  }
  if (includeAliases) {
    for (const [tag, name] of Object.entries(am.aliases)) {
      if (want && !want.has(tag)) continue;
      const a = am.byName[name];
      if (a && a.found) map[tag] = assetDataUrl(a);
    }
  }
  return map;
}

module.exports = { MIME, mimeFor, bytesToBase64, base64ToBytes, baseName, deriveTag, detectTagScheme, tagFromScheme, applyTagScheme, assetDataUrl, autoMap, buildImageMappings };
