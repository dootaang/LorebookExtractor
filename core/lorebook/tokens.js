// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

function estimateTokens(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return 0;
  const cjk = (s.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) || []).length;
  const asciiWords = (s.replace(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g, ' ').match(/[A-Za-z0-9_]+(?:[-'][A-Za-z0-9_]+)*/g) || []).length;
  const symbols = Math.max(0, s.length - cjk - asciiWords * 5);
  return Math.max(1, Math.ceil(cjk * 0.7 + asciiWords * 1.25 + symbols / 4));
}

function estimateEntryTokens(entry) {
  if (!entry || entry.isFolder) return 0;
  return estimateTokens(entry.content);
}

function estimateLorebookTokens(entries) {
  const real = (entries || []).filter((e) => e && !e.isFolder);
  const rows = real.map((e) => ({ uid: e.uid, name: e.name || (e.keys && e.keys[0]) || '', tokens: estimateEntryTokens(e), constant: !!e.constant, enabled: e.enabled !== false }));
  return {
    total: rows.reduce((n, r) => n + r.tokens, 0),
    constant: rows.filter((r) => r.constant && r.enabled).reduce((n, r) => n + r.tokens, 0),
    disabled: rows.filter((r) => !r.enabled).reduce((n, r) => n + r.tokens, 0),
    rows,
  };
}

function applyTokenBudget(active, budget) {
  const limit = Number(budget || 0);
  const sorted = (active || []).slice().sort((a, b) => {
    const ao = a.order == null ? 0 : a.order;
    const bo = b.order == null ? 0 : b.order;
    return ao - bo;
  });
  if (!limit || limit <= 0) {
    return { budget: 0, used: sorted.reduce((n, r) => n + (r.tokens || 0), 0), kept: sorted, dropped: [] };
  }
  const kept = [];
  const dropped = [];
  let used = 0;
  for (const item of sorted) {
    const t = item.tokens || 0;
    if (used + t <= limit) {
      kept.push(item);
      used += t;
    } else {
      dropped.push(item);
    }
  }
  return { budget: limit, used, kept, dropped };
}

module.exports = { estimateTokens, estimateEntryTokens, estimateLorebookTokens, applyTokenBudget };
