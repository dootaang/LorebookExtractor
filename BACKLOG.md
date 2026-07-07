# Lorebook Extractor Backlog

## Codex session handoff - 2026-07-08

### What changed

- Added support for RisuAI standalone lorebook export JSON such as `샘플/lorebook_export.json`.
  - `core/card/json.js` now falls back to whole-file JSON parsing when no `chara_card` marker exists.
  - It accepts `{ type: "risu", data: [...] }` and raw lorebook arrays as `spec: "risu-lorebook-export"`.
  - `core/lorebook/normalize.js` now normalizes those files as `kind: "risu-export"`.
- Added lorebook analysis core modules.
  - `core/lorebook/tokens.js`: rough token estimation and token-budget application.
  - `core/lorebook/activate.js`: activation simulator for pasted recent chat/test text.
  - `core/lorebook/diagnose.js`: health audit for empty content, missing keys, invalid regex, duplicate keys, orphan folders, unknown/bad decorators, long entries, many always-active entries, and token budget pressure.
- Added tests.
  - `core/lorebook/normalize.test.js` includes a real-file regression for `lorebook_export.json`.
  - `core/lorebook/analysis.test.js` covers token estimation, budget ordering, activation reasons, misses, invalid regex, and diagnosis codes.
  - `package.json` now runs both test files via `npm test`.
- Added reader-side product differentiation UI.
  - `web/src/main.ts` imports the new analysis modules.
  - The right reader panel now has tabs: `읽기`, `진단`, `활성화 테스트`, `내보내기`.
  - `진단` shows issue counts and clickable issue rows that jump back to the entry.
  - `활성화 테스트` accepts pasted text and shows active/inactive entries, activation reason, estimated tokens, and token-budget drop warnings.
  - `내보내기` groups Markdown, CCv3 JSON, normalized JSON, and copy actions into a clearer panel.
  - `web/style.css` has scoped styles for tabs, diagnosis rows, activation rows, export cards, and analysis summaries.

### Verification

- `npm test` passes.
- `npm run web:build` passes.
- Local server on `http://127.0.0.1:8134/` returned HTTP 200 during handoff.
- Direct sample check before the UI work confirmed:
  - file: `C:\LorebookExtractor\샘플\lorebook_export.json`
  - spec: `risu-lorebook-export`
  - kind: `risu-export`
  - entries: `13`
  - first entry: `RP 가이드라인 및 장르`

### Context from research

- RISUMARI is a full Electron editor/workbench, not just a viewer.
- RISUMARI already has lorebook editing, folder canonicalization, CCv3/Risu conversion, multi-select, clone/delete, drag ordering, search/filter, lore settings, and a basic activation preview.
- Recommended positioning for this app remains: lightweight web-only lorebook reader, translator, health auditor, activation debugger, and export helper.
- Do not compete by becoming a full bot-card editor unless the product direction changes.

### Next suggested Claude work

- Visual/design pass on the newly added tabs. The current markup is intentionally functional and scoped, not final-polished.
- Add export option dialog:
  - original names vs translated names
  - original content vs translated content
  - CCv3 vs Risu export JSON profile
- Improve activation simulator fidelity:
  - support recursive scanning
  - support full-word matching from lore settings
  - support more CCv3/Risu decorator semantics such as `@@activate_only_after`, `@@activate_only_every`, `@@probability`, `@@additional_keys`, `@@exclude_keys`
- Add translation QA panel:
  - side-by-side original/translated view
  - glossary
  - preservation checks for keywords, decorators, `{{char}}`, `{{user}}`, CBS, and regex keys
- Add Playwright checks for desktop/mobile after the visual pass.

## Design handoff

- The current UI is intentionally structured rather than final-polished. Claude can later rework the visual language without touching parser, export, or translation core code.
- Keep the main section names stable where possible: `topbar`, `empty`, `summary`, `workspace`, `entry-list`, `reader`, `bottom-actions`, `settings-panel`.
- Theme tokens live in `web/style.css` under `:root` and `:root[data-theme="dark"]`. A redesign should start there.
- Desired family feel: close to `C:\assetextractor2`, but lorebook-specific. Cream base is retained for now; book/marker/reading motifs can replace the temporary icon later.

## Product backlog

- Visual pass: spacing, typography, icon set, empty state illustration, mobile details.
- Add better folder tree handling for deeply nested Risu module folders if real samples require it.
- Add per-entry translation retry and cancel controls.
- Add export option dialog: original names vs translated names, original content vs translated content.
- Add import/export of translation cache as JSON.
- Add Playwright visual checks for desktop/mobile layouts.
- Add official README screenshots after design is finalized.

## Translation handoff

- LogPapa-style translation is now split into `web/src/webLlm.ts` and `web/src/loreTranslate.ts`.
- Implemented: web BYO-key adapter, session-only key storage, provider params, prompt presets, combine translation toggle, content-hash translation cache with IndexedDB LRU, body+name translation, decorator preservation, keyword preservation.
- Not implemented by design: desktop-only Vertex/Copilot providers. This app is web-only.
- Remaining QA: run real API smoke tests for Gemini/Anthropic/OpenAI and verify CORS behavior by provider.
