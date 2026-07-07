// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 dootaang — LogPapa. Licensed under GNU GPL v3 (see LICENSE).
// core/translate/providers.js — 번역 provider 요청 빌더 (★브라우저-안전: Node/Electron import 절대 금지).
//
// 데스크탑(electron/llm.js, 메인 net.fetch)과 웹(web/src/webLlm.ts, 브라우저 fetch)이 함께 쓴다.
// 여기선 요청을 "만들기만"(url/headers/body) 하고 실제 fetch는 각 플랫폼이 한다 → provider 로직 1벌 공유.
//   provider 비종속: 대부분 OpenAI 호환(/chat/completions), Anthropic만 자체(/v1/messages).
'use strict';

// kind: 'openai'(호환) | 'anthropic'. base: 기본 엔드포인트(cfg.baseUrl 우선). keyRequired: 키 필수.
// web: 브라우저에서 쓸 수 있나(전부 클라우드라 web:true). ★로컬 Ollama(localhost)는 제거 — 거의 안 쓰고
//   https→localhost 혼합콘텐츠 문제. Ollama는 클라우드(ollama.com·유료)만 남김. 저장된 'ollama'는 providerDef가 openai로 폴백.
const PROVIDERS = {
  gemini:         { kind: 'openai',    base: 'https://generativelanguage.googleapis.com/v1beta/openai', keyRequired: true,  defModel: 'gemini-2.0-flash', web: true },
  openai:         { kind: 'openai',    base: 'https://api.openai.com/v1',  keyRequired: true,  defModel: 'gpt-4o-mini', web: true },
  anthropic:      { kind: 'anthropic', base: 'https://api.anthropic.com',  keyRequired: true,  defModel: 'claude-3-5-haiku-latest', web: true },
  'ollama-turbo': { kind: 'openai',    base: 'https://ollama.com/v1',      keyRequired: true,  defModel: 'gpt-oss:120b', web: true },  // Ollama 클라우드(유료)
  custom:         { kind: 'openai',    base: '',                            keyRequired: false, defModel: '', web: true },              // base 사용자 지정
};
const providerDef = (p) => PROVIDERS[p] || PROVIDERS.openai;

// 생성 파라미터 기본값(번역에 맞게 보수적). 0/빈값은 "미사용"으로 봐 요청에서 뺀다(penalty/top_k).
const DEFAULT_PARAMS = { temperature: 0.3, top_p: 1, frequency_penalty: 0, presence_penalty: 0, max_tokens: 4096, top_k: 0 };
function normParams(p) {
  p = p || {};
  const num = (v, d) => { const n = Number(v); return isFinite(n) ? n : d; };
  return {
    temperature: Math.max(0, Math.min(2, num(p.temperature, DEFAULT_PARAMS.temperature))),
    top_p: Math.max(0, Math.min(1, num(p.top_p, DEFAULT_PARAMS.top_p))),
    frequency_penalty: Math.max(-2, Math.min(2, num(p.frequency_penalty, DEFAULT_PARAMS.frequency_penalty))),
    presence_penalty: Math.max(-2, Math.min(2, num(p.presence_penalty, DEFAULT_PARAMS.presence_penalty))),
    max_tokens: Math.max(0, Math.min(200000, Math.round(num(p.max_tokens, DEFAULT_PARAMS.max_tokens)))),
    top_k: Math.max(0, Math.min(500, Math.round(num(p.top_k, DEFAULT_PARAMS.top_k)))),
  };
}

// 시스템 프롬프트(마크업 보존 = 코드가 보장 / 문체 = 사용자 프롬프트만). combine=결합 번역(여러 구역 한 요청).
function sysPrompt(targetLang, stylePrompt, combine) {
  const lang = targetLang || '한국어';
  const lines = [
    `You are a professional literary translator. Translate the user's roleplay/story text into ${lang}.`,
    `Rules (follow strictly):`,
    `- Output ONLY the translation. No notes, no explanations, no surrounding quotes.`,
    `- Preserve every placeholder of the form ⟦0⟧, ⟦1⟧, … EXACTLY (same digits, same ⟦⟧ brackets). They stand for images/markup; never translate, reorder, merge, or alter them.`,
    `- Keep dialogue quotation marks (" " ' ') and emphasis asterisks (*) exactly where they belong; translate the text inside them naturally.`,
    `- Preserve line breaks and paragraph structure.`,
    `- Translate fluently and naturally for native ${lang} readers.`,
  ];
  // 결합 번역: 여러 구역이 ⟦⟦SEG⟧⟧ 구분선으로 이어져 옴 → 구분선 그대로 두고 각 구역만 번역, 합치거나 빼지 말 것.
  if (combine) lines.push(
    `- The text contains MULTIPLE sections separated by lines that read EXACTLY ⟦⟦SEG⟧⟧. Keep every ⟦⟦SEG⟧⟧ separator line exactly as-is, unchanged, in the same positions. Translate each section independently; do NOT merge sections, do NOT drop or add separators. The output must contain the SAME number of ⟦⟦SEG⟧⟧ separators as the input.`,
  );
  const style = String(stylePrompt || '').trim();
  if (style) lines.push('', `Style/voice guidance from the user (apply to word choice and tone ONLY; never change structure, markup, or the ⟦n⟧ placeholders):`, style);
  return lines.join('\n');
}

