// SPDX-License-Identifier: GPL-3.0-or-later
// @ts-nocheck
import { parseCard } from '../../core/card/parseCard.js';
import { extractLorebook, splitDecorators, groupByFolder, loreStats, buildCharacterBook, buildMarkdown, mergedKeys } from '../../core/lorebook/normalize.js';
import { applyLorebookToCard } from '../../core/lorebook/applyCard.js';   // 편집·번역·추가 키 → 원본 카드 JSON
import { repackCard } from '../../core/card/repack.js';                    // 카드 JSON만 수술 교체(원본 형식 내보내기)
import { diagnoseLorebook } from '../../core/lorebook/diagnose.js';
import { simulateActivation } from '../../core/lorebook/activate.js';
import { estimateLorebookTokens, estimateEntryTokens } from '../../core/lorebook/tokens.js';
import { extractGlossary, buildGlossaryText } from '../../core/lorebook/glossary.js';   // 용어집(고유명사 표기 쌍) — 채팅 번역 일관성용
import { renderMdLite } from '../../core/lorebook/mdlite.js';   // 표시 전용 안전 마크다운(내보내기·번역 데이터는 원본 유지)
import {
  PROVIDERS,
  providerDef,
  getWebConfig,
  setWebConfig,
  clearWebConfig,
  getTranslatePrefs,
  setTranslatePrefs,
  getPresets,
  savePresets,
  getActivePrompt,
  getActiveMaxResponse,
  getCombineOn,
  setCombineOn,
  clearTranslationCache,
  ensureTranslateReady,
  translateJobs,
  DEFAULT_LORE_PROMPT,
} from './loreTranslate.js';

type FilterMode = 'all' | 'constant' | 'conditional' | 'disabled';
type SortMode = 'order' | 'name' | 'length';
type ReaderTab = 'read' | 'diagnose' | 'activate' | 'glossary' | 'export';

const app = document.getElementById('app')!;
const ACCEPT = '.charx,.png,.json,.jpeg,.jpg,.risum,.module.charx';
const THEME_KEY = 'lb-theme';

let chips: any[] = [];
let currentId: string | null = null;
let parsed: any = null;
let lore: any = null;
let parseError = '';
let selectedUid = '';
let query = '';
let filter: FilterMode = 'all';
let sort: SortMode = 'order';
let readerTab: ReaderTab = 'read';
let showTranslated = true;
let statusText = '';
let settingsOpen = false;
let translating = false;
let activationText = '';
let activationRan = false;
let translations: Record<string, { name?: string; content?: string }> = {};
let keyAdds: Record<string, string[]> = {};   // 활성화 키 번역 추가 — 원본 키에 "추가"만(내보내기 반영)
let glossaryRows: any[] | null = null;        // 용어집(지연 추출·LLM 채움 결과 보존)
// ── 라이트 편집(오버레이 — 원본 불변) + localStorage 초안 자동보존 ──
let edits: Record<string, any> = {};          // uid → 편집 필드(name·keys·secondaryKeys·content·constant·selective·useRegex·enabled)
let removedUids: Record<string, true> = {};   // 소프트 삭제(목록에 취소선+복구, 내보내기 제외)
let addedEntries: any[] = [];                 // 새 엔트리(통일 스키마, raw 없음)
let editingUid: string | null = null;         // 편집 폼이 열린 엔트리
let draftKey = '';                            // 'lb-draft-' + 파일 sha256 — 파일별 초안
let draftTimer: any = null;

function eff(e: any) { const d = edits[e.uid]; return d ? { ...e, ...d } : e; }
function hasDraftState() { return !!(Object.keys(edits).length || Object.keys(removedUids).length || addedEntries.length || Object.keys(keyAdds).length); }
function saveDraft() {
  if (!draftKey) return;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    try {
      if (!hasDraftState()) { localStorage.removeItem(draftKey); return; }
      localStorage.setItem(draftKey, JSON.stringify({ v: 1, t: Date.now(), edits, removedUids, addedEntries, keyAdds }));
    } catch (_) { toast('초안 저장 실패 — 저장 공간이 부족해요'); }
  }, 400);
}
function loadDraft(): boolean {
  if (!draftKey) return false;
  try {
    const raw = localStorage.getItem(draftKey);
    if (!raw) return false;
    const d = JSON.parse(raw);
    edits = d.edits || {};
    removedUids = d.removedUids || {};
    addedEntries = Array.isArray(d.addedEntries) ? d.addedEntries : [];
    keyAdds = d.keyAdds || {};
    return hasDraftState();
  } catch (_) { return false; }
}
function discardDraft() {
  edits = {}; removedUids = {}; addedEntries = []; keyAdds = {}; editingUid = null; glossaryRows = null;
  try { if (draftKey) localStorage.removeItem(draftKey); } catch (_) {}
  refreshIssueMap();
  statusText = '초안을 버렸어요 — 원본 그대로.';
  renderBody();
}
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
// 분석·내보내기 공용: 삭제 제외 + 편집 병합 + 추가분 포함(폴더는 통과).
function effLore() {
  if (!lore) return lore;
  const entries = lore.entries
    .filter((e: any) => e.isFolder || !removedUids[e.uid])
    .map((e: any) => (e.isFolder ? e : eff(e)))
    .concat(addedEntries.map(eff));
  return { ...lore, entries };
}
let theme = localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
let mdRaw = false;   // 본문 보기: 렌더(기본) ↔ 원문
let mobilePane: 'list' | 'reader' = 'list';   // 좁은 화면: 목록 ↔ 본문 한 화면씩(데스크탑은 CSS가 무시)
// 진단 이슈 → 목록 경고 도트용(uid → 최고 심각도). lore 바뀔 때마다 재계산(selectChip).
let issueSevByUid: Record<string, string> = {};
function refreshIssueMap() {
  issueSevByUid = {};
  if (!lore) return;
  try {
    const rank: any = { error: 0, warning: 1, info: 2 };
    for (const i of diagnoseLorebook(effLore(), { tokenBudget: lore.tokenBudget }).issues) {
      if (!i.uid || i.code === 'long_entry' || i.code === 'disabled') continue;   // 정보성은 도트 제외(노이즈)
      if (!(i.uid in issueSevByUid) || rank[i.severity] < rank[issueSevByUid[i.uid]]) issueSevByUid[i.uid] = i.severity;
    }
  } catch (_) {}
}
const tinyTok = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
// 브랜드 아이콘(build/icon.svg와 동일 도형): 크림 스쿼클 + 펼친 책 + 딥그린 서표 리본.
const ICON = (s: number) => `<svg width="${s}" height="${s}" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">`
  + '<defs><linearGradient id="lbg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f9f1e0"/><stop offset="1" stop-color="#ecdfc0"/></linearGradient></defs>'
  + '<rect width="128" height="128" rx="28" fill="url(#lbg)" stroke="#dcc59a" stroke-width="3"/>'
  + '<path d="M64 42 C55 34 42 31 30 33 L30 92 C42 90 55 92 64 99 Z" fill="#fffdf6" stroke="#33261a" stroke-width="4" stroke-linejoin="round"/>'
  + '<path d="M64 42 C73 34 86 31 98 33 L98 92 C86 90 73 92 64 99 Z" fill="#fffdf6" stroke="#33261a" stroke-width="4" stroke-linejoin="round"/>'
  + '<path d="M38 48 C46 46 52 47 57 50 M38 58 C46 56 52 57 57 60 M38 68 C46 66 52 67 57 70" stroke="#b8a078" stroke-width="3" fill="none" stroke-linecap="round"/>'
  + '<path d="M71 50 C76 47 82 46 90 48 M71 60 C76 57 82 56 90 58" stroke="#b8a078" stroke-width="3" fill="none" stroke-linecap="round"/>'
  + '<path d="M76 24 L90 24 L90 56 L83 48 L76 56 Z" fill="#255c46"/></svg>';

let chipsEl: HTMLElement;
let bodyEl: HTMLElement;
let toastEl: HTMLElement | null = null;
let toastTimer: any = null;

