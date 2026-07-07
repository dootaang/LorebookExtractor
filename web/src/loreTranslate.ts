// SPDX-License-Identifier: GPL-3.0-or-later
// Lorebook-specific translation orchestration based on LogPapa's translateUnits pattern.
// @ts-nocheck
import { translateBlocks } from '../../core/translate/translateLog.js';
import { PROVIDERS, providerDef } from '../../core/translate/providers.js';
import { getWebConfig, setWebConfig, clearWebConfig, webPublicConfig, webTranslate } from './webLlm.js';

const PREF_KEY = 'lb-translate-prefs';
const PRESETS_KEY = 'lb-translate-presets';
const COMBINE_KEY = 'lb-translate-combine';
const CACHE_DB = 'lb-translate-cache';
const CACHE_STORE = 'trcache';
const CACHE_VERSION = 1;
const CACHE_CAP = 5000;

export const DEFAULT_LORE_PROMPT =
  '설정집, 세계관, 캐릭터 설명을 자연스러운 한국어로 번역하세요. 고유명사, 호칭, 시스템 용어는 일관되게 유지하고, 키워드나 발동 조건은 번역하지 마세요.';

export const DEFAULT_PREFS = {
  targetLang: '한국어',
  translateNames: true,
  skipKorean: true,
  batchChars: 3600,
  batchCount: 16,
};

function loadJson(key: string, fallback: any) {
  try { return JSON.parse(localStorage.getItem(key) || ''); } catch (_) { return fallback; }
}
function saveJson(key: string, value: any) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
}

export function getTranslatePrefs(): any {
  const p = loadJson(PREF_KEY, {});
  return {
    ...DEFAULT_PREFS,
    ...p,
    translateNames: p.translateNames !== false,
    skipKorean: p.skipKorean !== false,
    batchChars: Number(p.batchChars) || DEFAULT_PREFS.batchChars,
    batchCount: Number(p.batchCount) || DEFAULT_PREFS.batchCount,
  };
}
export function setTranslatePrefs(patch: any): any {
  const next = { ...getTranslatePrefs(), ...(patch || {}) };
  saveJson(PREF_KEY, next);
  return next;
}

export interface TrPreset { name: string; prompt: string; maxResponse?: number; }
export function getPresets(): { list: TrPreset[]; active: string } {
  const o = loadJson(PRESETS_KEY, null);
  if (o && Array.isArray(o.list) && o.list.length) {
    return { list: o.list, active: typeof o.active === 'string' ? o.active : o.list[0].name };
  }
  return { list: [{ name: '기본', prompt: DEFAULT_LORE_PROMPT }], active: '기본' };
}
export function savePresets(obj: { list: TrPreset[]; active: string }) {
  const list = (obj.list || []).filter((p) => p && p.name && p.prompt).map((p) => ({
    name: String(p.name).slice(0, 80),
    prompt: String(p.prompt).slice(0, 8000),
    ...(Number.isFinite(+p.maxResponse) && +p.maxResponse > 0 ? { maxResponse: +p.maxResponse } : {}),
  }));
  saveJson(PRESETS_KEY, { list: list.length ? list : [{ name: '기본', prompt: DEFAULT_LORE_PROMPT }], active: obj.active || (list[0] && list[0].name) || '기본' });
}
export function getActivePreset(): TrPreset {
  const p = getPresets();
  return p.list.find((x) => x.name === p.active) || p.list[0];
}
export function getActivePrompt(): string {
  const p = getActivePreset();
  return p && p.prompt && p.prompt.trim() ? p.prompt : DEFAULT_LORE_PROMPT;
}
export function getActiveMaxResponse(): number | undefined {
  const p = getActivePreset();
  return p && Number.isFinite(+p.maxResponse) && +p.maxResponse > 0 ? +p.maxResponse : undefined;
}
export function getCombineOn(): boolean {
  try {
    const v = localStorage.getItem(COMBINE_KEY);
    return v == null ? true : v === '1';
  } catch (_) {
    return true;
  }
}
export function setCombineOn(on: boolean) {
  try { localStorage.setItem(COMBINE_KEY, on ? '1' : '0'); } catch (_) {}
}

