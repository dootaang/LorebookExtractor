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

// ── 한글 → 로마자(유사도 비교용 간이 표기) ─────────────────────────────────
//   목적은 정확한 표준 로마자가 아니라 "Arvan ↔ 아르반" 같은 음차 쌍의 근접 판정.
const CHO = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h'];
const JUNG = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i'];
const JONG = ['', 'g', 'kk', 'gs', 'n', 'nj', 'nh', 'd', 'l', 'lg', 'lm', 'lb', 'ls', 'lt', 'lp', 'lh', 'm', 'b', 'bs', 's', 'ss', 'ng', 'j', 'ch', 'k', 't', 'p', 'h'];
function hangulToRoman(str) {
  let out = '';
  for (const ch of S(str)) {
    const c = ch.codePointAt(0);
    if (c >= 0xac00 && c <= 0xd7a3) {
      const i = c - 0xac00;
      out += CHO[Math.floor(i / 588)] + JUNG[Math.floor((i % 588) / 28)] + JONG[i % 28];
    } else if (/[a-z0-9]/i.test(ch)) out += ch.toLowerCase();
  }
  return out;
}
const normLatin = (t) => S(t).toLowerCase().replace(/[^a-z0-9]/g, '');
// 음차 등가 자음(한글 로마자에 없는 라틴 자음을 근사) — 비교 전용.
const latinFold = (t) => t.replace(/v/g, 'b').replace(/f/g, 'p').replace(/l/g, 'r').replace(/c/g, 'k');
const stripSymbols = (t) => S(t).replace(/^[^0-9A-Za-z가-힯]+/, '').replace(/[^0-9A-Za-z가-힯)]+$/, '').trim();   // ♂️/♀️/💎 등 장식 제거
function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (!m || !n) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
// 음차 근접 점수(낮을수록 가까움). 포함 관계(은하 ⊆ 성은하)는 강한 신호. 라틴 등가 접기도 함께 시도.
function romanScore(latin, hangul) {
  const b = hangulToRoman(hangul);
  if (!b) return 1;
  let best = 1;
  for (const a of new Set([normLatin(latin), latinFold(normLatin(latin))])) {
    if (!a) continue;
    // 포함(은하⊆성은하)=강한 신호 — 단 길이 차에 비례해 약화(Sung Eun-ha는 은하보다 성은하가 이겨야).
    if (a.length >= 4 && (b.includes(a) || a.includes(b))) best = Math.min(best, Math.max(0.05, 0.5 * Math.abs(a.length - b.length) / Math.max(a.length, b.length)));
    best = Math.min(best, editDistance(a, b) / Math.max(a.length, b.length));              // 완전 일치=0이 최우선
  }
  return best;
}
const PAIR_THRESHOLD = 0.34;   // 이보다 멀면 짝 안 지음(보수적 — 틀린 짝보다 빈칸이 낫다, 빈칸은 LLM 채움)

// 엔트리들 → 용어 행 [{ term, ko, source, auto }] (term=비한글 표기, ko=한글 표기|'').
//   ★짝짓기 = 로마자 유사도 게이트: 같은 엔트리의 한글 후보들 중 음차로 가장 가까운 것만,
//   그것도 문턱 안일 때만 짝. (예전 "엔트리 대표 한글에 전부 몰아주기"는 연동 키 봇에서
//   Demon King=아르반 같은 오짝을 양산했음 — 확신 없으면 빈칸으로 두고 LLM 채움이 정답.)
//   같은 term(대소문자 무시)은 전체에서 1회 — 더 가까운 짝 우선.
function extractGlossary(entries) {
  const rows = [];
  const byTerm = new Map();   // lower(term) → row(+_score)
  for (const e of entries || []) {
    if (!e || e.isFolder) continue;
    const cands = [S(e.name), ...(e.keys || []).map(S), ...(e.secondaryKeys || []).map(S)].map(stripSymbols).filter(usable);
    if (!cands.length) continue;
    const hangul = [...new Set(cands.filter((t) => HANGUL.test(t)))];
    const others = [...new Set(cands.filter((t) => !HANGUL.test(t)))];
    const source = stripSymbols(e.name) || (e.keys && e.keys[0]) || '';
    for (const t of others) {
      let best = '', bestScore = 1;
      for (const h of hangul) {
        const sc = romanScore(t, h);
        if (sc < bestScore) { bestScore = sc; best = h; }
      }
      const paired = bestScore <= PAIR_THRESHOLD;
      const row = { term: t, ko: paired ? best : '', source, auto: paired, _score: paired ? bestScore : 1 };
      const k = t.toLowerCase();
      const prev = byTerm.get(k);
      if (!prev) { byTerm.set(k, row); rows.push(row); }
      else if (row._score < (prev._score != null ? prev._score : 1)) { prev.ko = row.ko; prev.auto = row.auto; prev.source = row.source; prev._score = row._score; }
    }
  }
  for (const r of rows) delete r._score;
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