function applyTheme() {
  document.documentElement.dataset.theme = theme;
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function safeName(s: string) {
  return String(s || 'lorebook').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
}
function fmtBytes(n: number) {
  return n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB';
}
function fmtChars(n: number) {
  return n >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}
function realEntries() {   // 편집 병합·삭제 제외·추가 포함(표시/분석/내보내기 공용)
  const el = effLore();
  return el ? el.entries.filter((e: any) => !e.isFolder) : [];
}
function selectedEntry() {
  const list = realEntries();
  return list.find((e: any) => e.uid === selectedUid) || list[0] || null;
}
function displayName(e: any) {
  const tr = translations[e.uid];
  return showTranslated && tr && tr.name ? tr.name : (e.name || e.keys[0] || '(이름 없음)');
}
function displayContent(e: any) {
  const tr = translations[e.uid];
  return showTranslated && tr && tr.content ? tr.content : e.content;
}
function setStatus(s: string) {
  statusText = s || '';
  renderBody();
}
function toast(msg: string) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl && toastEl.classList.remove('show'), 1800);
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
function downloadText(text: string, filename: string, mime = 'text/plain;charset=utf-8') {
  downloadBlob(new Blob([text], { type: mime }), filename);
}
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('복사했습니다');
}

function addFiles(files: File[]) {
  let last = '';
  for (const f of files) {
    const id = uid();
    chips.push({ id, name: f.name, size: f.size, read: () => f.arrayBuffer().then((b) => new Uint8Array(b)) });
    last = id;
  }
  if (last) selectChip(last);
  else render();
}
function pickFiles() {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = ACCEPT;
  input.onchange = () => addFiles(Array.from(input.files || []));
  input.click();
}
function removeChip(id: string) {
  chips = chips.filter((c) => c.id !== id);
  if (currentId === id) {
    currentId = null;
    parsed = null;
    lore = null;
    selectedUid = '';
    parseError = '';
    translations = {};
    if (chips.length) {
      selectChip(chips[chips.length - 1].id);
      return;
    }
  }
  render();
}
async function selectChip(id: string) {
  const chip = chips.find((c) => c.id === id);
  if (!chip) return;
  currentId = id;
  parsed = null;
  lore = null;
  selectedUid = '';
  parseError = '';
  translations = {};
  query = '';
  filter = 'all';
  sort = 'order';
  readerTab = 'read';
  activationText = '';
  activationRan = false;
  statusText = '';
  render();
  setStatus('읽는 중...');
  await new Promise((r) => setTimeout(r, 16));
  try {
    const bytes = await chip.read();
    parsed = parseCard(bytes, chip.name, { lazy: true });
    try { draftKey = 'lb-draft-' + (await sha256Hex(bytes)); } catch (_) { draftKey = ''; }   // 파일 지문 → 초안 키
    lore = extractLorebook(parsed.card || parsed);
    if (!lore || !Array.isArray(lore.entries) || !lore.entries.some((e: any) => !e.isFolder)) {
      parseError = '이 파일에서 로어북을 찾지 못했습니다.';
    } else {
      selectedUid = realEntries()[0]?.uid || '';
      statusText = `${chip.name}에서 로어북을 읽었습니다.`;
      keyAdds = {}; edits = {}; removedUids = {}; addedEntries = []; editingUid = null;   // 파일 단위 상태 초기화
      glossaryRows = null;
      if (loadDraft()) statusText = `${chip.name} — 저장된 초안을 복원했어요.`;
      refreshIssueMap();
      mobilePane = 'list';   // 새 파일 = 좁은 화면에선 목록부터
    }
  } catch (e) {
    console.warn('[lorebook] parse failed', e);
    parseError = (e && e.message) ? e.message : '파일을 읽지 못했습니다.';
  }
  render();
}

function filteredEntries() {
  let list = realEntries();
  if (filter === 'constant') list = list.filter((e: any) => e.constant);
  else if (filter === 'conditional') list = list.filter((e: any) => !e.constant && e.enabled);
  else if (filter === 'disabled') list = list.filter((e: any) => !e.enabled);
  const q = query.trim().toLowerCase();
  if (q) {
    list = list.filter((e: any) => {
      const tr = translations[e.uid] || {};
      return [
        e.name, tr.name, e.keys.join(' '), e.secondaryKeys.join(' '), e.content, tr.content,
      ].join('\n').toLowerCase().includes(q);
    });
  }
  if (sort === 'name') list = list.slice().sort((a: any, b: any) => displayName(a).localeCompare(displayName(b), 'ko'));
  else if (sort === 'length') list = list.slice().sort((a: any, b: any) => b.content.length - a.content.length);
  else list = list.slice().sort((a: any, b: any) => (a.order || 0) - (b.order || 0));
  return list;
}
function groupsForList() {
  const visible = new Set(filteredEntries().map((e: any) => e.uid));
  const groups = groupByFolder(lore.entries)
    .map((g: any) => ({ folder: g.folder, items: g.items.filter((e: any) => visible.has(e.uid)) }))
    .filter((g: any) => g.items.length);
  const known = new Set(groups.flatMap((g: any) => g.items.map((e: any) => e.uid)));
  const missed = filteredEntries().filter((e: any) => !known.has(e.uid));
  if (missed.length) groups.unshift({ folder: null, items: missed });
  return groups;
}

