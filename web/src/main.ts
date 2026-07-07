// SPDX-License-Identifier: GPL-3.0-or-later
// @ts-nocheck
import { parseCard } from '../../core/card/parseCard.js';
import { extractLorebook, splitDecorators, groupByFolder, loreStats, buildCharacterBook, buildMarkdown } from '../../core/lorebook/normalize.js';
import { diagnoseLorebook } from '../../core/lorebook/diagnose.js';
import { simulateActivation } from '../../core/lorebook/activate.js';
import { estimateLorebookTokens, estimateEntryTokens } from '../../core/lorebook/tokens.js';
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
type ReaderTab = 'read' | 'diagnose' | 'activate' | 'export';

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
    for (const i of diagnoseLorebook(lore, { tokenBudget: lore.tokenBudget }).issues) {
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
function realEntries() {
  return lore ? lore.entries.filter((e: any) => !e.isFolder) : [];
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
    lore = extractLorebook(parsed.card || parsed);
    if (!lore || !Array.isArray(lore.entries) || !lore.entries.some((e: any) => !e.isFolder)) {
      parseError = '이 파일에서 로어북을 찾지 못했습니다.';
    } else {
      selectedUid = realEntries()[0]?.uid || '';
      statusText = `${chip.name}에서 로어북을 읽었습니다.`;
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
  const st = loreStats(lore.entries);
  const tk = estimateLorebookTokens(lore.entries);
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
    statPair(String(st.constant), '상시활성'),
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
  [['all', '전체'], ['constant', '상시활성'], ['conditional', '조건부'], ['disabled', '비활성']].forEach(([v, t]) => filterSel.appendChild(new Option(t, v)));
  filterSel.value = filter;
  filterSel.onchange = () => { filter = filterSel.value as FilterMode; renderBody(); };
  const sortSel = document.createElement('select');
  [['order', '원래 순서'], ['name', '이름순'], ['length', '본문 긴순']].forEach(([v, t]) => sortSel.appendChild(new Option(t, v)));
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
  panel.appendChild(scroll);
  return panel;
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
  if (translations[e.uid]) { const t = span('tr-dot', ''); t.title = '번역됨'; meta.appendChild(t); }
  meta.appendChild(span('entry-tok', tinyTok(estimateEntryTokens(e))));
  row.appendChild(meta);
  const chipsRow = document.createElement('span');
  chipsRow.className = 'entry-keys';
  if (e.keys.length) {
    e.keys.slice(0, 3).forEach((k: string) => chipsRow.appendChild(span('keychip mini', k)));
    if (e.keys.length > 3) chipsRow.appendChild(span('keychip mini more', '+' + (e.keys.length - 3)));
  } else {
    chipsRow.appendChild(span('entry-nokey', e.constant ? '항상 발동' : '키워드 없음'));
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
  if (readerTab === 'export') {
    panel.appendChild(buildExportView());
    return panel;
  }
  const e = selectedEntry();
  if (!e) {
    panel.appendChild(div('empty-reader', '엔트리를 선택하세요.'));
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
  if (e.constant) badges.appendChild(span('badge constant', '상시활성'));
  if (!e.enabled) badges.appendChild(span('badge disabled', '비활성'));
  if (e.useRegex) badges.appendChild(span('badge regex', '정규식'));
  title.appendChild(badges);
  head.appendChild(title);
  // 표제어 줄: 발동 키워드(원문 고정) + 2차 키 + 데코레이터 — 각각 라벨로 구분.
  const keyline = document.createElement('div');
  keyline.className = 'chipline';
  if (e.keys.length) {
    keyline.appendChild(span('chip-label', '발동 키워드'));
    e.keys.forEach((k: string) => keyline.appendChild(span('keychip', k)));
  }
  if (e.secondaryKeys.length) {
    keyline.appendChild(span('chip-label', '+ 2차 조건'));
    e.secondaryKeys.forEach((k: string) => keyline.appendChild(span('keychip second', k)));
  }
  if (!e.keys.length && !e.secondaryKeys.length) keyline.appendChild(span('chip-label', e.constant ? '키워드 없이 항상 포함되는 설정' : '발동 키워드 없음'));
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

function buildReaderTabs() {
  const tabs = document.createElement('div');
  tabs.className = 'reader-tabs';
  const back = button('← 목록', () => { mobilePane = 'list'; renderBody(); }, 'ghost');
  back.className = 'mob-back';   // 좁은 화면에서만 보임(CSS)
  tabs.appendChild(back);
  const items: [ReaderTab, string][] = [['read', '읽기'], ['diagnose', '진단'], ['activate', '활성화 테스트'], ['export', '내보내기']];
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
  const report = diagnoseLorebook(lore, { tokenBudget: lore.tokenBudget });
  const body = document.createElement('div');
  body.className = 'reader-tab-body analysis-body';
  const summary = document.createElement('div');
  summary.className = 'analysis-summary';
  summary.append(
    stat(`오류 ${report.counts.error}`),
    stat(`주의 ${report.counts.warning}`),
    stat(`참고 ${report.counts.info}`),
    stat(`전체 ${fmtChars(report.tokenStats.total)}토큰`),
    stat(`상시 ${fmtChars(report.tokenStats.constant)}토큰`),
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
  if (result.budgetDropped.length) body.appendChild(div('budget-warning', `토큰 예산 때문에 ${result.budgetDropped.length}개 엔트리가 밀릴 수 있습니다.`));
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
    constant: '상시활성',
    primary: `키워드: ${r.key}`,
    primary_secondary: `키+2차키: ${r.key} + ${r.secondaryKey}`,
    regex: `정규식: ${r.key}`,
    disabled: '비활성',
    no_keys: '키워드 없음',
    primary_missing: '1차 키 불일치',
    secondary_missing: '2차 키 불일치',
    secondary_missing_config: '2차 키 설정 없음',
    invalid_regex: '정규식 오류',
  };
  return map[r.reason] || r.detail || r.reason || '';
}

function buildExportView() {
  const body = document.createElement('div');
  body.className = 'reader-tab-body analysis-body';
  const note = document.createElement('p');
  note.className = 'panel-note';
  note.textContent = '원본은 수정하지 않고 현재 보기 상태를 다운로드합니다. 키워드는 번역하지 않고 원문을 유지합니다.';
  body.appendChild(note);
  const grid = document.createElement('div');
  grid.className = 'export-grid';
  grid.append(
    exportCard('Markdown', '읽기와 공유에 좋은 문서 형식입니다.', () => exportMarkdown()),
    exportCard('CCv3 JSON', '표준 character_book 형식으로 다시 넣기 좋습니다.', () => exportCharacterBook()),
    exportCard('정규화 JSON', '분석/백업용 통합 스키마입니다.', () => exportNormalized()),
    exportCard('전체 복사', '현재 원문/번역 보기 상태의 Markdown을 클립보드에 복사합니다.', () => copyText(buildMarkdown(lore, showTranslated ? translations : null, 'tr'))),
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
    button('전체 복사', () => copyText(buildMarkdown(lore, showTranslated ? translations : null, 'tr'))),
    button('Markdown 저장', () => exportMarkdown()),
    button('CCv3 JSON 저장', () => exportCharacterBook()),
    button('정규화 JSON 저장', () => exportNormalized()),
  );
  bar.appendChild(span('status', translating ? '번역 중...' : statusText));
  return bar;
}

function entryMarkdown(e: any) {
  const tr = showTranslated ? translations : null;
  const v = tr && tr[e.uid] ? tr[e.uid] : {};
  const name = v.name || e.name || e.keys[0] || '(이름 없음)';
  const content = v.content || e.content || '';
  const lines = [`### ${name}`];
  if (e.keys.length) lines.push(`- 키워드: ${e.keys.join(', ')}`);
  if (e.secondaryKeys.length) lines.push(`- 2차 키워드: ${e.secondaryKeys.join(', ')}`);
  lines.push('', content);
  return lines.join('\n');
}
function exportBaseName() {
  const chip = chips.find((c) => c.id === currentId);
  return safeName(lore?.bookName || parsed?.name || chip?.name || 'lorebook');
}
function exportMarkdown() {
  downloadText(buildMarkdown(lore, showTranslated ? translations : null, 'tr'), exportBaseName() + '.md');
}
function exportCharacterBook() {
  const data = buildCharacterBook(lore, showTranslated ? translations : null, 'tr');
  downloadText(JSON.stringify(data, null, 2), exportBaseName() + '.character_book.json', 'application/json;charset=utf-8');
}
function exportNormalized() {
  const data = {
    source: chips.find((c) => c.id === currentId)?.name || '',
    kind: lore.kind,
    bookName: lore.bookName,
    entries: lore.entries.map((e: any) => ({
      ...e,
      displayName: displayName(e),
      displayContent: displayContent(e),
      raw: undefined,
    })),
  };
  downloadText(JSON.stringify(data, null, 2), exportBaseName() + '.normalized.json', 'application/json;charset=utf-8');
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
      ? `일부 실패: ${res.failed.length}개 · 성공/캐시 ${res.translated}개`
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
