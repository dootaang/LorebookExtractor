// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 dootaang — 로어북 추출기 (Lorebook Extractor). Licensed under GNU GPL v3 (see LICENSE).
// core/lorebook/glossary.js — 로어북에서 번역 용어집(고유명사 표기 쌍) 추출(순수·node 테스트 가능).
//
// 왜: 채팅 번역(리스 번역·기가트랜스)의 최대 품질 문제 = 고유명사 표기 흔들림(Eun-ha/은하/은하가 섞임).
//   로어북은 그 봇의 고유명사 사전이고, 발동 키에 다국어 변형이 이미 들어 있는 경우가 많다
//   (키: "은하, 성은하, Eun-ha, Sung Eun-ha") → ★엔트리 안에서 한글 후보와 비한글 후보를 짝지으면
//   LLM 없이 결정론으로 상당수 쌍이 나온다. 못 짝지은 항목만 선택적으로 LLM 채움(웹 쪽).
// 출력 = 리스/기가트랜스 번역 프롬프트에 그대로 붙여넣는 텍스트(buildGlossaryText).
'use strict';

const HANGUL = /[가-힯]/;
const S = (v) => String(v == null ? '' : v).trim();

// 용어 후보로 쓸만한가 — 지나치게 짧거나(오발) 길거나(문장) 정규식스러운 것 제외.
function usable(term) {
  const t = S(term);
  if (t.length < 2 || t.length > 40) return false;
  if (/[\\^$*+?()[\]{}|]/.test(t)) return false;   // 정규식 패턴류
  return true;
}

// 엔트리들 → 용어 행 [{ term, ko, source, auto }] (term=비한글 표기, ko=한글 표기|'' , auto=결정론 짝).
//   같은 term(대소문자 무시)은 전체에서 1회 — ko 있는 쪽 우선.
function extractGlossary(entries) {
  const rows = [];
  const byTerm = new Map();   // lower(term) → row
  for (const e of entries || []) {
    if (!e || e.isFolder) continue;
    const cands = [S(e.name), ...(e.keys || []).map(S), ...(e.secondaryKeys || []).map(S)].filter(usable);
    if (!cands.length) continue;
    const hangul = cands.filter((t) => HANGUL.test(t));
    const others = cands.filter((t) => !HANGUL.test(t));
    // 한글 대표 표기: 엔트리 이름이 한글이면 그것(사람이 고른 라벨), 아니면 첫 한글 키.
    const ko = HANGUL.test(S(e.name)) && usable(e.name) ? S(e.name) : (hangul[0] || '');
    for (const t of others) {
      const k = t.toLowerCase();
      const row = { term: t, ko, source: S(e.name) || (e.keys && e.keys[0]) || '', auto: !!ko };
      const prev = byTerm.get(k);
      if (!prev) { byTerm.set(k, row); rows.push(row); }
      else if (!prev.ko && ko) { prev.ko = ko; prev.auto = true; prev.source = row.source; }   // 더 좋은 정보로 승급
    }
  }
  return rows;
}

// 프롬프트용 텍스트 — 리스 번역 프롬프트/기가트랜스 사용자 프롬프트에 그대로 붙여넣는 형태.
//   빈 번역(ko 없음)은 제외(모델에 혼란만 줌).
function buildGlossaryText(rows, opts = {}) {
  const pairs = (rows || []).filter((r) => r && r.term && r.ko);
  if (!pairs.length) return '';
  const head = opts.header != null ? opts.header : '[번역 용어집] 아래 고유명사는 반드시 이 표기를 따르세요:';
  return head + '\n' + pairs.map((r) => `${r.term} = ${r.ko}`).join('\n');
}

module.exports = { extractGlossary, buildGlossaryText };
