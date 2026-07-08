// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 dootaang — 로어북 추출기 (Lorebook Extractor). Licensed under GNU GPL v3 (see LICENSE).
// core/lorebook/normalize.js — 카드/모듈의 로어북을 통일 스키마로 정규화 + 내보내기 빌더(순수·node 테스트 가능).
//
// 입력 = parseCard(core/card) 결과의 card 객체. 두 스키마를 하나로:
//   ① CCv3/CCv2 봇카드(charx/png/jpeg/json): card.data.character_book.entries — keys[]·content·enabled·
//      constant·insertion_order·secondary_keys[]·selective·position, 본문에 @@데코레이터 라인 가능.
//   ② 리스 모듈(.risum): card.module.lorebook — key(쉼표 문자열)·comment·content·mode(folder 등)·
//      alwaysActive·secondkey·selective·useRegex·insertorder·folder(폴더 그룹핑).
// 통일 엔트리 = { uid, name, keys[], secondaryKeys[], content, enabled, constant, selective, useRegex,
//                 order, position, folder, isFolder, raw } — raw는 원본 보존(내보내기 왕복).
'use strict';

const S = (v) => String(v == null ? '' : v);
const splitKeys = (s) => S(s).split(',').map((x) => x.trim()).filter(Boolean);

function normCCv3Entry(e, i) {
  e = e || {};
  return {
    uid: 'e' + i,
    name: S(e.comment || e.name),
    keys: Array.isArray(e.keys) ? e.keys.map(S).filter(Boolean) : splitKeys(e.keys),
    secondaryKeys: Array.isArray(e.secondary_keys) ? e.secondary_keys.map(S).filter(Boolean) : [],
    content: S(e.content),
    enabled: e.enabled !== false,
    constant: !!e.constant,
    selective: !!e.selective,
    useRegex: !!(e.extensions && (e.extensions.useRegex || e.extensions.risu_useRegex)),
    order: typeof e.insertion_order === 'number' ? e.insertion_order : i,
    position: S(e.position),
    folder: '',
    isFolder: false,
    raw: e,
  };
}

function normRisuEntry(e, i) {
  e = e || {};
  return {
    uid: 'e' + i,
    name: S(e.comment),
    keys: splitKeys(e.key),
    secondaryKeys: e.selective ? splitKeys(e.secondkey) : [],
    content: S(e.content),
    enabled: e.enabled !== false,                    // 리스 내부엔 보통 없음 → 기본 활성
    constant: !!e.alwaysActive,
    selective: !!e.selective,
    useRegex: !!e.useRegex,
    order: typeof e.insertorder === 'number' ? e.insertorder : i,
    position: '',
    folder: S(e.folder),
    isFolder: e.mode === 'folder',
    raw: e,
  };
}

// parseCard 결과 → { kind, bookName, entries } | null(로어북 없음).
//   kind = 'card'(CCv3/CCv2 character_book) | 'module'(리스 모듈 lorebook)
function extractLorebook(card) {
  if (!card || typeof card !== 'object') return null;
  if (Array.isArray(card)) {
    return { kind: 'risu-export', bookName: 'RisuAI Lorebook', entries: card.map(normRisuEntry) };
  }
  if (card.type === 'risu' && Array.isArray(card.data)) {
    return {
      kind: 'risu-export',
      bookName: S(card.name || card.title || 'RisuAI Lorebook'),
      entries: card.data.map(normRisuEntry),
    };
  }
  const data = card.data && typeof card.data === 'object' ? card.data : card;   // CCv2 구형은 최상위에 올 수도
  const book = data.character_book;
  if (book && Array.isArray(book.entries)) {
    return {
      kind: 'card',
      bookName: S(book.name || (data.name || card.name)),
      scanDepth: book.scan_depth, tokenBudget: book.token_budget, recursive: !!book.recursive_scanning,
      entries: book.entries.map(normCCv3Entry),
    };
  }
  const mod = card.module && typeof card.module === 'object' ? card.module : card;
  if (Array.isArray(mod.lorebook)) {
    return { kind: 'module', bookName: S(mod.name || card.name), entries: mod.lorebook.map(normRisuEntry) };
  }
  return null;
}

// CCv3 데코레이터 분리: 본문 앞머리의 연속 @@라인(@@depth 4, @@role assistant …)을 칩으로 표시하기 위함.
//   @@@ 로 시작하는 줄은 이스케이프(데코레이터 아님) → 본문에 남김. 반환 { decorators: [], body }.
function splitDecorators(content) {
  const lines = S(content).split('\n');
  const decorators = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('@@') && !t.startsWith('@@@')) { decorators.push(t); continue; }
    if (t === '' && decorators.length && i + 1 < lines.length && lines[i + 1].trim().startsWith('@@')) continue;   // 데코레이터 사이 빈 줄 관대
    break;
  }
  return { decorators, body: lines.slice(i).join('\n') };
}