function render() {
  applyTheme();
  document.querySelectorAll('.modal').forEach((el) => el.remove());
  app.innerHTML = '';
  const bar = document.createElement('header');
  bar.className = 'topbar';
  const brand = document.createElement('div');
  brand.className = 'brand';
  brand.innerHTML = `<span class="brand-mark">${ICON(26)}</span><span>로어북 추출기</span>`;
  bar.appendChild(brand);
  chipsEl = document.createElement('div');
  chipsEl.className = 'chips';
  bar.appendChild(chipsEl);
  const actions = document.createElement('div');
  actions.className = 'top-actions';
  actions.append(
    button('파일 열기', pickFiles),
    button('번역 설정', () => { settingsOpen = true; render(); }),
    button(theme === 'dark' ? '라이트' : '다크', () => {
      theme = theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem(THEME_KEY, theme);
      render();
    }, 'ghost'),
  );
  bar.appendChild(actions);
  app.appendChild(bar);
  bodyEl = document.createElement('div');
  bodyEl.style.cssText = 'flex:1 1 auto;min-height:0;display:flex;flex-direction:column;';
  app.appendChild(bodyEl);
  renderChips();
  renderBody();
  if (settingsOpen) renderSettings();
}
function renderChips() {
  if (!chipsEl) return;
  chipsEl.innerHTML = '';
  for (const c of chips) {
    const chip = document.createElement('button');
    chip.className = 'chip' + (c.id === currentId ? ' active' : '');
    chip.title = c.name;
    chip.onclick = () => { if (c.id !== currentId) selectChip(c.id); };
    chip.append(span('nm', c.name), span('meta', fmtBytes(c.size || 0)));
    const x = button('x', (ev: any) => { ev.stopPropagation(); removeChip(c.id); }, 'x');
    x.title = '닫기';
    chip.appendChild(x);
    chipsEl.appendChild(chip);
  }
}
function renderBody() {
  if (!bodyEl) return;
  // 목록 스크롤 보존 — 엔트리 선택 등 재렌더마다 맨 위로 튀던 것 수정.
  const prevList = bodyEl.querySelector('.list-scroll') as HTMLElement | null;
  const listTop = prevList ? prevList.scrollTop : 0;
  bodyEl.innerHTML = '';
  if (!chips.length) { bodyEl.appendChild(buildEmpty()); return; }
  if (!lore && !parseError) {
    bodyEl.appendChild(div('empty-reader', '읽는 중...'));
    return;
  }
  if (parseError) {
    const wrap = buildEmpty();
    wrap.querySelector('.drop-title')!.textContent = parseError;
    wrap.querySelector('.drop-ext')!.textContent = '다른 .charx, .png, .json, .jpeg, .risum 파일을 넣어보세요.';
    bodyEl.appendChild(wrap);
    return;
  }
  const main = document.createElement('main');
  main.className = 'main';
  main.append(buildSummary(), buildWorkspace(), buildBottomActions());
  bodyEl.appendChild(main);
  const newList = bodyEl.querySelector('.list-scroll') as HTMLElement | null;
  if (newList && listTop > 0) newList.scrollTop = listTop;
}
// 내장 샘플 즉시 로드 — 파일 없이도 도구를 바로 체험(첫 방문 전환용).
async function loadSample() {
  try {
    const res = await fetch('sample-lorebook.json');
    if (!res.ok) throw new Error(String(res.status));
    const buf = await res.arrayBuffer();
    addFiles([new File([buf], '샘플 로어북.json', { type: 'application/json' })]);
  } catch (_) { toast('샘플을 불러오지 못했어요 — 네트워크를 확인하세요'); }
}
function buildEmpty() {
  const wrap = document.createElement('div');
  wrap.className = 'empty';
  const col = document.createElement('div');
  col.className = 'empty-col';
  const dz = document.createElement('div');
  dz.className = 'dropzone';
  dz.onclick = pickFiles;
  const steps = [
    ['1', '리스에서 봇카드·모듈 내보내기'],
    ['2', '여기에 놓거나 클릭'],
    ['3', '읽고 · 번역하고 · 내보내기'],
  ].map(([n, t]) => `<span class="drop-step"><b>${n}</b>${t}</span>`).join('');
  dz.innerHTML = `<div class="drop-icon">${ICON(76)}</div>`
    + '<div class="drop-title">봇카드 속 로어북을 꺼내 읽어보세요</div>'
    + '<div class="drop-ext">.charx · .png · .json · .jpeg · .risum — 파일은 기기 밖으로 나가지 않아요</div>'
    + `<div class="drop-steps">${steps}</div>`;
  col.appendChild(dz);
  const trial = document.createElement('div');
  trial.className = 'empty-actions';
  const sampleBtn = button('샘플 로어북 구경하기', loadSample, 'ghost');
  trial.append(span('empty-hint', '처음이신가요?'), sampleBtn);
  col.appendChild(trial);
  wrap.appendChild(col);
  return wrap;
}
// 요약 = 통계(버튼처럼 안 보이게: 숫자 강조 + 라벨 흐림). 종류는 뱃지 하나만.
function statPair(value: string, label: string) {
  const s = document.createElement('span');
  s.className = 'stat';
  const b = document.createElement('b'); b.textContent = value;
  s.append(b, document.createTextNode(label));
  return s;
}
function buildSummary() {
  const st = loreStats(effLore().entries);
  const tk = estimateLorebookTokens(effLore().entries);
  const bar = document.createElement('section');
  bar.className = 'summary';
  const title = document.createElement('div');
  title.className = 'book-title';
  title.append(
    span('book-name', lore.bookName || parsed?.name || '로어북'),
    span('kind-badge', lore.kind === 'module' ? '리스 모듈' : lore.kind === 'risu-export' ? '로어북 파일' : '봇카드'),
  );
  bar.appendChild(title);
  bar.append(
    statPair(String(st.total), '엔트리'),
    statPair(String(st.constant), '언제나 활성화'),
    ...(st.disabled ? [statPair(String(st.disabled), '비활성')] : []),
    statPair(fmtChars(st.chars), '자'),
    statPair('~' + tinyTok(tk.total), '토큰'),
  );
  bar.appendChild(span('spacer', ''));
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'search';
  search.placeholder = '이름, 키워드, 본문 검색';
  search.value = query;
  search.oninput = () => { query = search.value; renderBody(); };
  bar.appendChild(search);
  return bar;
}
function buildWorkspace() {
  const ws = document.createElement('section');
  ws.className = 'workspace pane-' + mobilePane;   // 좁은 화면에서만 의미(둘 중 하나 숨김)
  ws.append(buildEntryList(), buildReader());
  return ws;
}
function buildEntryList() {
  const panel = document.createElement('aside');
  panel.className = 'entry-list';
  const head = document.createElement('div');
  head.className = 'list-head';
  const filterSel = document.createElement('select');
  [['all', '전체'], ['constant', '언제나 활성화'], ['conditional', '조건부'], ['disabled', '비활성']].forEach(([v, t]) => filterSel.appendChild(new Option(t, v)));
  filterSel.value = filter;
  filterSel.onchange = () => { filter = filterSel.value as FilterMode; renderBody(); };
  const sortSel = document.createElement('select');
  [['order', '배치 순서'], ['name', '이름순'], ['length', '본문 긴순']].forEach(([v, t]) => sortSel.appendChild(new Option(t, v)));
  sortSel.value = sort;
  sortSel.onchange = () => { sort = sortSel.value as SortMode; renderBody(); };
  head.append(filterSel, sortSel);
  panel.appendChild(head);
  const scroll = document.createElement('div');
  scroll.className = 'list-scroll';
  const groups = groupsForList();
  if (!groups.length) scroll.appendChild(div('empty-reader', '검색 결과가 없습니다.'));
  for (const g of groups) {
    const title = document.createElement('div');
    title.className = 'folder-title';
    title.textContent = g.folder ? `▸ ${displayName(g.folder)} (${g.items.length})` : `루트 (${g.items.length})`;
    scroll.appendChild(title);
    for (const e of g.items) scroll.appendChild(entryRow(e));
  }
  const addBtn = button('+ 새 엔트리', addNewEntry, 'ghost');
  addBtn.className = 'ghost add-entry';
  scroll.appendChild(addBtn);
  // 삭제 예정(소프트) — 복구 가능
  const removedList = lore.entries.filter((e: any) => !e.isFolder && removedUids[e.uid]);
  if (removedList.length) {
    const t = document.createElement('div');
    t.className = 'folder-title';
    t.textContent = `삭제 예정 (${removedList.length}) — 내보내기에서 빠져요`;
    scroll.appendChild(t);
    for (const e of removedList) {
      const row = document.createElement('div');
      row.className = 'entry-row removed';
      row.append(span('entry-title', displayName(eff(e))));
      const rb = button('복구', () => { delete removedUids[e.uid]; glossaryRows = null; refreshIssueMap(); saveDraft(); renderBody(); });
      rb.className = 'restore-btn';
      row.appendChild(rb);
      scroll.appendChild(row);
    }
  }
  panel.appendChild(scroll);
  return panel;
}

