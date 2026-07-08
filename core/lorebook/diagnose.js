// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const { splitDecorators } = require('./normalize.js');
const { estimateLorebookTokens, estimateEntryTokens } = require('./tokens.js');

const KNOWN_DECORATORS = new Set([
  '@@depth',
  '@@reverse_depth',
  '@@activate_only_after',
  '@@activate_only_every',
  '@@role',
  '@@scan_depth',
  '@@is_greeting',
  '@@position',
  '@@ignore_on_max_context',
  '@@additional_keys',
  '@@exclude_keys',
  '@@probability',
  '@@activate',
  '@@dont_activate',
  '@@end',
]);

const NUMERIC_DECORATORS = new Set([
  '@@depth',
  '@@reverse_depth',
  '@@activate_only_after',
  '@@activate_only_every',
  '@@scan_depth',
  '@@is_greeting',
  '@@probability',
]);

function issue(severity, code, title, entry, detail) {
  return {
    severity,
    code,
    title,
    detail: detail || '',
    uid: entry && entry.uid,
    entryName: entry && (entry.name || (entry.keys && entry.keys[0]) || ''),
  };
}

function folderRefs(entries) {
  const folders = (entries || []).filter((e) => e && e.isFolder);
  const refs = new Set();
  for (const f of folders) {
    if (f.folder) refs.add(String(f.folder));
    if (f.name) refs.add(String(f.name));
    if (f.raw) {
      if (f.raw.id != null) refs.add(String(f.raw.id));
      if (f.raw.key != null) refs.add(String(f.raw.key));
      if (f.raw.comment != null) refs.add(String(f.raw.comment));
    }
  }
  return refs;
}

function diagnoseDecorators(entry) {
  const out = [];
  const split = splitDecorators(entry.content || '');
  for (const line of split.decorators) {
    const parts = line.trim().split(/\s+/);
    const name = parts[0];
    if (!KNOWN_DECORATORS.has(name)) {
      out.push(issue('warning', 'unknown_decorator', `모르는 데코레이터: ${name}`, entry, line));
      continue;
    }
    if (NUMERIC_DECORATORS.has(name)) {
      const value = parts[1];
      if (value == null || Number.isNaN(Number(value))) {
        out.push(issue('warning', 'decorator_number', `${name}에 숫자가 필요함`, entry, line));
      }
    }
  }
  return out;
}

function diagnoseLorebook(lore, opts = {}) {
  const entries = (lore && lore.entries) || [];
  const real = entries.filter((e) => e && !e.isFolder);
  const issues = [];
  const refs = folderRefs(entries);
  const keyMap = new Map();
  const longLimit = Number(opts.longEntryChars || 4000);

  for (const e of real) {
    const name = e.name || (e.keys && e.keys[0]) || '(이름 없음)';
    const keys = Array.isArray(e.keys) ? e.keys.filter(Boolean) : [];

    if (e.enabled === false) issues.push(issue('info', 'disabled', '비활성 엔트리', e, name));
    if (!String(e.content || '').trim()) issues.push(issue('error', 'empty_content', '본문이 비어 있음', e, '프롬프트에 아무것도 더하지 않는 엔트리예요.'));
    if (e.enabled !== false && !e.constant && !keys.length) issues.push(issue('warning', 'no_keys', '조건부인데 활성화 키가 없음', e, '수정하지 않으면 발동할 수 없어요.'));
    if (e.selective && (!Array.isArray(e.secondaryKeys) || !e.secondaryKeys.length)) issues.push(issue('warning', 'selective_without_secondary', '멀티플 키인데 두번째 키가 없음', e, '활성화 키가 맞아도 두번째 키 조건이 비어 있어요.'));
    if (e.folder && !refs.has(String(e.folder))) issues.push(issue('warning', 'orphan_folder', '폴더 참조를 찾지 못함', e, String(e.folder)));
    if (String(e.content || '').length > longLimit) issues.push(issue('info', 'long_entry', '긴 엔트리', e, `${String(e.content || '').length}자 · 약 ${estimateEntryTokens(e)} 토큰.`));

    if (e.useRegex) {
      for (const key of keys) {
        try { new RegExp(key); }
        catch (err) { issues.push(issue('error', 'invalid_regex', '잘못된 정규식 키워드', e, `${key}: ${err.message || err}`)); }
      }
    }

    for (const key of keys) {
      const norm = String(key).trim().toLowerCase();
      if (!norm) continue;
      if (!keyMap.has(norm)) keyMap.set(norm, []);
      keyMap.get(norm).push(e);
      if (!e.useRegex && norm.length <= 1) issues.push(issue('warning', 'short_key', '너무 짧은 키워드', e, key));
    }

    issues.push(...diagnoseDecorators(e));
  }

  for (const [key, owners] of keyMap.entries()) {
    if (owners.length > 1) {
      for (const e of owners) issues.push(issue('warning', 'duplicate_key', `중복 키워드: ${key}`, e, `${owners.length}개 엔트리가 같은 키워드를 써요.`));
    }
  }

  const constantCount = real.filter((e) => e.enabled !== false && e.constant).length;
  if (real.length && constantCount >= Math.max(5, Math.ceil(real.length * 0.35))) {
    issues.push(issue('warning', 'many_constant', '언제나 활성화 엔트리가 많음', null, `${real.length}개 중 ${constantCount}개가 항상 포함돼요.`));
  }

  const tokenStats = estimateLorebookTokens(entries);
  const budget = Number(opts.tokenBudget != null ? opts.tokenBudget : lore && lore.tokenBudget);
  if (budget > 0 && tokenStats.constant > budget) {
    issues.push(issue('error', 'constant_over_budget', '언제나 활성화만으로 로어북 최대 토큰 초과', null, `추정 ${tokenStats.constant} / 예산 ${budget} 토큰.`));
  } else if (budget > 0 && tokenStats.total > budget) {
    issues.push(issue('info', 'total_over_budget', '로어북 전체가 로어북 최대 토큰 초과', null, `추정 ${tokenStats.total} / 예산 ${budget} 토큰.`));
  }

  const rank = { error: 0, warning: 1, info: 2 };
  issues.sort((a, b) => (rank[a.severity] - rank[b.severity]) || String(a.entryName || '').localeCompare(String(b.entryName || '')));
  return {
    issues,
    counts: {
      error: issues.filter((i) => i.severity === 'error').length,
      warning: issues.filter((i) => i.severity === 'warning').length,
      info: issues.filter((i) => i.severity === 'info').length,
    },
    tokenStats,
  };
}

module.exports = { diagnoseLorebook, diagnoseDecorators, KNOWN_DECORATORS };
