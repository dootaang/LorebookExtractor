// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const { estimateEntryTokens, applyTokenBudget } = require('./tokens.js');

function textFromMessages(input, scanDepth) {
  if (Array.isArray(input)) {
    const recent = input.slice(-Math.max(1, Number(scanDepth || 10)));
    return recent.map((m) => typeof m === 'string' ? m : (m && (m.content || m.text || m.message)) || '').join('\n');
  }
  return String(input == null ? '' : input);
}

function wordBoundaryMatch(haystack, needle, caseSensitive) {
  const source = String(haystack || '');
  const key = String(needle || '');
  if (!key) return false;
  const flags = caseSensitive ? 'u' : 'iu';
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}($|[^\\p{L}\\p{N}_])`, flags).test(source);
  } catch (_) {
    const h = caseSensitive ? source : source.toLowerCase();
    const k = caseSensitive ? key : key.toLowerCase();
    return h.includes(k);
  }
}

function includesKey(haystack, key, opts) {
  if (!key) return false;
  const caseSensitive = !!opts.caseSensitive;
  if (opts.wholeWord) return wordBoundaryMatch(haystack, key, caseSensitive);
  const h = caseSensitive ? String(haystack || '') : String(haystack || '').toLowerCase();
  const k = caseSensitive ? String(key) : String(key).toLowerCase();
  return h.includes(k);
}

function regexMatches(haystack, key) {
  try {
    return { ok: true, matched: new RegExp(key, 'i').test(haystack) };
  } catch (e) {
    return { ok: false, matched: false, error: e.message || String(e) };
  }
}

function checkEntry(entry, searchText, opts) {
  if (!entry || entry.isFolder) return null;
  const tokens = estimateEntryTokens(entry);
  const base = { uid: entry.uid, entry, name: entry.name || (entry.keys && entry.keys[0]) || '', order: entry.order, tokens };
  if (entry.enabled === false) return { ...base, active: false, reason: 'disabled', detail: 'Entry is disabled.' };
  if (entry.constant) return { ...base, active: true, reason: 'constant', detail: 'Always active.' };

  const keys = Array.isArray(entry.keys) ? entry.keys.filter(Boolean) : [];
  if (!keys.length) return { ...base, active: false, reason: 'no_keys', detail: 'No activation keys.' };

  let primary = null;
  let regexError = null;
  for (const key of keys) {
    if (entry.useRegex) {
      const r = regexMatches(searchText, key);
      if (!r.ok) { regexError = r.error; continue; }
      if (r.matched) { primary = key; break; }
    } else if (includesKey(searchText, key, opts)) {
      primary = key;
      break;
    }
  }
  if (!primary && regexError) return { ...base, active: false, reason: 'invalid_regex', detail: regexError };
  if (!primary) return { ...base, active: false, reason: 'primary_missing', detail: 'No primary key matched.' };

  if (entry.useRegex) return { ...base, active: true, reason: 'regex', key: primary, detail: `Regex matched: ${primary}` };

  if (entry.selective) {
    const secondaries = Array.isArray(entry.secondaryKeys) ? entry.secondaryKeys.filter(Boolean) : [];
    if (!secondaries.length) return { ...base, active: false, reason: 'secondary_missing_config', key: primary, detail: 'Selective entry has no secondary keys.' };
    const secondary = secondaries.find((k) => includesKey(searchText, k, opts));
    if (!secondary) return { ...base, active: false, reason: 'secondary_missing', key: primary, detail: 'Primary key matched, but no secondary key matched.' };
    return { ...base, active: true, reason: 'primary_secondary', key: primary, secondaryKey: secondary, detail: `Matched: ${primary} + ${secondary}` };
  }

  return { ...base, active: true, reason: 'primary', key: primary, detail: `Matched: ${primary}` };
}

function simulateActivation(lore, input, opts = {}) {
  const entries = (lore && lore.entries) || [];
  const scanDepth = Number(opts.scanDepth || lore.scanDepth || 10);
  const searchText = textFromMessages(input, scanDepth);
  const checks = entries.map((e) => checkEntry(e, searchText, opts)).filter(Boolean);
  const active = checks.filter((r) => r.active).sort((a, b) => (a.order || 0) - (b.order || 0));
  const inactive = checks.filter((r) => !r.active);
  const budget = opts.tokenBudget != null ? opts.tokenBudget : lore.tokenBudget;
  const budgetResult = applyTokenBudget(active, budget);
  return {
    scanDepth,
    searchText,
    active,
    inactive,
    tokenBudget: Number(budget || 0),
    tokenTotal: active.reduce((n, r) => n + r.tokens, 0),
    budgetKept: budgetResult.kept,
    budgetDropped: budgetResult.dropped,
    budgetUsed: budgetResult.used,
  };
}

module.exports = { simulateActivation, checkEntry, includesKey, textFromMessages };