// ── 라이트 편집 동작 ─────────────────────────────────────────────────────
function addNewEntry() {
  const u = 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const maxOrder = realEntries().reduce((m: number, e: any) => Math.max(m, e.order || 0), 0);
  addedEntries.push({ uid: u, name: '새 엔트리', keys: [], secondaryKeys: [], content: '', enabled: true, constant: false, selective: false, useRegex: false, order: maxOrder + 1, position: '', folder: '', isFolder: false, raw: null });
  selectedUid = u; editingUid = u; readerTab = 'read'; mobilePane = 'reader';
  saveDraft();
  renderBody();
}
function deleteEntry(e: any) {
  if (e.raw) removedUids[e.uid] = true;
  else addedEntries = addedEntries.filter((x) => x.uid !== e.uid);
  if (editingUid === e.uid) editingUid = null;
  glossaryRows = null; refreshIssueMap(); saveDraft();
  statusText = '삭제 예정으로 옮겼어요 — 목록 맨 아래에서 복구할 수 있어요.';
  renderBody();
}
function saveEdit(e: any, f: any) {
  const fields = {
    name: f.name.value.trim(),
    keys: f.keys.value.split(',').map((x: string) => x.trim()).filter(Boolean),
    secondaryKeys: f.second.value.split(',').map((x: string) => x.trim()).filter(Boolean),
    content: f.content.value,
    constant: f.constant.checked,
    selective: f.selective.checked,
    useRegex: f.useRegex.checked,
    enabled: f.enabled.checked,
  };
  if (!e.raw) {
    const t = addedEntries.find((x) => x.uid === e.uid);
    if (t) Object.assign(t, fields);
  } else {
    edits[e.uid] = fields;
  }
  delete translations[e.uid];   // 원문이 바뀌었으니 옛 번역은 무효
  editingUid = null;
  glossaryRows = null; refreshIssueMap(); saveDraft();
  statusText = '엔트리를 저장했어요(초안 자동 보존).';
  renderBody();
}
// 목록 행 = 스캔 도구: 상시활성=좌측 초록 보더 · 비활성=흐림 · 선택=서표 리본(CSS) ·
//   키워드=칩 미리보기 · 우측=분량(토큰)+진단 경고 도트.
function entryRow(e: any) {
  const row = document.createElement('button');
  row.className = 'entry-row'
    + (e.uid === selectedUid ? ' active' : '')
    + (e.constant ? ' constant' : '')
    + (!e.enabled ? ' off' : '');
  row.onclick = () => { selectedUid = e.uid; readerTab = 'read'; mobilePane = 'reader'; renderBody(); };
  row.append(span('entry-title', displayName(e)));
  const meta = document.createElement('span');
  meta.className = 'entry-meta';
  const sev = issueSevByUid[e.uid];
  if (sev) { const w = span('issue-dot ' + sev, ''); w.title = '진단 탭에서 확인할 문제가 있어요'; meta.appendChild(w); }
  if (edits[e.uid] || !e.raw) { const d = span('edit-dot', '✎'); d.title = edits[e.uid] ? '편집됨' : '새 엔트리'; meta.appendChild(d); }
  if (translations[e.uid]) { const t = span('tr-dot', ''); t.title = '번역됨'; meta.appendChild(t); }
  meta.appendChild(span('entry-tok', tinyTok(estimateEntryTokens(e))));
  row.appendChild(meta);
  const chipsRow = document.createElement('span');
  chipsRow.className = 'entry-keys';
  if (e.keys.length) {
    e.keys.slice(0, 3).forEach((k: string) => chipsRow.appendChild(span('keychip mini', k)));
    if (e.keys.length > 3) chipsRow.appendChild(span('keychip mini more', '+' + (e.keys.length - 3)));
  } else {
    chipsRow.appendChild(span('entry-nokey', e.constant ? '언제나 활성화' : '활성화 키 없음'));
  }
  row.appendChild(chipsRow);
  return row;
}
function buildReader() {
  const panel = document.createElement('article');
  panel.className = 'reader';
  panel.appendChild(buildReaderTabs());
  if (readerTab === 'diagnose') {
    panel.appendChild(buildDiagnoseView());
    return panel;
  }
  if (readerTab === 'activate') {
    panel.appendChild(buildActivateView());
    return panel;
  }
  if (readerTab === 'glossary') {
    panel.appendChild(buildGlossaryView());
    return panel;
  }
  if (readerTab === 'export') {
    panel.appendChild(buildExportView());
    return panel;
  }
  const e = selectedEntry();
  if (!e) {
    panel.appendChild(div('empty-reader', '엔트리를 선택하세요.'));
    return panel;
  }
  if (editingUid === e.uid) {
    panel.appendChild(buildEditForm(e));
    return panel;
  }
  const content = displayContent(e);
  const split = splitDecorators(content);
  // ── 종이 페이지(스크롤) 안에 색인 카드 헤더 + 조판된 본문 — "설정집을 책처럼" ──
  const page = document.createElement('div');
  page.className = 'reader-page';
  const sheet = document.createElement('div');
  sheet.className = 'page-sheet';
  const head = document.createElement('div');
  head.className = 'reader-head';
  const eyebrow = document.createElement('div');
  eyebrow.className = 'entry-eyebrow';
  const folderName = e.folder ? (lore.entries.find((f: any) => f.isFolder && (f.raw.id === e.folder || f.raw.key === e.folder || f.name === e.folder))?.name || '') : '';
  eyebrow.append(
    span('eyebrow-kind', folderName || (lore.bookName || '로어북')),
    span('eyebrow-pos', `${tinyTok(estimateEntryTokens(e))} 토큰 · ${fmtChars((split.body || content).length)}자`),
  );
  head.appendChild(eyebrow);
  const title = document.createElement('div');
  title.className = 'reader-title';
  const h = document.createElement('h1');
  h.textContent = displayName(e);
  title.appendChild(h);
  const badges = document.createElement('div');
  badges.className = 'entry-flags';
  if (e.constant) badges.appendChild(span('badge constant', '언제나 활성화'));
  if (!e.enabled) badges.appendChild(span('badge disabled', '비활성'));
  if (e.useRegex) badges.appendChild(span('badge regex', '정규식'));
  title.appendChild(badges);
  head.appendChild(title);
  // 표제어 줄: 발동 키워드(원문 고정) + 2차 키 + 데코레이터 — 각각 라벨로 구분.
  const keyline = document.createElement('div');
  keyline.className = 'chipline';
  if (e.keys.length) {
    keyline.appendChild(span('chip-label', '활성화 키'));
    e.keys.forEach((k: string) => keyline.appendChild(span('keychip', k)));
  }
  if (keyAdds[e.uid] && keyAdds[e.uid].length) {
    keyline.appendChild(span('chip-label added-label', '+ 추가 활성화 키'));
    keyAdds[e.uid].forEach((k: string) => keyline.appendChild(span('keychip added', k)));
  }
  if (e.secondaryKeys.length) {
    keyline.appendChild(span('chip-label', '+ 두번째 키'));
    e.secondaryKeys.forEach((k: string) => keyline.appendChild(span('keychip second', k)));
  }
  if (!e.keys.length && !e.secondaryKeys.length) keyline.appendChild(span('chip-label', e.constant ? '활성화 키 없이 언제나 포함되는 설정' : '활성화 키 없음'));
  head.appendChild(keyline);
  if (split.decorators.length) {
    const deco = document.createElement('div');
    deco.className = 'chipline deco-line';
    deco.appendChild(span('chip-label', '데코레이터'));
    split.decorators.forEach((d: string) => deco.appendChild(span('decorator', d)));
    head.appendChild(deco);
  }
  const acts = document.createElement('div');
  acts.className = 'reader-actions';
  const rawBtn = button(mdRaw ? '렌더 보기' : '원문 보기', () => { mdRaw = !mdRaw; renderBody(); }, 'ghost');
  rawBtn.title = '마크다운 렌더 ↔ 원문 그대로';
  acts.append(
    button('편집', () => { editingUid = e.uid; renderBody(); }),
    button('본문 복사', () => copyText(split.body || content)),
    button('Markdown 복사', () => copyText(entryMarkdown(e))),
    rawBtn,
    button('이 엔트리 번역', () => translateEntries([e]), 'primary'),
  );
  head.appendChild(acts);
  sheet.appendChild(head);
  const body = document.createElement('div');
  body.className = 'reader-body' + (mdRaw ? ' raw' : '');
  const text = split.body || content || '';
  if (!text.trim()) body.textContent = '(본문 없음)';
  else if (mdRaw) body.textContent = text;
  else body.innerHTML = renderMdLite(text);   // mdlite = 전체 이스케이프 후 화이트리스트 태그만 생성(XSS 안전, 테스트로 고정)
  sheet.appendChild(body);
  page.appendChild(sheet);
  panel.appendChild(page);
  return panel;
}

// 편집 폼 — 원본 위 오버레이(저장=edits/addedEntries, 원본 불변). 편집 중엔 읽기 뷰 대체.
function buildEditForm(e: any) {
  const page = document.createElement('div');
  page.className = 'reader-page';
  const sheet = document.createElement('div');
  sheet.className = 'page-sheet edit-sheet';
  const head = document.createElement('div');
  head.className = 'reader-head';
  head.appendChild(span('eyebrow-kind', e.raw ? '엔트리 편집' : '새 엔트리'));
  const f: any = {};
  const fld = (label: string, el: HTMLElement, hint?: string) => { const w = document.createElement('div'); w.className = 'field'; const l = document.createElement('label'); l.textContent = label; w.append(l, el); if (hint) { const sm = document.createElement('small'); sm.textContent = hint; w.appendChild(sm); } return w; };
  f.name = inputEl(e.name || '');
  f.keys = inputEl(e.keys.join(', '));
  f.second = inputEl(e.secondaryKeys.join(', '));
  f.content = document.createElement('textarea');
  f.content.className = 'edit-content';
  f.content.value = e.content || '';
  const mk = (checked: boolean) => { const c = document.createElement('input'); c.type = 'checkbox'; c.checked = checked; return c; };
  f.constant = mk(!!e.constant); f.selective = mk(!!e.selective); f.useRegex = mk(!!e.useRegex); f.enabled = mk(e.enabled !== false);
  const toggles = document.createElement('div');
  toggles.className = 'edit-toggles';
  const tg = (el: HTMLInputElement, label: string) => { const w = document.createElement('label'); w.className = 'toggle'; w.append(el, document.createTextNode(label)); return w; };
  toggles.append(tg(f.constant, '언제나 활성화'), tg(f.selective, '멀티플 키'), tg(f.useRegex, '정규식 사용'), tg(f.enabled, '활성'));
  const body = document.createElement('div');
  body.className = 'edit-body settings-body';
  body.append(
    fld('이름', f.name),
    fld('활성화 키', f.keys, '쉼표로 구분'),
    fld('두번째 키', f.second, '멀티플 키일 때만 사용돼요'),
    toggles,
    fld('본문', f.content),
  );
  const acts = document.createElement('div');
  acts.className = 'reader-actions edit-acts';
  acts.append(
    button('저장', () => saveEdit(e, f), 'primary'),
    button('취소', () => { editingUid = null; renderBody(); }),
  );
  if (e.raw && edits[e.uid]) acts.appendChild(button('원본으로 되돌리기', () => { delete edits[e.uid]; delete translations[e.uid]; editingUid = null; glossaryRows = null; refreshIssueMap(); saveDraft(); renderBody(); }));
  acts.appendChild(button('이 엔트리 삭제', () => deleteEntry(e)));
  head.appendChild(acts);
  sheet.append(head, body);
  page.appendChild(sheet);
  panelScroll(page);
  return page;
}
function panelScroll(_el: HTMLElement) { /* 자리표시 — reader-page가 자체 스크롤 */ }