// 정리(clean) 시스템 프롬프트 — ★번역 아님: 원문 언어·표현 유지하고 군더더기(스캐폴딩·CoT·OOC·라벨)만 제거.
//   1차 결정론(stripJunk)이 못 잡는 들쭉날쭉한 포맷용. placeholder/대사 보존은 코드가 강제, userPrompt는 추가 지침(작품별).
function cleanSysPrompt(userPrompt) {
  const lines = [
    'You clean up roleplay/story logs. Keep ONLY the in-character roleplay prose; remove LLM response scaffolding and meta noise.',
    'Rules (follow strictly):',
    '- Do NOT translate, summarize, or rewrite. Keep the ORIGINAL language and wording of the actual story/dialogue.',
    '- Remove: response headers (e.g. "## Response"), chain-of-thought / <thinking> / reasoning blocks, OOC notes ((( … )) / (OOC: …) / [System] / [Note]), speaker labels at line start (AI:/Assistant:/Narrator:/{{char}}:), and outer code-fence wrappers.',
    '- Keep dialogue, narration, and inner thoughts exactly (quotation marks " " ‘ ’ and emphasis asterisks *).',
    '- Preserve every placeholder of the form ⟦0⟧, ⟦1⟧, … EXACTLY (same digits/brackets). They stand for images/markup; never translate, reorder, merge, or alter them.',
    '- Preserve line breaks and paragraph structure of the kept prose.',
    '- Output ONLY the cleaned text. No notes, no explanations, no surrounding quotes.',
  ];
  const u = String(userPrompt || '').trim();
  if (u) lines.push('', 'Extra cleanup guidance from the user (apply, but never alter the ⟦n⟧ placeholders and never translate):', u);
  return lines.join('\n');
}

// 설정 유효성(키 필수/엔드포인트). 실패 시 throw.
function validate(cfg) {
  const def = providerDef(cfg.provider);
  if (def.keyRequired && !cfg.apiKey) throw new Error('API 키가 설정되지 않았습니다');
  const base = (cfg.baseUrl || def.base).replace(/\/+$/, '');
  if (!base) throw new Error('서버 주소(endpoint)를 설정하세요');
}

