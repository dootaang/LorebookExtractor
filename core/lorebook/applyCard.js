// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 dootaang — 로어북 추출기 (Lorebook Extractor). Licensed under GNU GPL v3 (see LICENSE).
// core/lorebook/applyCard.js — 최종 표시본(편집·번역·추가 키 병합 완료된 통일 엔트리)을 원본 카드 JSON에 적용.
//
// ★원칙: 엔트리는 원본 raw를 복제해 바뀐 필드만 덮어씀 — 우리가 모르는 확장 필드까지 보존(왕복 무손실).
//   새 엔트리(raw 없음)는 포맷에 맞는 최소 형태로 생성. 로어북 밖의 카드 필드는 일절 안 건드림.
'use strict';

const clone = (o) => JSON.parse(JSON.stringify(o));

// 통일 엔트리 → CCv3 character_book 엔트리(raw 보존 병합).
function ccv3Entry(e, i) {
  const raw = e.raw ? clone(e.raw) : {};
  raw.keys = e.keys.slice();
  raw.secondary_keys = e.secondaryKeys.slice();
  raw.comment = e.name;
  if (raw.name != null) raw.name = e.name;
  raw.content = e.content;
  raw.enabled = e.enabled !== false;
  raw.constant = !!e.constant;
  raw.selective = !!e.selective;
  raw.insertion_order = e.order != null ? e.order : i;
  if (e.useRegex) { raw.extensions = raw.extensions || {}; raw.extensions.risu_useRegex = true; }
  return raw;
}

// 통일 엔트리 → 리스 내부 lorebook 엔트리(raw 보존 병합). 폴더 엔트리는 raw 그대로 통과.
function risuEntry(e, i) {
  if (e.isFolder && e.raw) return clone(e.raw);
  const raw = e.raw ? clone(e.raw) : { mode: 'normal' };
  raw.key = e.keys.join(', ');
  raw.secondkey = e.secondaryKeys.join(', ');
  raw.comment = e.name;
  raw.content = e.content;
  raw.alwaysActive = !!e.constant;
  raw.selective = !!e.selective;
  raw.useRegex = !!e.useRegex;
  raw.insertorder = e.order != null ? e.order : i;
  if (e.folder) raw.folder = e.folder;
  return raw;
}

// card(parseCard 결과의 card 객체) + kind(extractLorebook의 kind) + 최종 엔트리들 → 새 카드 JSON 문자열.
//   entries에는 폴더 엔트리 포함(모듈 폴더 보존). CCv3는 폴더 개념이 없어 비폴더만.
function applyLorebookToCard(card, kind, entries) {
  const c = clone(card);
  if (kind === 'card') {
    const data = c.data && typeof c.data === 'object' ? c.data : c;
    if (!data.character_book || typeof data.character_book !== 'object') data.character_book = { entries: [] };
    data.character_book.entries = entries.filter((e) => !e.isFolder).map(ccv3Entry);
  } else if (kind === 'module') {
    const mod = c.module && typeof c.module === 'object' ? c.module : c;
    mod.lorebook = entries.map(risuEntry);
  } else if (kind === 'risu-export') {
    if (Array.isArray(c)) return JSON.stringify(entries.map(risuEntry));
    c.data = entries.map(risuEntry);
  } else {
    throw new Error('알 수 없는 로어북 종류: ' + kind);
  }
  return JSON.stringify(c);
}

module.exports = { applyLorebookToCard, ccv3Entry, risuEntry };