function buildReaderTabs() {
  const tabs = document.createElement('div');
  tabs.className = 'reader-tabs';
  const back = button('← 목록', () => { mobilePane = 'list'; renderBody(); }, 'ghost');
  back.className = 'mob-back';   // 좁은 화면에서만 보임(CSS)
  tabs.appendChild(back);
  const items: [ReaderTab, string][] = [['read', '읽기'], ['diagnose', '진단'], ['activate', '활성화 테스트'], ['glossary', '용어집'], ['export', '내보내기']];
  for (const [id, label] of items) {
    const b = button(label, () => { readerTab = id; renderBody(); });
    b.className = 'tab' + (readerTab === id ? ' active' : '');
    tabs.appendChild(b);
  }
  return tabs;
}

function severityLabel(s: string) {
  if (s === 'error') return '오류';
  if (s === 'warning') return '주의';
  return '참고';
}

function buildDiagnoseView() {
  const report = diagnoseLorebook(effLore(), { tokenBudget: lore.tokenBudget });
  const body = document.createElement('div');
  body.className = 'reader-tab-body analysis-body';
  const summary = document.createElement('div');
  summary.className = 'analysis-summary';
  summary.append(
    stat(`오류 ${report.counts.error}`),
    stat(`주의 ${report.counts.warning}`),
    stat(`참고 ${report.counts.info}`),
    stat(`전체 ${fmtChars(report.tokenStats.total)}토큰`),
    stat(`언제나 활성화 ${fmtChars(report.tokenStats.constant)}토큰`),
  );
  body.appendChild(summary);
  if (!report.issues.length) {
    body.appendChild(div('empty-reader', '눈에 띄는 문제를 찾지 못했습니다.'));
    return body;
  }
  const list = document.createElement('div');
  list.className = 'issue-list';
  for (const it of report.issues) {
    const row = document.createElement('button');
    row.className = `issue-row ${it.severity}`;
    row.onclick = () => {
      if (it.uid) {
        selectedUid = it.uid;
        readerTab = 'read';
        renderBody();
      }
    };
    row.append(
      span(`issue-severity ${it.severity}`, severityLabel(it.severity)),
      span('issue-title', it.title),
      span('issue-entry', it.entryName || '전체 로어북'),
      span('issue-detail', it.detail || it.code),
    );
    list.appendChild(row);
  }
  body.appendChild(list);
  return body;
}

function buildActivateView() {
  const body = document.createElement('div');
  body.className = 'reader-tab-body analysis-body';
  const help = document.createElement('p');
  help.className = 'panel-note';
  help.textContent = '최근 대화나 테스트 문장을 붙여넣으면 어떤 로어북 엔트리가 발동되는지 계산합니다.';
  body.appendChild(help);
  const input = document.createElement('textarea');
  input.className = 'activation-input';
  input.placeholder = '예: I draw my sword and prepare for battle...';
  input.value = activationText;
  input.oninput = () => { activationText = input.value; activationRan = false; };
  body.appendChild(input);
  const actions = document.createElement('div');
  actions.className = 'reader-actions';
  actions.append(
    button('테스트 실행', () => { activationText = input.value; activationRan = true; renderBody(); }, 'primary'),
    button('비우기', () => { activationText = ''; activationRan = false; renderBody(); }),
  );
  body.appendChild(actions);
  if (!activationRan) {
    body.appendChild(div('analysis-placeholder', '문장을 입력하고 테스트를 실행하세요.'));
    return body;
  }
  const result = simulateActivation(lore, activationText);
  const summary = document.createElement('div');
  summary.className = 'analysis-summary';
  summary.append(
    stat(`발동 ${result.active.length}`),
    stat(`미발동 ${result.inactive.length}`),
    stat(`활성 ${fmtChars(result.tokenTotal)}토큰`),
    result.tokenBudget ? stat(`예산 ${fmtChars(result.budgetUsed)}/${fmtChars(result.tokenBudget)}`) : stat('예산 없음'),
  );
  body.appendChild(summary);
  if (result.budgetDropped.length) body.appendChild(div('budget-warning', `로어북 최대 토큰 때문에 ${result.budgetDropped.length}개 엔트리가 밀릴 수 있습니다.`));
  body.appendChild(buildActivationList('발동된 엔트리', result.active, true));
  body.appendChild(buildActivationList('미발동 엔트리', result.inactive, false));
  return body;
}

function buildActivationList(title: string, rows: any[], active: boolean) {
  const box = document.createElement('div');
  box.className = 'activation-section';
  const h = document.createElement('h3');
  h.textContent = `${title} (${rows.length})`;
  box.appendChild(h);
  if (!rows.length) {
    box.appendChild(div('analysis-placeholder', active ? '발동된 엔트리가 없습니다.' : '모든 엔트리가 발동되었습니다.'));
    return box;
  }
  for (const r of rows.slice(0, active ? 80 : 120)) {
    const row = document.createElement('button');
    row.className = 'activation-row' + (active ? ' active' : '');
    row.onclick = () => { selectedUid = r.uid; readerTab = 'read'; renderBody(); };
    row.append(
      span('activation-name', r.name || '(이름 없음)'),
      span('activation-reason', reasonText(r)),
      span('activation-token', `${r.tokens}t`),
    );
    box.appendChild(row);
  }
  return box;
}

function reasonText(r: any) {
  const map: Record<string, string> = {
    constant: '언제나 활성화',
    primary: `키워드: ${r.key}`,
    primary_secondary: `키+2차키: ${r.key} + ${r.secondaryKey}`,
    regex: `정규식: ${r.key}`,
    disabled: '비활성',
    no_keys: '키워드 없음',
    primary_missing: '1차 키 불일치',
    secondary_missing: '두번째 키 불일치',
    secondary_missing_config: '두번째 키 설정 없음',
    invalid_regex: '정규식 오류',
  };
  return map[r.reason] || r.detail || r.reason || '';
}

function buildExportView() {
  const body = document.createElement('div');
  body.className = 'reader-tab-body analysis-body';
  const note = document.createElement('p');
  note.className = 'panel-note';
  note.textContent = '현재 보기 상태 그대로 저장해요. 키워드는 항상 원문.';
  body.appendChild(note);
  const grid = document.createElement('div');
  grid.className = 'export-grid';
  grid.append(
    exportCard('원본 형식으로 저장', '번역·추가 키·편집을 반영해 원본과 같은 파일(.charx/.png/.jpeg/.json/.risum)로. 리스에서 카드만 바꾸면 끝.', () => exportRepacked()),
    exportCard('Markdown', '읽기와 공유에 좋은 문서 형식입니다.', () => exportMarkdown()),
    exportCard('CCv3 JSON', '표준 character_book 형식으로 다시 넣기 좋습니다.', () => exportCharacterBook()),
    exportCard('정규화 JSON', '분석/백업용 통합 스키마입니다.', () => exportNormalized()),
    exportCard('전체 복사', '현재 원문/번역 보기 상태의 Markdown을 클립보드에 복사합니다.', () => copyText(buildMarkdown(effLore(), showTranslated ? translations : null, 'tr', keyAdds))),
  );
  body.appendChild(grid);
  return body;
}

