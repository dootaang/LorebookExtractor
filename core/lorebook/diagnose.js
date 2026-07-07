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
      out.push(issue('warning', 'unknown_decorator', `Unknown decorator: ${name}`, entry, line));
      continue;
    }
    if (NUMERIC_DECORATORS.has(name)) {
      const value = parts[1];
      if (value == null || Number.isNaN(Number(value))) {
        out.push(issue('warning', 'decorator_number', `${name} needs a number`, entry, line));
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
    const name = e.name || (e.keys && e.keys[0]) || '(unnamed)';
    const keys = Array.isArray(e.keys) ? e.keys.filter(Boolean) : [];

    if (e.enabled === false) issues.push(issue('info', 'disabled', 'Disabled entry', e, name));
    if (!String(e.content || '').trim()) issues.push(issue('error', 'empty_content', 'Empty content', e, 'This entry will not add prompt text.'));
    if (e.enabled !== false && !e.constant && !keys.length) issues.push(issue('warning', 'no_keys', 'Conditional entry has no keys', e, 'It cannot activate unless edited.'));
    if (e.selective && (!Array.isArray(e.secondaryKeys) || !e.secondaryKeys.length)) issues.push(issue('warning', 'selective_without_secondary', 'Selective entry has no secondary keys', e, 'Primary key can match, but the second condition is missing.'));
    if (e.folder && !refs.has(String(e.folder))) issues.push(issue('warning', 'orphan_folder', 'Folder reference was not found', e, String(e.folder)));
    if (String(e.content || '').length > longLimit) issues.push(issue('info', 'long_entry', 'Long entry', e, `${String(e.content || '').length} chars, about ${estimateEntryTokens(e)} tokens.`));

    if (e.useRegex) {
      for (const key of keys) {
        try { new RegExp(key); }
        catch (err) { issues.push(issue('error', 'invalid_regex', 'Invalid regex key', e, `${key}: ${err.message || err}`)); }
      }
    }

    for (const key of keys) {
      const norm = String(key).trim().toLowerCase();
      if (!norm) continue;
      if (!keyMap.has(norm)) keyMap.set(norm, []);
      keyMap.get(norm).push(e);
      if (!e.useRegex && norm.length <= 1) issues.push(issue('warning', 'short_key', 'Very short key', e, key));
    }

    issues.push(...diagnoseDecorators(e));
  }

  for (const [key, owners] of keyMap.entries()) {
    if (owners.length > 1) {
      for (const e of owners) issues.push(issue('warning', 'duplicate_key', `Duplicate key: ${key}`, e, `${owners.length} entries share this key.`));
    }
  }

  const constantCount = real.filter((e) => e.enabled !== false && e.constant).length;
  if (real.length && constantCount >= Math.max(5, Math.ceil(real.length * 0.35))) {
    issues.push(issue('warning', 'many_constant', 'Many always-active entries', null, `${constantCount}/${real.length} entries are always active.`));
  }

  const tokenStats = estimateLorebookTokens(entries);
  const budget = Number(opts.tokenBudget != null ? opts.tokenBudget : lore && lore.tokenBudget);
  if (budget > 0 && tokenStats.constant > budget) {
    issues.push(issue('error', 'constant_over_budget', 'Always-active entries exceed token budget', null, `${tokenStats.constant}/${budget} estimated tokens.`));
  } else if (budget > 0 && tokenStats.total > budget) {
    issues.push(issue('info', 'total_over_budget', 'Full lorebook exceeds token budget', null, `${tokenStats.total}/${budget} estimated tokens.`));
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
