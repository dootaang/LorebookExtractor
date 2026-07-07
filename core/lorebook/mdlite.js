// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 dootaang — 로어북 추출기 (Lorebook Extractor). Licensed under GNU GPL v3 (see LICENSE).
// core/lorebook/mdlite.js — 표시 전용 미니 마크다운 렌더러(안전·순수).
//
// 로어북 본문은 마크다운 관례(###, **, 리스트)로 쓰인 경우가 많은데 날것으로 보여주면 읽기 최악.
// 신뢰할 수 없는 입력이므로: ①원문을 먼저 전부 HTML 이스케이프 ②우리 변환만 화이트리스트 태그를 생성
//   (h3~h5, p, ul/ol/li, blockquote, strong, em, code, hr, br) — 입력의 태그·스크립트는 절대 살아남지 못함.
// 표시 전용: 내보내기·번역 데이터는 이 모듈을 거치지 않는다(원본 보존 원칙).
'use strict';

const escapeHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// 인라인: **굵게** → strong, *기울임* → em, `코드` → code. 이스케이프 이후에 적용(양끝 비공백 쌍만 — 오변환 방지).
function inline(escaped) {
  let t = escaped;
  t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*(\S(?:[^*\n]*\S)?)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\*(\S(?:[^*\n]*\S)?)\*/g, '<em>$1</em>');
  t = t.replace(/__(\S(?:[^_\n]*\S)?)__/g, '<strong>$1</strong>');
  return t;
}

// 블록 단위 파서(줄 기반·재귀 없음). 반환 = 안전 HTML 문자열.
function renderMdLite(text) {
  const lines = String(text == null ? '' : text).split('\n');
  const out = [];
  let para = [];   // 이어지는 일반 줄 = 한 문단(줄바꿈은 <br>)
  let list = null; // { tag: 'ul'|'ol', items: [] }
  const flushPara = () => { if (para.length) { out.push('<p>' + para.map(inline).join('<br>') + '</p>'); para = []; } };
  const flushList = () => { if (list) { out.push('<' + list.tag + '>' + list.items.map((i) => '<li>' + inline(i) + '</li>').join('') + '</' + list.tag + '>'); list = null; } };
  const flush = () => { flushPara(); flushList(); };

  for (const rawLine of lines) {
    const line = escapeHtml(rawLine);
    const t = line.trim();
    if (!t) { flush(); continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(t);
    if (h) { flush(); const lv = Math.min(3 + Math.max(0, h[1].length - 1), 5); out.push(`<h${lv}>` + inline(h[2]) + `</h${lv}>`); continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flush(); out.push('<hr>'); continue; }
    const q = /^&gt;\s?(.*)$/.exec(t);
    if (q) { flush(); out.push('<blockquote>' + inline(q[1]) + '</blockquote>'); continue; }
    const ul = /^[-*•]\s+(.*)$/.exec(t);
    if (ul) { flushPara(); if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; } list.items.push(ul[1]); continue; }
    const ol = /^\d{1,3}[.)]\s+(.*)$/.exec(t);
    if (ol) { flushPara(); if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; } list.items.push(ol[1]); continue; }
    flushList();
    para.push(line);
  }
  flush();
  return out.join('\n');
}

module.exports = { renderMdLite, escapeHtml };