function exportCard(title: string, desc: string, onClick: any) {
  const card = document.createElement('div');
  card.className = 'export-card';
  const h = document.createElement('h3');
  h.textContent = title;
  const p = document.createElement('p');
  p.textContent = desc;
  card.append(h, p, button('실행', onClick, 'primary'));
  return card;
}
function buildBottomActions() {
  const bar = document.createElement('section');
  bar.className = 'bottom-actions';
  const toggle = document.createElement('label');
  toggle.className = 'toggle';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = showTranslated;
  cb.onchange = () => { showTranslated = cb.checked; renderBody(); };
  toggle.append(cb, document.createTextNode('번역 보기'));
  bar.appendChild(toggle);
  bar.append(
    button('전체 번역', () => translateEntries(realEntries()), 'primary'),
    button('활성화 키 번역 추가', openArmModal),
    button('전체 복사', () => copyText(buildMarkdown(effLore(), showTranslated ? translations : null, 'tr', keyAdds))),
    button('Markdown 저장', () => exportMarkdown()),
    button('CCv3 JSON 저장', () => exportCharacterBook()),
    button('정규화 JSON 저장', () => exportNormalized()),
  );
  if (hasDraftState()) {
    const d = button('초안 버리기', () => { if (confirm('편집·추가 키 초안을 모두 버리고 원본으로 되돌릴까요?')) discardDraft(); }, 'ghost');
    d.title = '편집·삭제·추가 키를 모두 버리고 원본으로';
    bar.appendChild(d);
  }
  bar.appendChild(span('status', translating ? '번역 중...' : statusText));
  return bar;
}

function entryMarkdown(e: any) {
  const tr = showTranslated ? translations : null;
  const v = tr && tr[e.uid] ? tr[e.uid] : {};
  const name = v.name || e.name || e.keys[0] || '(이름 없음)';
  const content = v.content || e.content || '';
  const lines = [`### ${name}`];
  if (e.keys.length) lines.push(`- 활성화 키: ${e.keys.join(', ')}`);
  if (keyAdds[e.uid] && keyAdds[e.uid].length) lines.push(`- 추가 활성화 키: ${keyAdds[e.uid].join(', ')}`);
  if (e.secondaryKeys.length) lines.push(`- 두번째 키: ${e.secondaryKeys.join(', ')}`);
  lines.push('', content);
  return lines.join('\n');
}
function exportBaseName() {
  const chip = chips.find((c) => c.id === currentId);
  return safeName(lore?.bookName || parsed?.name || chip?.name || 'lorebook');
}
// 원본 형식 내보내기 — 원본 바이트에서 카드 JSON만 수술 교체(에셋·그림·메타 바이트 보존).
async function exportRepacked() {
  const chip = chips.find((c) => c.id === currentId);
  if (!chip || !lore || !parsed) return;
  try {
    const bytes = await chip.read();
    const tr = showTranslated ? translations : null;
    const finalEntries = effLore().entries.map((e: any) => (e.isFolder ? e : {
      ...e,
      name: tr && tr[e.uid] && tr[e.uid].name ? tr[e.uid].name : e.name,
      content: tr && tr[e.uid] && tr[e.uid].content ? tr[e.uid].content : e.content,
      keys: mergedKeys(e, keyAdds),
    }));
    const json = applyLorebookToCard(parsed.card, lore.kind, finalEntries);
    const { bytes: out, ext } = repackCard(bytes, json);
    const base = safeName((chip.name || 'card').replace(/\.[^.]+$/, ''));
    downloadBlob(new Blob([out]), `${base}_수정.${ext}`);
    toast('원본 형식으로 저장했어요');
  } catch (e) { toast('저장 실패: ' + ((e && e.message) || e)); }
}
function exportMarkdown() {
  downloadText(buildMarkdown(effLore(), showTranslated ? translations : null, 'tr', keyAdds), exportBaseName() + '.md');
}
function exportCharacterBook() {
  const data = buildCharacterBook(effLore(), showTranslated ? translations : null, 'tr', keyAdds);
  downloadText(JSON.stringify(data, null, 2), exportBaseName() + '.character_book.json', 'application/json;charset=utf-8');
}
function exportNormalized() {
  const data = {
    source: chips.find((c) => c.id === currentId)?.name || '',
    kind: lore.kind,
    bookName: lore.bookName,
    entries: effLore().entries.map((e: any) => ({
      ...e,
      displayName: displayName(e),
      displayContent: displayContent(e),
      ...(keyAdds[e.uid] && keyAdds[e.uid].length ? { addedKeys: keyAdds[e.uid].slice() } : {}),
      raw: undefined,
    })),
  };
  downloadText(JSON.stringify(data, null, 2), exportBaseName() + '.normalized.json', 'application/json;charset=utf-8');
}

// ── 용어집 — 로어북 고유명사 표기 쌍을 뽑아 리스/기가트랜스 번역 프롬프트에 붙여넣게 함(표기 일관성).
//   추출은 결정론(키 속 다국어 변형 짝짓기, glossary.js) → 빈 번역만 선택적 LLM 채움.
const GLOSSARY_PROMPT = '입력은 롤플레이 설정의 고유명사(인명·지명·용어)입니다. 한국어 관용 표기(음차 또는 통용 번역) 딱 하나만 출력하세요. 설명·따옴표를 붙이지 마세요.';

function glossary(): any[] {
  if (!glossaryRows) glossaryRows = extractGlossary(effLore().entries);
  return glossaryRows;
}

