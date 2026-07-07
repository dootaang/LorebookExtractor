// SPDX-License-Identifier: GPL-3.0-or-later
// Browser-side LLM adapter for BYO-key translation. No backend is used.
// API keys are stored only in localStorage or sessionStorage, depending on user choice.
// @ts-nocheck
import { providerDef, normParams, validate, buildRequest, parseResponse, requestWithRetry } from '../../core/translate/providers.js';

const WEB_KEY = 'lb-translate-config-web';

export const DEFAULT_WEB_CONFIG = {
  provider: 'gemini',
  model: '',
  baseUrl: '',
  apiKey: '',
  params: { temperature: 0.3, top_p: 1, max_tokens: 0, frequency_penalty: 0, presence_penalty: 0, top_k: 0 },
  thinking: 'off',
  sessionOnly: false,
};

function readRaw(): any {
  try {
    const raw = sessionStorage.getItem(WEB_KEY) || localStorage.getItem(WEB_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

export function getWebConfig(): any {
  const o = readRaw();
  return {
    ...DEFAULT_WEB_CONFIG,
    ...o,
    params: normParams(o.params || DEFAULT_WEB_CONFIG.params),
    sessionOnly: !!o.sessionOnly,
  };
}

export function webPublicConfig(): any {
  const c = getWebConfig();
  return {
    provider: c.provider,
    model: c.model,
    baseUrl: c.baseUrl,
    hasKey: !!c.apiKey,
    params: c.params,
    thinking: c.thinking,
    sessionOnly: c.sessionOnly,
  };
}

export function setWebConfig(cfg: any): any {
  const cur = getWebConfig();
  const out = {
    provider: cfg.provider || cur.provider,
    model: cfg.model != null ? cfg.model : cur.model,
    baseUrl: cfg.baseUrl != null ? cfg.baseUrl : cur.baseUrl,
    apiKey: cfg.apiKey != null && cfg.apiKey !== '' ? cfg.apiKey : cur.apiKey,
    params: normParams(cfg.params != null ? cfg.params : cur.params),
    thinking: cfg.thinking != null ? cfg.thinking : cur.thinking,
    sessionOnly: cfg.sessionOnly != null ? !!cfg.sessionOnly : cur.sessionOnly,
  };
  try {
    localStorage.removeItem(WEB_KEY);
    sessionStorage.removeItem(WEB_KEY);
    (out.sessionOnly ? sessionStorage : localStorage).setItem(WEB_KEY, JSON.stringify(out));
  } catch (_) {}
  return webPublicConfig();
}

export function clearWebConfig(): any {
  try {
    localStorage.removeItem(WEB_KEY);
    sessionStorage.removeItem(WEB_KEY);
  } catch (_) {}
  return webPublicConfig();
}

export async function webTranslate(payload: any): Promise<string> {
  const cfg = getWebConfig();
  const text = String((payload && payload.text) || '');
  if (!text.trim()) return text;
  validate(cfg);
  const req = buildRequest(cfg, {
    text,
    targetLang: (payload && payload.targetLang) || '한국어',
    stylePrompt: payload && payload.stylePrompt,
    task: payload && payload.task,
    combine: payload && payload.combine,
    maxResponse: payload && payload.maxResponse,
  });
  const body = await requestWithRetry(req, async (rq: any) => {
    let res: Response;
    try {
      res = await fetch(rq.url, { method: rq.method, headers: rq.headers, body: rq.body });
    } catch (_) {
      throw new Error('브라우저에서 이 서비스에 직접 연결하지 못했습니다. CORS 문제일 수 있습니다. Gemini 또는 Anthropic을 우선 사용해보세요.');
    }
    let retryAfterMs = 0;
    const ra = res.headers.get('retry-after');
    if (ra) {
      const s = +ra;
      retryAfterMs = Number.isFinite(s) ? s * 1000 : Math.max(0, Date.parse(ra) - Date.now());
    }
    return { status: res.status, bodyText: await res.text(), retryAfterMs };
  }, { retries: 2, retries429: 4, retryNetwork: false });
  let json: any = null;
  try { json = JSON.parse(body); } catch (_) {}
  if (!json) throw new Error('응답 JSON을 읽지 못했습니다.');
  return parseResponse(req.kind, json);
}

export { providerDef };