// 폴더 그룹핑(리스 모듈): isFolder 엔트리 = 폴더 정의, 일반 엔트리의 folder 문자열이 참조.
//   폴더 이름 매칭은 관대(폴더 엔트리의 raw.key / raw.id / name 중 일치). 반환 = [{ folder: 엔트리|null(루트), items }].
function groupByFolder(entries) {
  const folders = entries.filter((e) => e.isFolder);
  const findFolder = (ref) => folders.find((f) => f.raw.id === ref || f.raw.key === ref || f.name === ref) || null;
  const groups = [];
  const groupOf = new Map();
  const rootItems = [];
  for (const e of entries) {
    if (e.isFolder) continue;
    const f = e.folder ? findFolder(e.folder) : null;
    if (!f) { rootItems.push(e); continue; }
    if (!groupOf.has(f)) { const g = { folder: f, items: [] }; groupOf.set(f, g); groups.push(g); }
    groupOf.get(f).items.push(e);
  }
  const out = [];
  if (rootItems.length) out.push({ folder: null, items: rootItems });
  return out.concat(groups);
}

// 요약 통계.
function loreStats(entries) {
  const real = entries.filter((e) => !e.isFolder);
  return {
    total: real.length,
    constant: real.filter((e) => e.constant).length,
    disabled: real.filter((e) => !e.enabled).length,
    chars: real.reduce((n, e) => n + e.content.length, 0),
  };
}

// ── 내보내기 빌더 ──────────────────────────────────────────────────────────
// tr: uid → { name?, content? } 번역 맵(없으면 원문). nameMode: 'tr'|'orig'(번역 반영 시 이름 처리).
// keyAdd: uid → string[] — "발동 키 다국어 무장"이 추가한 번역 키(★원본 키는 절대 대체 안 함, 뒤에 덧붙임+중복 제거).
const pick = (tr, e, nameMode) => ({
  name: (tr && tr[e.uid] && tr[e.uid].name != null && nameMode !== 'orig') ? tr[e.uid].name : e.name,
  content: (tr && tr[e.uid] && tr[e.uid].content != null) ? tr[e.uid].content : e.content,
});
function mergedKeys(e, keyAdd) {
  const extra = keyAdd && Array.isArray(keyAdd[e.uid]) ? keyAdd[e.uid] : [];
  if (!extra.length) return e.keys.slice();
  const seen = new Set(e.keys.map((k) => k.toLowerCase()));
  const out = e.keys.slice();
  for (const k of extra) { const l = String(k).trim(); if (!l || seen.has(l.toLowerCase())) continue; seen.add(l.toLowerCase()); out.push(l); }
  return out;
}

// CCv3 character_book JSON(리스에 도로 넣을 수 있는 표준). 키·발동 설정은 원문 유지(무장 키는 "추가"만).
function buildCharacterBook(lore, tr, nameMode, keyAdd) {
  const entries = lore.entries.filter((e) => !e.isFolder).map((e, i) => {
    const v = pick(tr, e, nameMode);
    return {
      keys: mergedKeys(e, keyAdd),
      secondary_keys: e.secondaryKeys.slice(),
      comment: v.name,
      content: v.content,
      enabled: e.enabled,
      constant: e.constant,
      selective: e.selective,
      insertion_order: e.order != null ? e.order : i,
      ...(e.position ? { position: e.position } : {}),
      ...(e.useRegex ? { extensions: { risu_useRegex: true } } : {}),
    };
  });
  return {
    spec: 'lorebook_v3',
    data: {
      name: lore.bookName || '',
      ...(lore.scanDepth != null ? { scan_depth: Number(lore.scanDepth) } : {}),
      ...(lore.tokenBudget != null ? { token_budget: Number(lore.tokenBudget) } : {}),
      ...(lore.recursive ? { recursive_scanning: true } : {}),
      entries,
    },
  };
}

// 읽기·공유용 Markdown.
function buildMarkdown(lore, tr, nameMode, keyAdd) {
  const out = [`# ${lore.bookName || '로어북'}`, ''];
  const st = loreStats(lore.entries);
  out.push(`> 엔트리 ${st.total}개 · 언제나 활성화 ${st.constant}개 · 약 ${Math.round(st.chars / 1000)}천 글자`, '');
  for (const g of groupByFolder(lore.entries)) {
    if (g.folder) out.push(`## 📁 ${g.folder.name || '(폴더)'}`, '');
    for (const e of g.items) {
      const v = pick(tr, e, nameMode);
      const flags = [e.constant ? '언제나 활성화' : '', e.enabled ? '' : '비활성', e.selective ? '멀티플 키' : '', e.useRegex ? '정규식' : ''].filter(Boolean);
      out.push(`### ${v.name || e.keys[0] || '(이름 없음)'}`);
      if (e.keys.length) out.push(`- 활성화 키: ${e.keys.join(', ')}`);
      const extra = keyAdd && Array.isArray(keyAdd[e.uid]) ? keyAdd[e.uid] : [];
      if (extra.length) out.push(`- 추가 활성화 키: ${extra.join(', ')}`);
      if (e.secondaryKeys.length) out.push(`- 두번째 키: ${e.secondaryKeys.join(', ')}`);
      if (flags.length) out.push(`- 속성: ${flags.join(' · ')}`);
      out.push('', v.content, '');
    }
  }
  return out.join('\n');
}

module.exports = { extractLorebook, splitDecorators, groupByFolder, loreStats, buildCharacterBook, buildMarkdown, mergedKeys };
