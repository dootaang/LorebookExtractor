# Lorebook Extractor Backlog

## 2026-07-08 저녁 (Claude) — 1차 완료: 내보내기 포맷 선택 + 미니 서재

### 완료(커밋 b549fb4 · 556d016, 상세 = HANDOFF_다음작업.md §9)
- 내보내기 포맷 선택: 모달에 `.charx/.png/.json` 변환(JPEG 폴리글랏→charx=zip 수술 무손실, 그 외 cardEncode 배선, PNG 베이스 없으면 toast). 테스트 47개.
- 미니 서재: `web/src/library.ts`(IDB lbx v1) — 파일 자동 보관(해시 dedup)·초안 IDB 승격+**번역 포함**·LS 마이그레이션·빈 화면 최근 파일(즉시 열기·용량·persist)·삭제 시 초안 동반. E2E 3종 통과.
- "활성화 키 번역 실패 70" 종결 — 원인은 엔드포인트 URL 오입력(사장님 확인), 파이프라인 정상.

### 2차 완료(사장님 승인, 커밋 b94e8c0 — 상세 = HANDOFF §10)
- 편집기 1군: 선택 모드+일괄 작업(활성/비활성·언제나 활성화·번역·키 추가·삭제) · 복제 · 배치 순서 ↑/↓ · 검색&치환(정규식+미리보기). 전부 오버레이. 목록 정렬·편집 반영 잠복 결함 수선. E2E 4종 통과.

### 3차 완료(사장님 승인, 커밋 bdab8ba — 상세 = HANDOFF §11)
- undo/redo(Ctrl+Z) · 로어북 설정 편집(검색 깊이/최대 토큰/재귀 — 내보내기 반영) · 데코레이터 빌더 · 빈 로어북 신규 작성 · 병합 · 드래그앤드롭 재배치(사장님 추가 요구). 테스트 48개 · E2E 6종 전부 통과.

### 중대 결함 수정(2026-07-08 밤) — charx 내장 module.risum 로어북 동기
- 증상: 활성화 키 번역 추가 후 charx 내보내기 → 리스AI에서 키가 안 보임.
- 원인: 리스AI는 charx에 module.risum이 있으면 그 lorebook을 card.json보다 **우선**(overrideLorebook, 소스 확인). 우리는 card.json만 수술 → 모듈 내장 카드에선 모든 수정이 리스에서 무효.
- 수정: 모든 charx 계열 내보내기에서 모듈 lorebook도 동기 수술(applyLorebookToModuleJson + repackCharx moduleJsonStr + encodeCharx extraFiles). 리스 전용 필드·스크립트·에셋 무손실 테스트 고정. 테스트 50개 · E2E 7종.
- ※같은 원리 후속 후보: 뷰어 읽기 소스도 모듈 우선으로 정합(현재는 두 소스가 리스 수출본에서 항상 동일해 표시 문제 없음) · 진단에 "카드/모듈 로어북 불일치" 경고.

### ★다음 후보(승인 필요)
- 번역 실키 스모크(Gemini/OpenAI/Anthropic CORS) — 사장님 키 필요, 미실시.
- README 스크린샷 · Playwright 시각 체크 · 편집기 3군(있다면 사장님 피드백 기반).

## 2026-07-08 세션 총정리 (Claude) — 다음 작업은 ★HANDOFF_다음작업.md가 권위

### 완료(전부 커밋·배포됨, 라이브 = lorebookextractor.web.app)
- 디자인 1~3차(마크다운 렌더·색인 카드·서표 리본 / 로고·샘플 체험·진단 한국어화 / 설정 2층화·모바일 전환).
- 차별화: 활성화 키 번역 추가(원본 키 보존+추가만) · 용어집(로마자 유사도 게이트 짝짓기+LLM 채움) · 하단바 실종 버그(#app height).
- 용어=리스AI 공식(활성화 키·두번째 키·언제나 활성화·멀티플 키·배치 순서).
- 라이트 편집(오버레이+소프트 삭제+새 엔트리) + localStorage 초안 자동보존(파일 sha256).
- 원본 형식 내보내기 = 수술 재포장(charx/png/jpeg폴리글랏/json/risum[RPack 역표]) — repack.js+applyCard.js, 실파일 왕복 테스트 5종.
- UI 개편: 전체 스코프 탭=요약줄 우측·분석 뷰 전폭·내보내기=상단바 primary→모달(히어로) · 편집 워크시트(전폭·전고) · 팔레트 B(잉크 블루=상호작용/그린=언제나 활성화 시맨틱).
- 테스트 43개(`npm test`) · E2E 패턴=스크래치패드 e2e-lbx*.js(전부 통과).

### ★다음 작업(사장님 피드백 4건 → 설계 완료, 착수 대기)
1. 내보내기 포맷 선택(charx/png/json — JPEG 폴리글랏→charx는 수술로 공짜) — 지시서 §4.
2. 미니 서재(IndexedDB에 파일+번역 포함 작업상태 영속, 최근 파일 즉시 열기, persist) — 지시서 §5.
   ※용량 연구 결론: IDB=Chrome 디스크 60%/오리진 → 봇카드 수백 장 여유. Firebase는 애초에 안 씀(정적 호스팅만).
3. 편집기 1군(선택 모드+일괄 작업·복제·순서 이동·검색&치환) — 지시서 §6, 1차 끝나고 별도 확인.
- 미결: 활성화 키 번역 "실패 70" 원인 = 사장님 재실행 메시지 대기(실패 사유 노출 이미 구현).


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
