// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 dootaang — LogPapa. Licensed under GNU GPL v3 (see LICENSE).
// core/translate/translateLog.js — 로그 번역 오케스트레이션(순수, 어댑터 주입).
//
// 실제 번역(LLM 호출)은 코어에 두지 않는다 — translateFn으로 주입한다(데스크탑 메인 프로세스가 BYO-key로 호출).
// 코어는 "마크업 보존 마스킹 + 블록 단위 + 부분 실패 격리"만 책임진다(순수·이식 가능·node 테스트 가능).
// ★코어 파이프라인의 무LLM 원칙은 그대로 — 이건 데스크탑 전용 선택적 전처리이지 변환 엔진이 아님.
'use strict';
const { maskMarkup, unmaskMarkup, hasProse, stripPlaceholders, isKoreanDominant } = require('./maskMarkup.js');

// 한 텍스트를 번역. translateFn(maskedProse, ctx) => Promise<string>(번역된 마스킹 텍스트).
// 구조 토큰은 마스킹돼 모델이 못 건드리고, 복원 후 그대로. 산문 없으면 원문 그대로(호출 0회).
async function translateText(text, translateFn, ctx) {
  const src = String(text == null ? '' : text);
  if (!src.trim()) return src;
  const { masked, tokens } = maskMarkup(src);
  if (!hasProse(masked)) return src;          // 이미지/태그뿐 → 번역 불필요
  const out = await translateFn(masked, ctx || {});
  return unmaskMarkup(String(out == null ? masked : out), tokens);
}

// 여러 블록(문단/메시지)을 순차 번역. 순차 = 레이트리밋·순서 보존.
// opts: { onProgress(done,total), skipKorean(이미 한국어면 호출 0·비용 절약), koreanThreshold=0.5 }.
// 부분 실패 격리 — 실패 블록은 원문 유지 + failed 기록(로그 안 깨짐).
// ★진행률(onProgress) 분모 = 진짜 API로 보낼 블록 수 — 스킵(빈칸·이미지뿐·한국어)은 집계에서 제외.
//   스킵을 즉시 tick하면 재번역 때 "(30/40)에서 시작"하는 착시가 생겼음(분류 루프는 순식간이라 화면엔 30부터 보임).
// 반환 { blocks:[새 텍스트…], translated(번역됨), skipped(한국어라 스킵), failed:[{index,error}] }.
async function translateBlocks(blocks, translateFn, opts) {
  opts = opts || {};
  const skipKorean = !!opts.skipKorean;
  const threshold = typeof opts.koreanThreshold === 'number' ? opts.koreanThreshold : 0.5;
  const src = Array.isArray(blocks) ? blocks : [];
  if (opts.combine) return await translateCombined(src, translateFn, opts, skipKorean, threshold);
  const out = src.slice();
  const failed = [];
  let translated = 0, skipped = 0, done = 0;
  // 1) 분류(호출 0·즉시): 번역 대상만 추림. 스킵분은 진행률에 안 들어감.
  const pending = [];
  for (let i = 0; i < src.length; i++) {
    const text = String(src[i] == null ? '' : src[i]);
    const { masked, tokens } = maskMarkup(text);
    if (!text.trim() || !hasProse(masked)) { out[i] = src[i]; continue; }           // 산문 없음 → 그대로(호출 0)
    if (skipKorean && isKoreanDominant(stripPlaceholders(masked), threshold)) { out[i] = src[i]; skipped++; continue; }  // 이미 한국어 → 스킵
    pending.push({ i, masked, tokens });
  }
  const tick = () => { done++; if (typeof opts.onProgress === 'function') opts.onProgress(done, pending.length); };
  // 2) 순차 번역(원래 순서 유지).
  for (const p of pending) {
    try {
      const o = await translateFn(p.masked, { index: p.i, maxResponse: opts.maxResponse });
      out[p.i] = unmaskMarkup(String(o == null ? p.masked : o), p.tokens);
      if (out[p.i] !== src[p.i]) translated++;
    } catch (e) { failed.push({ index: p.i, error: (e && e.message) || String(e) }); out[p.i] = src[p.i]; }
    tick();
  }
  return { blocks: out, translated, skipped, failed };
}