// 번역 HTTP 요청을 만든다(fetch는 호출부가). 반환 { url, method, headers, body, kind }.
//   cfg: { provider, model, baseUrl, apiKey, params }, payload: { text, targetLang, stylePrompt }.
function buildRequest(cfg, payload) {
  const def = providerDef(cfg.provider);
  const p = normParams(cfg.params);
  const text = String((payload && payload.text) || '');
  // task: 'translate'(기본·기존 동작) | 'clean'(군더더기 제거, 원문 언어 유지). stylePrompt = 작품별 추가 지침.
  const task = (payload && payload.task) || 'translate';
  const system = task === 'clean' ? cleanSysPrompt(payload && payload.stylePrompt) : sysPrompt((payload && payload.targetLang) || '한국어', payload && payload.stylePrompt, payload && payload.combine);
  // 응답 토큰: 프리셋 maxResponse가 있으면 그걸로(결합 배치는 입력만큼 길어 부족 시 잘림→코어가 폴백). 없으면 파라미터값.
  const maxResp = (payload && Number.isFinite(+payload.maxResponse) && +payload.maxResponse > 0) ? Math.min(200000, Math.round(+payload.maxResponse)) : 0;
  // ★응답 예산: 사용자가 max_tokens를 직접 설정했으면 그 값(0=요청서 생략, 기존 의미 유지).
  //   미설정이면 입력 길이 기반 동적 예산 — 고정 4096이 긴 블록(5천자↑) 번역을 자르고, thinking 모델(Gemini 2.5/3
  //   기본 사고 ON)은 사고 토큰이 같은 예산을 소진해 빈 응답('응답 형식 오류' 실패)까지 만들던 것 수정.
  //   max_tokens는 상한일 뿐(과금 무관) → 넉넉히: 글자수×1.5 + 여유, 8192~32768 사이.
  const rawMax = cfg.params ? cfg.params.max_tokens : null;
  const userMax = (rawMax != null && String(rawMax) !== '' && isFinite(+rawMax)) ? Math.max(0, Math.min(200000, Math.round(+rawMax))) : null;
  let maxTok = userMax != null ? userMax : Math.min(32768, Math.max(8192, Math.ceil(text.length * 1.5) + 1024));
  if (maxResp > maxTok) maxTok = maxResp;
  const base = (cfg.baseUrl || def.base).replace(/\/+$/, '');
  if (def.kind === 'anthropic') {
    const body = { model: cfg.model || def.defModel, max_tokens: maxTok > 0 ? maxTok : 4096, temperature: p.temperature, top_p: p.top_p, system, messages: [{ role: 'user', content: text }] };
    if (p.top_k > 0) body.top_k = p.top_k;
    return {
      url: base + '/v1/messages', method: 'POST', kind: 'anthropic',
      // dangerous-direct-browser-access: 웹(브라우저)에서 Anthropic CORS 허용용. 데스크탑(net.fetch)엔 무해.
      headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.apiKey || '', 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify(body),
    };
  }
  const body = { model: cfg.model || def.defModel || 'gpt-4o-mini', messages: [{ role: 'system', content: system }, { role: 'user', content: text }], temperature: p.temperature, top_p: p.top_p };
  if (p.frequency_penalty) body.frequency_penalty = p.frequency_penalty;   // 0이면 미지원 서버 호환 위해 생략
  if (p.presence_penalty) body.presence_penalty = p.presence_penalty;
  // ★OpenAI 본가는 max_completion_tokens(신형 GPT-5·o시리즈가 max_tokens를 400으로 거부, 구형도 수용).
  //   호환 서버(gemini·ollama·custom 등)는 기존 max_tokens 유지(max_completion_tokens 미지원 서버가 많음).
  if (maxTok > 0) { if (cfg.provider === 'openai') body.max_completion_tokens = maxTok; else body.max_tokens = maxTok; }
  // ★Gemini thinking(추론 강도, GigaTrans 흡수 ②) — 2.5 계열 사고 모델에서 reasoning_effort로 반영.
  //   off/빈값이면 요청에 안 넣음(= 모델 기본 그대로 → 비사고 모델 gemini-2.0-flash 등에서도 안전). gemini에만 적용.
  const think = String(cfg.thinking || '').toLowerCase();
  if (cfg.provider === 'gemini' && (think === 'low' || think === 'medium' || think === 'high')) body.reasoning_effort = think;
  return {
    url: base + '/chat/completions', method: 'POST', kind: 'openai',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (cfg.apiKey || 'ollama') },
    body: JSON.stringify(body),
  };
}

// provider 응답 JSON에서 번역 텍스트 추출.
// ★잘림·차단·빈 응답은 성공이 아니라 throw — 부분/빈 번역이 원문을 조용히 갈아치우고 캐시까지 오염시키던 것 수정.
//   (실패면 코어가 그 블록만 원문 유지 = 유실 0. 잘림은 max_tokens 안내, 차단은 안전 필터 안내.)
const ERR_TRUNC = '응답이 최대 길이에서 잘렸어요 — 설정에서 max_tokens(응답 길이)를 늘리거나 화를 더 잘게 나눠보세요';
const ERR_EMPTY = '모델이 빈 응답을 반환했어요 — 안전 필터 차단 또는 생각(thinking) 토큰이 응답 예산을 소진했을 수 있어요';
function parseResponse(kind, json) {
  if (kind === 'anthropic') {
    const out = json && json.content && json.content[0] && json.content[0].text;
    if (json && json.stop_reason === 'max_tokens') throw new Error(ERR_TRUNC);
    if (typeof out !== 'string') throw new Error('응답 형식 오류');
    if (!out.trim()) throw new Error(ERR_EMPTY);
    return out;
  }
  const ch = json && json.choices && json.choices[0];
  const out = ch && ch.message && ch.message.content;
  const fin = ch && (ch.finish_reason || ch.finishReason);
  if (fin === 'content_filter') throw new Error('안전 필터가 이 블록을 차단했어요 — 다른 모델·서비스를 시도해보세요');
  if (fin === 'length') throw new Error(ERR_TRUNC);
  if (typeof out !== 'string') throw new Error('응답 형식 오류');
  if (!out.trim()) throw new Error(ERR_EMPTY);
  return out;
}