async function fillGlossary() {
  if (translating) return;
  try { await ensureTranslateReady(); }
  catch (e) { toast(e.message || String(e)); settingsOpen = true; render(); return; }
  const rows = glossary().filter((r: any) => !r.ko);
  if (!rows.length) { toast('채울 빈 번역이 없어요 — 이미 전부 짝지어져 있습니다.'); return; }
  const jobs = rows.map((r: any) => ({ uid: r.term, field: 'gloss', text: r.term }));
  translating = true;
  statusText = '용어 번역 준비 중...';
  renderBody();
  try {
    const res = await translateJobs(jobs, {
      stylePrompt: GLOSSARY_PROMPT,
      skipKorean: false,
      onProgress: (d: number, t: number) => { statusText = `용어 번역 중 ${d}/${t}`; renderBody(); },
    });
    let filled = 0;
    res.blocks.forEach((text: any, i: number) => {
      const v = String(text == null ? '' : text).trim().split('\n')[0].replace(/^["'「]|["'」]$/g, '');
      if (v && v.toLowerCase() !== rows[i].term.toLowerCase()) { rows[i].ko = v; rows[i].llm = true; filled++; }
    });
    statusText = `용어 ${filled}개 번역 완료`;
    if (res.failed.length) statusText += ` · 실패 ${res.failed.length}: ${res.failed[0].error}`;
  } catch (e) { statusText = '용어 번역 실패: ' + ((e && e.message) || e); }
  translating = false;
  renderBody();
}

function buildGlossaryView() {
  const box = document.createElement('div');
  box.className = 'reader-tab-body analysis-body';
  const rows = glossary();
  const paired = rows.filter((r: any) => r.ko).length;
  const empty = rows.length - paired;
  const summary = document.createElement('div');
  summary.className = 'analysis-summary';
  summary.append(
    statPair(String(rows.length), '용어'),
    statPair(String(paired), '짝지어짐'),
    ...(empty ? [statPair(String(empty), '빈칸')] : []),
  );
  box.appendChild(summary);
  const note = document.createElement('p');
  note.className = 'panel-note';
  note.textContent = '로어북에서 뽑은 고유명사 표기 쌍이에요.';
  box.appendChild(note);
  const acts = document.createElement('div');
  acts.className = 'reader-actions';
  const copyBtn = button('프롬프트용 복사', () => {
    const t = buildGlossaryText(rows);
    if (!t) { toast('복사할 쌍이 없어요 — 먼저 빈 번역을 채우세요.'); return; }
    copyText(t);
  }, 'primary');
  acts.append(
    ...(empty ? [button(`빈 번역 채우기 (${empty}개)`, fillGlossary)] : []),
    copyBtn,
    button('.txt 저장', () => {
      const t = buildGlossaryText(rows);
      if (!t) { toast('저장할 쌍이 없어요 — 먼저 빈 번역을 채우세요.'); return; }
      downloadText(t, exportBaseName() + '.glossary.txt');
    }),
  );
  box.appendChild(acts);
  if (!rows.length) {
    box.appendChild(div('analysis-placeholder', '고유명사를 찾지 못했어요.'));
    return box;
  }
  const list = document.createElement('div');
  list.className = 'gloss-list';
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'gloss-row' + (r.ko ? '' : ' empty');
    row.append(
      span('gloss-term', r.term),
      span('gloss-eq', '='),
      span('gloss-ko' + (r.llm ? ' llm' : ''), r.ko || '—'),
      span('gloss-src', r.source || ''),
    );
    list.appendChild(row);
  }
  box.appendChild(list);
  return box;
}

// ── 발동 키 다국어 무장 — 채팅 언어와 키 언어가 다르면 로어북이 발동하지 않는 구조적 구멍을 메움.
//   원본 키는 절대 대체하지 않고 번역 키를 "추가"만(중복 제거) → 내보내기(CCv3/MD)에 반영 → 리스에 되넣으면
//   그 언어 채팅에서도 발동. 정규식 키 엔트리는 제외(패턴 번역=파손 위험).
const KEY_ARM_PROMPT = (lang: string) =>
  `입력은 로어북 활성화 키 목록(쉼표 구분)입니다. 각 키워드를 ${lang} 채팅에서 실제로 쓸 법한 표현으로 번역하세요. ` +
  `반드시 쉼표로 구분해 같은 개수·같은 순서로만 출력하고, 설명·번호·다른 말은 붙이지 마세요. ` +
  `인명·지명 같은 고유명사는 ${lang} 관용 표기(음차)로 적으세요.`;

async function armKeys(lang: string) {
  if (translating) return;
  try { await ensureTranslateReady(); }
  catch (e) { toast(e.message || String(e)); settingsOpen = true; render(); return; }
  const targets = realEntries().filter((e: any) => e.keys.length && !e.useRegex);
  if (!targets.length) { toast('번역할 활성화 키가 없어요(정규식 키 엔트리는 제외).'); return; }
  const jobs = targets.map((e: any) => ({ uid: e.uid, field: 'keys:' + lang, text: e.keys.join(', ') }));
  translating = true;
  statusText = '활성화 키 번역 준비 중...';
  renderBody();
  try {
    const res = await translateJobs(jobs, {
      stylePrompt: KEY_ARM_PROMPT(lang),
      targetLang: lang,
      skipKorean: false,   // 한국어 키도 대상(예: 한국어 키 → 일본어 무장)
      onProgress: (d: number, t: number) => { statusText = `활성화 키 번역 중 ${d}/${t}`; renderBody(); },
    });
    let added = 0, armed = 0;
    res.blocks.forEach((text: any, i: number) => {
      const e = targets[i];
      if (text == null) return;
      const have = new Set(e.keys.map((k: string) => k.toLowerCase()));
      (keyAdds[e.uid] || []).forEach((k: string) => have.add(k.toLowerCase()));
      const fresh = String(text).split(',').map((s) => s.trim()).filter(Boolean)
        .filter((k) => { const l = k.toLowerCase(); if (have.has(l)) return false; have.add(l); return true; });
      if (fresh.length) { keyAdds[e.uid] = (keyAdds[e.uid] || []).concat(fresh); added += fresh.length; armed++; }
    });
    saveDraft();
    statusText = added
      ? `활성화 키 번역 추가 — ${armed}개 엔트리에 ${lang} 키 ${added}개 추가`
      : '추가할 새 키가 없었어요.';
    // 실패 사유를 삼키지 않는다 — 전멸(키·모델·CORS 오류)의 원인을 사용자가 바로 보게.
    if (res.failed.length) statusText += ` · 실패 ${res.failed.length}: ${res.failed[0].error}`;
  } catch (e) { statusText = '활성화 키 번역 실패: ' + ((e && e.message) || e); }
  translating = false;
  renderBody();
}

function openArmModal() {
  const ov = document.createElement('div');
  ov.className = 'modal';
  const close = () => ov.remove();
  ov.onclick = (e) => { if (e.target === ov) close(); };
  const panel = document.createElement('div');
  panel.className = 'settings-panel arm-panel';
  const head = document.createElement('div');
  head.className = 'settings-head';
  head.innerHTML = '<h2>활성화 키 번역 추가</h2>';
  head.appendChild(button('닫기', close));
  panel.appendChild(head);
  const body = document.createElement('div');
  body.className = 'settings-body';
  const info = document.createElement('p');
  info.className = 'panel-note';
  info.textContent = '원본 키는 그대로 두고 선택한 언어의 번역 키를 추가해요. 내보내서 리스에 넣으면 그 언어 채팅에서도 발동합니다.';
  body.appendChild(info);
  const langSel = selectEl([['일본어', '일본어'], ['한국어', '한국어'], ['영어', '영어'], ['중국어', '중국어']], '일본어');
  body.appendChild(field('추가할 키 언어', langSel, '정규식 키는 제외, 같은 키는 중복 추가 안 됨.'));
  const armedNow = Object.values(keyAdds).reduce((n, a) => n + a.length, 0);
  const acts = document.createElement('div');
  acts.className = 'reader-actions';
  acts.appendChild(button('무장 시작', () => { close(); armKeys(langSel.value); }, 'primary'));
  if (armedNow) acts.appendChild(button(`추가 키 모두 지우기 (${armedNow}개)`, () => { keyAdds = {}; saveDraft(); close(); statusText = '추가 키를 모두 지웠어요.'; renderBody(); }));
  body.appendChild(acts);
  panel.appendChild(body);
  ov.appendChild(panel);
  document.body.appendChild(ov);
}

async function translateEntries(entries: any[], force = false) {
  if (!entries.length || translating) return;
  try {
    await ensureTranslateReady();
  } catch (e) {
    toast(e.message || String(e));
    settingsOpen = true;
    render();
    return;
  }
  const prefs = getTranslatePrefs();
  const jobs: any[] = [];
  for (const e of entries) {
    const cur = translations[e.uid] || {};
    if (prefs.translateNames !== false && e.name && (force || !cur.name)) {
      jobs.push({ uid: e.uid, field: 'name', text: e.name, prefix: '', suffix: '' });
    }
    if (force || !cur.content) {
      const split = splitDecorators(e.content);
      const prefix = split.decorators.length ? split.decorators.join('\n') + '\n\n' : '';
      jobs.push({ uid: e.uid, field: 'content', text: split.body || e.content, prefix, suffix: '' });
    }
  }
  if (!jobs.length) {
    setStatus('이미 번역되어 있습니다.');
    return;
  }
  translating = true;
  statusText = '번역 준비 중...';
  renderBody();
  try {
    const res = await translateJobs(jobs, {
      force,
      onProgress: (done: number, total: number) => {
        statusText = `번역 중 ${done}/${total}`;
        renderBody();
      },
    });
    res.blocks.forEach((text: string, i: number) => {
      const j = jobs[i];
      translations[j.uid] = translations[j.uid] || {};
      translations[j.uid][j.field] = j.prefix + text + j.suffix;
    });
    statusText = res.failed.length
      ? `일부 실패: ${res.failed.length}개 · 성공/캐시 ${res.translated}개 — ${res.failed[0].error}`
      : `번역 완료: ${res.translated}개${res.cached ? ` (캐시 ${res.cached}개)` : ''}`;
    showTranslated = true;
    toast('번역 완료');
  } catch (e) {
    console.warn('[lorebook] translate failed', e);
    statusText = e.message || String(e);
    toast('번역 실패');
  } finally {
    translating = false;
    renderBody();
  }
}

function renderSettings() {
  const cfg = getWebConfig();
  const prefs = getTranslatePrefs();
  let presets = getPresets();
  let active = presets.list.find((p) => p.name === presets.active) || presets.list[0];

  const ov = document.createElement('div');
  ov.className = 'modal';
  ov.onclick = (e) => { if (e.target === ov) { settingsOpen = false; render(); } };
  const panel = document.createElement('div');
  panel.className = 'settings-panel';
  const head = document.createElement('div');
  head.className = 'settings-head';
  head.innerHTML = '<h2>번역 설정</h2>';
  head.appendChild(button('닫기', () => { settingsOpen = false; render(); }));
  panel.appendChild(head);
  const body = document.createElement('div');
  body.className = 'settings-body';

  const provider = selectEl(providerOptions(), cfg.provider);
  const model = inputEl(cfg.model || providerDef(cfg.provider).defModel || '');
  const apiKey = inputEl('', 'password');
  apiKey.placeholder = cfg.apiKey ? '저장됨 - 바꿀 때만 입력' : 'API 키 입력';
  const baseUrl = inputEl(cfg.baseUrl || '');
  baseUrl.placeholder = cfg.provider === 'custom' ? '예: https://server.example/v1' : '비워두면 기본값';
  const targetLang = inputEl(prefs.targetLang || '한국어');
  const sessionOnly = checkEl(!!cfg.sessionOnly);
  const translateNames = checkEl(prefs.translateNames !== false);
  const skipKorean = checkEl(prefs.skipKorean !== false);
  const combine = checkEl(getCombineOn());

  // 기본 = 키만 넣으면 되는 층. 파라미터·배치·프리셋은 "고급" 접기로(과부하 방지).
  body.append(
    fieldRow(field('제공자', provider), field('모델', model, '비워두면 제공자 기본 모델을 씁니다.')),
    fieldRow(field('API 키', apiKey, '키는 브라우저 localStorage 또는 sessionStorage에만 저장됩니다.'), field('서버 주소', baseUrl, 'custom/OpenAI 호환 서버에만 필요합니다.')),
    fieldRow(field('번역 언어', targetLang), field('세션 저장', labelWrap(sessionOnly, '탭을 닫으면 키 삭제'))),
    fieldRow(field('이름 번역', labelWrap(translateNames, '본문과 이름을 함께 번역')), field('한국어 스킵', labelWrap(skipKorean, '이미 한국어인 항목 건너뛰기'))),
  );

  const adv = document.createElement('details');
  adv.className = 'adv-fold';
  const advSum = document.createElement('summary');
  advSum.textContent = '고급 — 생성 파라미터 · 배치 · 프롬프트 프리셋';
  adv.appendChild(advSum);
  const advBody = document.createElement('div');
  advBody.className = 'settings-body adv-body';
  adv.appendChild(advBody);
  body.appendChild(adv);

  const paramGrid = document.createElement('div');
  paramGrid.className = 'field-row';
  const temperature = numberEl(cfg.params?.temperature ?? 0.3, '0', '2', '0.05');
  const topP = numberEl(cfg.params?.top_p ?? 1, '0', '1', '0.05');
  const maxTokens = numberEl(cfg.params?.max_tokens ?? 0, '0', '200000', '64');
  const topK = numberEl(cfg.params?.top_k ?? 0, '0', '500', '1');
  paramGrid.append(
    field('temperature', temperature),
    field('top_p', topP),
    field('max_tokens', maxTokens, '0이면 입력 길이에 따라 자동 산정합니다.'),
    field('top_k', topK, 'Anthropic에서 주로 사용합니다.'),
  );
  advBody.appendChild(paramGrid);

  const thinking = selectEl([['off', 'off'], ['low', 'low'], ['medium', 'medium'], ['high', 'high']], cfg.thinking || 'off');
  const batchChars = numberEl(prefs.batchChars || 3600, '800', '20000', '100');
  const batchCount = numberEl(prefs.batchCount || 16, '1', '80', '1');
  advBody.append(
    fieldRow(field('Gemini thinking', thinking), field('배치 글자 수', batchChars)),
    fieldRow(field('배치 개수', batchCount), field('결합 번역', labelWrap(combine, '여러 블록을 한 번에 번역'))),
  );

  const presetSelect = selectEl(presets.list.map((p) => [p.name, p.name]), presets.active);
  const prompt = document.createElement('textarea');
  prompt.value = active?.prompt || DEFAULT_LORE_PROMPT;
  prompt.className = 'tr-prompt';
  const maxResponse = numberEl(active?.maxResponse || 0, '0', '200000', '64');
  const presetBtns = document.createElement('div');
  presetBtns.className = 'reader-actions';
  presetBtns.append(
    button('새 프리셋', () => {
      writePreset();
      const name = window.prompt('새 프리셋 이름', '내 프리셋');
      if (!name || presets.list.some((p) => p.name === name)) return;
      presets.list.push({ name, prompt: prompt.value || DEFAULT_LORE_PROMPT });
      presets.active = name;
      savePresets(presets);
      settingsOpen = true;
      render();
    }),
    button('프리셋 삭제', () => {
      if (presets.list.length <= 1) return;
      presets.list = presets.list.filter((p) => p.name !== presetSelect.value);
      presets.active = presets.list[0].name;
      savePresets(presets);
      settingsOpen = true;
      render();
    }),
  );
  presetSelect.onchange = () => {
    writePreset();
    presets.active = presetSelect.value;
    savePresets(presets);
    settingsOpen = true;
    render();
  };
  advBody.append(field('프롬프트 프리셋', presetSelect), field('프롬프트', prompt, '키워드와 발동 조건은 번역하지 않는다는 지침을 유지하세요.'), field('maxResponse', maxResponse, '프리셋별 응답 예산입니다. 0이면 자동입니다.'), presetBtns);

  function writePreset() {
    const p = presets.list.find((x) => x.name === presetSelect.value) || presets.list[0];
    if (!p) return;
    p.prompt = prompt.value || DEFAULT_LORE_PROMPT;
    const mr = Number(maxResponse.value) || 0;
    if (mr > 0) p.maxResponse = mr;
    else delete p.maxResponse;
    presets.active = presetSelect.value;
  }
  const foot = document.createElement('div');
  foot.className = 'reader-actions';
  foot.append(
    button('저장', () => {
      writePreset();
      savePresets(presets);
      setWebConfig({
        provider: provider.value,
        model: model.value.trim(),
        apiKey: apiKey.value.trim(),
        baseUrl: baseUrl.value.trim(),
        thinking: thinking.value,
        sessionOnly: sessionOnly.checked,
        params: {
          temperature: Number(temperature.value),
          top_p: Number(topP.value),
          max_tokens: Number(maxTokens.value),
          top_k: Number(topK.value),
        },
      });
      setTranslatePrefs({
        targetLang: targetLang.value.trim() || '한국어',
        translateNames: translateNames.checked,
        skipKorean: skipKorean.checked,
        batchChars: Number(batchChars.value) || 3600,
        batchCount: Number(batchCount.value) || 16,
      });
      setCombineOn(combine.checked);
      settingsOpen = false;
      render();
      toast('저장했습니다');
    }, 'primary'),
    button('키 삭제', () => { clearWebConfig(); settingsOpen = false; render(); toast('키를 삭제했습니다'); }),
    button('번역 캐시 비우기', async () => { await clearTranslationCache(); translations = {}; render(); toast('캐시를 비웠습니다'); }),
  );
  body.appendChild(foot);
  panel.appendChild(body);
  ov.appendChild(panel);
  document.body.appendChild(ov);
}

function providerOptions() {
  const names: Record<string, string> = {
    gemini: 'Gemini (Google)',
    openai: 'OpenAI',
    anthropic: 'Anthropic (Claude)',
    'ollama-turbo': 'Ollama Turbo Cloud',
    custom: 'Custom OpenAI-compatible',
  };
  return Object.keys(PROVIDERS).filter((p) => PROVIDERS[p].web).map((p) => [p, names[p] || p]);
}
function button(text: string, onClick: any, cls = '') {
  const b = document.createElement('button');
  b.textContent = text;
  if (cls) b.className = cls;
  b.onclick = onClick;
  return b;
}
function span(cls: string, text: string) {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  return s;
}
function div(cls: string, text: string) {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = text;
  return d;
}
function stat(text: string) {
  return span('stat', text);
}
function inputEl(value = '', type = 'text') {
  const i = document.createElement('input');
  i.type = type;
  i.value = value;
  return i;
}
function numberEl(value: any, min: string, max: string, step: string) {
  const i = inputEl(String(value || 0), 'number');
  i.min = min;
  i.max = max;
  i.step = step;
  return i;
}
function selectEl(options: string[][], value: string) {
  const s = document.createElement('select');
  options.forEach(([v, t]) => s.appendChild(new Option(t, v)));
  s.value = value;
  return s;
}
function checkEl(checked: boolean) {
  const i = document.createElement('input');
  i.type = 'checkbox';
  i.checked = checked;
  return i;
}
function labelWrap(input: HTMLInputElement, text: string) {
  const l = document.createElement('label');
  l.className = 'toggle';
  l.append(input, document.createTextNode(text));
  return l;
}
function field(label: string, el: HTMLElement, hint = '') {
  const f = document.createElement('div');
  f.className = 'field';
  const l = document.createElement('label');
  l.textContent = label;
  f.append(l, el);
  if (hint) {
    const s = document.createElement('small');
    s.textContent = hint;
    f.appendChild(s);
  }
  return f;
}
function fieldRow(...fields: HTMLElement[]) {
  const r = document.createElement('div');
  r.className = 'field-row';
  fields.forEach((f) => r.appendChild(f));
  return r;
}

document.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.classList.add('dragging');
});
document.addEventListener('dragleave', (e) => {
  if (!(e as DragEvent).relatedTarget) document.body.classList.remove('dragging');
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  const fs = Array.from(((e as DragEvent).dataTransfer && (e as DragEvent).dataTransfer.files) || []);
  if (fs.length) addFiles(fs);
});

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

applyTheme();
render();
