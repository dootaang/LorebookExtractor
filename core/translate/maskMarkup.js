// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 dootaang — LogPapa. Licensed under GNU GPL v3 (see LICENSE).
// core/translate/maskMarkup.js — 번역 보존용 마크업 마스킹(순수).
//
// 로그엔 산문(번역 대상)과 구조 토큰(절대 건드리면 안 되는 것)이 섞여 있다. 그냥 모델에 던지면
// {{img::happy}}의 happy를 번역하거나 <img> 태그를 망가뜨린다. → 구조 토큰을 placeholder로 가리고
// 산문만 보낸 뒤 복원한다(formatConversation의 maskHtml과 같은 idiom).
//
// 가리는 것: html 태그 런 · {{...}} CBS/이미지 토큰 · [접두사|이름] 에셋 마커.
// 가리지 않는 것: 대사/속마음 따옴표("' '), 별표(*) — 산문의 일부라 모델이 번역·보존(시스템 프롬프트로 지시).
// placeholder = ⟦n⟧ (U+27E6/U+27E7) — LLM이 건드리기 어려운 희귀 괄호 + 숫자. 복원은 관대(공백 변형 허용).
'use strict';

const TAG_RUN = /<[^>]*>(?:\s*<[^>]*>)*/g;     // <div><img>… 연속 태그를 한 단위로(개행 포함)
const CBS = /\{\{[^{}]*\}\}/g;                  // {{img::happy}} {{user}} {{raw::...}} 등
const ASSET = /\[[^\[\]\n]*\|[^\[\]\n]*\]/g;    // [🌠|tarumaemaru.happy] RisuAI 에셋 마커

const OPEN = '⟦', CLOSE = '⟧';        // ⟦ ⟧
const PLACEHOLDER = /⟦\s*(\d+)\s*⟧/g;

// 구조 토큰을 ⟦n⟧으로 가린다. 반환 { masked, tokens }(tokens[i]=원래 문자열).
function maskMarkup(text) {
  const tokens = [];
  const stash = (m) => { const i = tokens.length; tokens.push(m); return OPEN + i + CLOSE; };
  let s = String(text == null ? '' : text);
  s = s.replace(TAG_RUN, stash).replace(CBS, stash).replace(ASSET, stash);  // 태그 먼저(안에 {{}}·[|] 흡수)
  return { masked: s, tokens };
}

// ⟦n⟧을 원래 토큰으로 복원. 모델이 placeholder 주변에 공백을 넣어도 관대하게 매칭. 범위 밖 번호는 그대로 둠.
function unmaskMarkup(masked, tokens) {
  return String(masked == null ? '' : masked).replace(PLACEHOLDER, (full, n) => {
    const i = +n;
    return (i >= 0 && i < tokens.length) ? tokens[i] : full;
  });
}

// 마스킹 후 "번역할 산문"이 남았는지(placeholder·공백만이면 false → API 호출 스킵, 순수 이미지 블록).
function hasProse(masked) {
  return /\S/.test(String(masked == null ? '' : masked).replace(PLACEHOLDER, ' '));
}

// placeholder를 공백으로 — 한글 비율 판정은 "마스킹 후 산문"에만(태그/마커가 비율을 오염시키지 않게).
function stripPlaceholders(masked) { return String(masked == null ? '' : masked).replace(PLACEHOLDER, ' '); }

// 한글이 우세한가(=이미 한국어 → 재번역 스킵, 비용 절약). 한글 vs (가나+한자+라틴) 비율.
//   threshold(기본 0.5) 이상이면 true. 글자 자체가 없으면 false(상위 hasProse가 거름).
function isKoreanDominant(text, threshold) {
  const s = String(text == null ? '' : text);
  const hangul = (s.match(/[가-힣ᄀ-ᇿ㄰-㆏]/g) || []).length;   // 음절+자모
  const kana = (s.match(/[぀-ヿㇰ-ㇿ]/g) || []).length;                  // 히라/가타카나
  const han = (s.match(/[㐀-鿿豈-﫿]/g) || []).length;                    // 한자(일/중)
  const latin = (s.match(/[A-Za-z]/g) || []).length;
  const foreign = kana + han + latin;
  if (hangul + foreign === 0) return false;
  const th = (typeof threshold === 'number') ? threshold : 0.5;
  return hangul / (hangul + foreign) >= th;
}

module.exports = { maskMarkup, unmaskMarkup, hasProse, stripPlaceholders, isKoreanDominant };