// 결합 구분자(RisuAI combineTranslation 이식). ★maskMarkup의 ⟦n⟧(숫자만)과 충돌 안 함 — 이중 괄호+문자.
//   모델엔 "이 구분선은 그대로 두고 각 구역만 번역, 합치거나 빼지 말 것"을 시스템 프롬프트로 지시(어댑터/providers).
const SEG = '\n⟦⟦SEG⟧⟧\n';
const SEG_RE = /\n?⟦\s*⟦\s*SEG\s*⟧\s*⟧\n?/;   // 응답 재분해(모델이 주변 공백을 넣어도 관대)

// 여러 블록을 토큰 예산 내 배치로 묶어 한 번에 번역(문맥 공유·호출/비용 절감).
// 안전장치: 반환 구역 수 ≠ 보낸 수(모델 합침/누락)거나 호출 실패면 그 배치만 순차(per-block) 폴백 → 로그 안 깨짐.
async function translateCombined(src, translateFn, opts, skipKorean, threshold) {
  const out = src.slice();
  const failed = [];
  let translated = 0, skipped = 0, done = 0;
  // 1) 분류: 번역 대상만 추림(산문 없음·한국어는 현행대로 스킵·호출 0).
  //   ★스킵은 tick 안 함 — 진행률 분모 = pending(진짜 API 대상)만. "(30/40) 시작" 착시 제거.
  const pending = [];
  for (let i = 0; i < src.length; i++) {
    const text = String(src[i] == null ? '' : src[i]);
    const { masked, tokens } = maskMarkup(text);
    if (!text.trim() || !hasProse(masked)) { out[i] = src[i]; continue; }
    if (skipKorean && isKoreanDominant(stripPlaceholders(masked), threshold)) { out[i] = src[i]; skipped++; continue; }
    pending.push({ i, masked, tokens });
  }
  const total = pending.length;
  const tick = () => { done++; if (typeof opts.onProgress === 'function') opts.onProgress(Math.min(done, total), total); };
  // 2) 토큰 예산(글자수 추정)·개수 상한으로 배치. 큰 블록은 단독.
  const maxChars = typeof opts.batchChars === 'number' ? opts.batchChars : 4000;
  const maxCount = typeof opts.batchCount === 'number' ? opts.batchCount : 20;
  const batches = [];
  let cur = [], curLen = 0;
  for (const p of pending) {
    const len = p.masked.length;
    if (len >= maxChars) { if (cur.length) { batches.push(cur); cur = []; curLen = 0; } batches.push([p]); continue; }   // 큰 블록 단독
    if (cur.length && (curLen + len > maxChars || cur.length >= maxCount)) { batches.push(cur); cur = []; curLen = 0; }
    cur.push(p); curLen += len;
  }
  if (cur.length) batches.push(cur);
  // per-block 번역(단독·폴백 공용). ★maxResponse도 전달 — 제일 긴 블록(단독)이 제일 작은 응답 상한을 받던 것 수정.
  const translateOne = async (p) => {
    try { const o = await translateFn(p.masked, { index: p.i, maxResponse: opts.maxResponse }); out[p.i] = unmaskMarkup(String(o == null ? p.masked : o), p.tokens); if (out[p.i] !== src[p.i]) translated++; }
    catch (e) { failed.push({ index: p.i, error: (e && e.message) || String(e) }); out[p.i] = src[p.i]; }
    tick();
  };
  const fallbackBatch = async (batch) => { for (const p of batch) await translateOne(p); };   // 그 배치만 격리
  // 3) 배치 처리.
  for (const batch of batches) {
    if (batch.length === 1) { await translateOne(batch[0]); continue; }   // 단독은 그냥 per-block
    const combined = batch.map((p) => p.masked).join(SEG);
    let resp;
    try { resp = await translateFn(combined, { combine: true, segments: batch.length, maxResponse: opts.maxResponse }); }
    catch (e) { await fallbackBatch(batch); continue; }   // 호출 실패 → 그 배치만 순차
    const parts = String(resp == null ? '' : resp).split(SEG_RE);
    if (parts.length !== batch.length) { await fallbackBatch(batch); continue; }   // ★구역 수 불일치(합침/누락/잘림) → 순차 폴백
    for (let k = 0; k < batch.length; k++) {
      const p = batch[k];
      out[p.i] = unmaskMarkup(parts[k], p.tokens);   // 각 블록 자기 tokens로 복원
      if (out[p.i] !== src[p.i]) translated++;
      tick();
    }
  }
  return { blocks: out, translated, skipped, failed };
}

module.exports = { translateText, translateBlocks, translateCombined, maskMarkup, unmaskMarkup, hasProse, isKoreanDominant };