// ── 스마트 재시도(GigaTrans 흡수 ①) ──────────────────────────────────────────
//   일시 오류(429 레이트·5xx 서버·408 타임아웃·일시 네트워크)만 재시도. 치명(401/403 인증·권한·404 모델/주소 없음·
//   400/422 잘못된 요청·402 결제)은 재시도해도 무의미 → 즉시 사람이 읽을 명확한 에러. (브라우저-안전: fetch는 호출부가 주입.)
function isTransientStatus(s) { return s === 408 || s === 429 || (s >= 500 && s <= 599); }
// 상태/응답본문 → 사람이 읽을 에러 메시지.
function errorText(status, bodyText) {
  let msg = '';
  try { const j = JSON.parse(bodyText); const m = j && j.error && (j.error.message || j.error); if (typeof m === 'string') msg = m; } catch (_) {}
  if (!msg) msg = String(bodyText || '').replace(/\s+/g, ' ').trim();
  msg = msg.slice(0, 300);
  const hint = (status === 401 || status === 403) ? 'API 키·권한을 확인하세요'
    : status === 404 ? '모델명 또는 서버 주소를 확인하세요'
    : status === 402 ? '요금제·크레딧(결제)을 확인하세요'
    : status === 429 ? '요청 한도 초과(레이트리밋) — 무료 키면 분당·일일 쿼터일 수 있어요. 잠시 후 다시 시도하거나 다른 모델·유료 키를 쓰세요'
    : (status >= 500) ? '서버 오류 — 잠시 후 다시'
    : (status === 400 || status === 422) ? '요청이 거부됐어요(모델·설정 확인)'
    : '요청 실패';
  return `${hint} (${status})` + (msg ? ': ' + msg : '');
}
const _retrySleep = (ms) => new Promise((r) => setTimeout(r, ms));
// ★429(레이트리밋)는 분당 쿼터라 밀리초 백오프가 무의미 — 초 단위로 길게 기다려야 창이 리셋된다.
//   서버가 Retry-After를 주면 그걸 존중(상한 60초), 없으면 이 스케줄.
const BACKOFF_429 = [2000, 5000, 12000, 30000];
// 스마트 재시도 래퍼. req=buildRequest 결과. doFetch(req)→{status:number, bodyText:string, retryAfterMs?:number}(네트워크 실패 시 throw).
//   opts: { retries(기본2 — 5xx·408·네트워크), retries429(기본4 — 레이트리밋 별도·길게),
//           retryNetwork(네트워크 throw도 재시도=데스크탑 true / 웹 false=CORS 즉시), sleep(테스트 주입) }.
//   반환 = 성공 응답 본문(text). 치명/소진 시 throw(명확 메시지).
async function requestWithRetry(req, doFetch, opts) {
  opts = opts || {};
  const retries = opts.retries != null ? opts.retries : 2;
  const retries429 = opts.retries429 != null ? opts.retries429 : 4;
  const retryNetwork = !!opts.retryNetwork;
  const sleep = opts.sleep || _retrySleep;
  let aNet = 0, aTrans = 0, a429 = 0;
  for (;;) {
    let r;
    try { r = await doFetch(req); }
    catch (e) {
      if (retryNetwork && aNet < retries) { await sleep(600 * Math.pow(2, aNet)); aNet++; continue; }
      throw (e instanceof Error ? e : new Error(String(e || '네트워크 오류')));
    }
    const status = (r && typeof r.status === 'number') ? r.status : 0;
    if (status >= 200 && status < 300) return r.bodyText;
    if (status === 429 && a429 < retries429) {
      const ra = r ? +r.retryAfterMs : 0;
      const wait = Math.min(60000, (isFinite(ra) && ra > 0) ? ra : BACKOFF_429[Math.min(a429, BACKOFF_429.length - 1)]);
      await sleep(wait); a429++; continue;
    }
    if (status !== 429 && isTransientStatus(status) && aTrans < retries) { await sleep(600 * Math.pow(2, aTrans)); aTrans++; continue; }
    throw new Error(errorText(status, r && r.bodyText));
  }
}

module.exports = { PROVIDERS, providerDef, DEFAULT_PARAMS, normParams, sysPrompt, cleanSysPrompt, validate, buildRequest, parseResponse, isTransientStatus, errorText, requestWithRetry };