export function fnv(s: string): string {
  let h = 0x811c9dc5;
  s = String(s || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
function normUnit(s: string): string {
  return String(s == null ? '' : s).replace(/\r\n/g, '\n').trim();
}
function cacheKey(unit: string, targetLang: string, prompt: string, field: string): string {
  return [normUnit(unit), targetLang || '한국어', fnv(prompt), field || 'content'].join('\u0001');
}

function openCache(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CACHE_DB, CACHE_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CACHE_STORE)) {
        const st = db.createObjectStore(CACHE_STORE, { keyPath: 'k' });
        st.createIndex('t', 't');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export async function trcacheGet(keys: string[]): Promise<(string | null)[]> {
  if (!keys.length) return [];
  let db: IDBDatabase | null = null;
  try {
    db = await openCache();
    const out = await new Promise<(string | null)[]>((res) => {
      const tx = db!.transaction(CACHE_STORE, 'readonly');
      const st = tx.objectStore(CACHE_STORE);
      const r = new Array(keys.length).fill(null);
      let left = keys.length;
      keys.forEach((k, i) => {
        const g = st.get(k);
        g.onsuccess = () => { if (g.result && g.result.v) r[i] = g.result.v; if (--left === 0) res(r); };
        g.onerror = () => { if (--left === 0) res(r); };
      });
    });
    const hits = keys.filter((_, i) => out[i] != null);
    if (hits.length) {
      try {
        await new Promise<void>((res) => {
          const tx = db!.transaction(CACHE_STORE, 'readwrite');
          const st = tx.objectStore(CACHE_STORE);
          const now = Date.now();
          hits.forEach((k) => {
            const g = st.get(k);
            g.onsuccess = () => { if (g.result) { g.result.t = now; st.put(g.result); } };
          });
          tx.oncomplete = () => res();
          tx.onerror = () => res();
        });
      } catch (_) {}
    }
    return out;
  } catch (_) {
    return new Array(keys.length).fill(null);
  } finally {
    try { db && db.close(); } catch (_) {}
  }
}
export async function trcachePut(items: { k: string; v: string }[]) {
  if (!items.length) return;
  let db: IDBDatabase | null = null;
  try {
    db = await openCache();
    const now = Date.now();
    await new Promise<void>((res) => {
      const tx = db!.transaction(CACHE_STORE, 'readwrite');
      const st = tx.objectStore(CACHE_STORE);
      items.forEach((it) => st.put({ k: it.k, v: it.v, t: now }));
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
    const count = await new Promise<number>((res) => {
      const c = db!.transaction(CACHE_STORE, 'readonly').objectStore(CACHE_STORE).count();
      c.onsuccess = () => res(c.result || 0);
      c.onerror = () => res(0);
    });
    if (count > CACHE_CAP) {
      const remove = count - CACHE_CAP;
      await new Promise<void>((res) => {
        const tx = db!.transaction(CACHE_STORE, 'readwrite');
        const cur = tx.objectStore(CACHE_STORE).index('t').openCursor();
        let n = 0;
        cur.onsuccess = () => {
          const c = cur.result;
          if (c && n < remove) { c.delete(); n++; c.continue(); }
        };
        tx.oncomplete = () => res();
        tx.onerror = () => res();
      });
    }
  } catch (_) {
  } finally {
    try { db && db.close(); } catch (_) {}
  }
}
export async function clearTranslationCache() {
  let db: IDBDatabase | null = null;
  try {
    db = await openCache();
    await new Promise<void>((res) => {
      const tx = db!.transaction(CACHE_STORE, 'readwrite');
      tx.objectStore(CACHE_STORE).clear();
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
  } catch (_) {
  } finally {
    try { db && db.close(); } catch (_) {}
  }
}

function makeRawTranslate(targetLang: string, stylePrompt: string) {
  return async (masked: string, ctx?: any) => {
    return await webTranslate({
      text: masked,
      targetLang,
      stylePrompt,
      combine: !!(ctx && ctx.combine),
      maxResponse: ctx && ctx.maxResponse,
    });
  };
}

export async function ensureTranslateReady(): Promise<void> {
  const cfg = getWebConfig();
  const def = providerDef(cfg.provider);
  if (def.keyRequired && !cfg.apiKey) throw new Error('API 키를 먼저 입력하세요.');
}

export async function translateJobs(jobs: any[], opts: any): Promise<any> {
  const prefs = getTranslatePrefs();
  const targetLang = prefs.targetLang || '한국어';
  const stylePrompt = opts && opts.stylePrompt != null ? opts.stylePrompt : getActivePrompt();
  const maxResponse = opts && opts.maxResponse != null ? opts.maxResponse : getActiveMaxResponse();
  const keys = jobs.map((j) => cacheKey(j.text, targetLang, stylePrompt, j.field));
  const out = new Array(jobs.length).fill(null);
  let cached = 0;
  const missJobs: any[] = [];
  const hits = opts && opts.force ? [] : await trcacheGet(keys);
  jobs.forEach((j, i) => {
    if (!opts?.force && hits[i] != null && String(hits[i]).trim()) {
      out[i] = hits[i];
      cached++;
    } else {
      missJobs.push({ ...j, originalIndex: i });
    }
  });
  let translated = 0, skipped = 0;
  const failed: any[] = [];
  if (missJobs.length) {
    const blocks = missJobs.map((j) => j.text);
    const res = await translateBlocks(blocks, makeRawTranslate(targetLang, stylePrompt), {
      skipKorean: prefs.skipKorean !== false,
      combine: getCombineOn(),
      batchChars: Number(prefs.batchChars) || DEFAULT_PREFS.batchChars,
      batchCount: Number(prefs.batchCount) || DEFAULT_PREFS.batchCount,
      maxResponse,
      onProgress: opts && opts.onProgress,
    });
    translated = res.translated;
    skipped = res.skipped;
    const failedK = new Set(res.failed.map((f: any) => f.index));
    res.failed.forEach((f: any) => failed.push({ ...f, index: missJobs[f.index].originalIndex }));
    const toCache: { k: string; v: string }[] = [];
    missJobs.forEach((j, k) => {
      const origI = j.originalIndex;
      out[origI] = res.blocks[k];
      if (!failedK.has(k) && res.blocks[k] !== jobs[origI].text && String(res.blocks[k]).trim()) {
        toCache.push({ k: keys[origI], v: res.blocks[k] });
      }
    });
    if (toCache.length) await trcachePut(toCache);
  }
  return { blocks: out, translated: translated + cached, cached, skipped, failed };
}

export {
  PROVIDERS,
  providerDef,
  getWebConfig,
  setWebConfig,
  clearWebConfig,
  webPublicConfig,
};

