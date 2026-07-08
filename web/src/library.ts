// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 dootaang — 로어북 추출기 (Lorebook Extractor). Licensed under GNU GPL v3 (see LICENSE).
// web/src/library.ts — 미니 서재: 열었던 파일과 작업상태(초안+번역)를 IndexedDB에 영속.
//   DB lbx v1 — files{hash,name,size,bytes:Blob,openedAt} · drafts{hash,edits,removedUids,addedEntries,keyAdds,translations,t}
//   바이트는 Blob으로 저장(Chrome에선 참조만 들려 getAll이 가벼움). 파일 삭제 시 초안도 함께 삭제.
// @ts-nocheck

let dbPromise: Promise<IDBDatabase> | null = null;
function idbOpen(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('lbx', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'hash' });
        if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts', { keyPath: 'hash' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}
function reqP(req: IDBRequest): Promise<any> {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
}
async function store(name: string, mode: IDBTransactionMode) {
  const db = await idbOpen();
  return db.transaction(name, mode).objectStore(name);
}

// 파일 자동 보관 — 해시 dedup: 이미 있으면 openedAt만 갱신(대형 바이트 재기록 없음).
export async function saveFile(hash: string, name: string, bytes: Uint8Array) {
  const s = await store('files', 'readwrite');
  const cur = await reqP(s.get(hash));
  if (cur) { cur.openedAt = Date.now(); cur.name = name; s.put(cur); return; }
  s.put({ hash, name, size: bytes.length, bytes: new Blob([bytes]), openedAt: Date.now() });
}
export async function listFiles(): Promise<any[]> {
  const s = await store('files', 'readonly');
  const rows = await reqP(s.getAll());
  return (rows || []).sort((a: any, b: any) => (b.openedAt || 0) - (a.openedAt || 0));
}
export async function loadFileBytes(hash: string): Promise<Uint8Array | null> {
  const s = await store('files', 'readonly');
  const rec = await reqP(s.get(hash));
  return rec && rec.bytes ? new Uint8Array(await rec.bytes.arrayBuffer()) : null;
}
// 파일 삭제 = 초안도 함께(스펙 §5.5). "초안 버리기"는 saveDraftState(hash, null)만.
export async function removeFile(hash: string) {
  await reqP((await store('files', 'readwrite')).delete(hash));
  await reqP((await store('drafts', 'readwrite')).delete(hash));
}

// 초안(번역 포함) — null이면 삭제.
export async function saveDraftState(hash: string, state: any | null) {
  const s = await store('drafts', 'readwrite');
  await reqP(state ? s.put({ hash, ...state, t: Date.now() }) : s.delete(hash));
}
export async function loadDraftState(hash: string): Promise<any | null> {
  const s = await store('drafts', 'readonly');
  return (await reqP(s.get(hash))) || null;
}

export async function storageInfo(): Promise<{ usage: number; quota: number } | null> {
  try { const e = await navigator.storage.estimate(); return { usage: e.usage || 0, quota: e.quota || 0 }; }
  catch (_) { return null; }
}
let persistAsked = false;
export function requestPersistOnce() {
  if (persistAsked || !navigator.storage || !navigator.storage.persist) return;
  persistAsked = true;
  navigator.storage.persist().then((granted) => console.log('[library] persist:', granted)).catch(() => {});
}
