# 작업 지시서 — 로어북 추출기 다음 작업 (1차: 내보내기 포맷 선택 + 미니 서재)

> 자기완결 문서. 이 폴더(`C:\LorebookExtractor`)에서 다른 세션/AI가 이 문서만 읽고 처음부터 끝까지 작업 가능하게 쓴다.
> 작성 2026-07-08. 사장님 승인 상태: **1차 범위 설계 승인 대기 중이던 것을 "지시서로 준비"로 전환** — 착수 전 사장님에게 "1차 시작합니다" 한 줄 보고 후 진행 권장.

## 0. 이 앱이 뭔가 (30초 브리핑)

봇카드·모듈(.charx/.png/.jpeg/.json/.risum)을 드롭하면 로어북을 **읽고(마크다운 조판) → 진단하고 → 번역하고(BYO-key) → 편집하고 → 원본 형식 그대로 내보내는** 웹 단독 도구. 라이브 = https://lorebookextractor.web.app (main 푸시 → CI 자동 배포). 파일은 기기 밖으로 안 나감(로그인·서버·Firebase DB 없음 — **정적 호스팅만**).

## 1. 현재 아키텍처 지도

| 경로 | 역할 | 비고 |
|---|---|---|
| `core/card/` | 전 포맷 파서(LogPapa vendored) + `repack.js`(수술 재포장) + `cardEncode.js`(charx↔png↔json 변환기, **아직 미배선**) | parseCard/charx/png/json/risum은 **수정 금지**(검증 vendored). repack·cardEncode는 우리 것 |
| `core/lorebook/` | normalize(통일 스키마)·diagnose·activate·tokens·glossary·mdlite(안전 마크다운)·applyCard(로어북→카드 JSON) | 전부 순수·node 테스트 |
| `core/translate/` | providers·maskMarkup·translateLog (LogPapa vendored) | **수정 금지** |
| `web/src/main.ts` | 앱 전체(단일 화면) | 상태 변수는 파일 상단에 몰려 있음 |
| `web/src/loreTranslate.ts` | 번역 오케스트레이션(캐시 IDB·프리셋·combine) | opts.targetLang/skipKorean 오버라이드 지원 |
| `web/src/webLlm.ts` | 브라우저 LLM 어댑터(키=localStorage `lb-translate-config-web`) | |
| `샘플/` | lorebook_export.json(13엔트리) · New_TSF.charx(**실제론 JPEG 폴리글랏**, 91엔트리·70키) | 테스트 픽스처(커밋됨) |

핵심 상태(main.ts 상단): `lore`(정규화 로어북) · `translations`(uid→번역) · `keyAdds`(uid→추가 활성화 키) · `edits/removedUids/addedEntries`(편집 오버레이) · `draftKey`(파일 sha256 → localStorage 초안). **effLore() = 편집 병합본** — 표시·분석·내보내기 전부 이걸 쓴다.

## 2. 불변 원칙 (하드 룰 — 위반 금지)

1. **원본 보존**: 편집·번역·키 추가는 전부 오버레이. 원본 필드를 덮어쓰는 코드 금지.
2. **활성화 키(keys) 번역·변형 금지** — 발동 스위치. 번역 키는 "추가"만(mergedKeys).
3. 파일 바이트·로어북 내용을 외부 전송 금지(번역 API 호출만 예외). API키는 local/sessionStorage만.
4. CSP `style-src 'self'` 유지 — innerHTML에 style 속성 금지(JS `.style.prop`은 OK). eval 금지.
5. 새 npm 의존성 금지(fflate·esbuild로 충분). 새 파일 SPDX GPL 헤더.
6. **용어 = 리스AI 공식**: 활성화 키·두번째 키·언제나 활성화·멀티플 키·배치 순서·로어북 최대 토큰.
7. **색 체계**: 잉크 블루(--accent #35569b)=상호작용 전용 / 그린(--ok)=「언제나 활성화」시맨틱 전용 / 호박=주의 / 빨강=오류·삭제. 이 역할 분리를 깨지 말 것.
8. 문구는 짧고 건조하게. 장황한 설명 금지(사장님 지시).

## 3. 검증 방법 (완료 조건의 공통 분모)

- `npm test` — 현재 43개 전부 통과 유지(실파일 회귀는 `C:\pro 1.2\캐릭터파일` 있을 때만 실행됨).
- `npm run web:build` 성공.
- **헤드리스 E2E**: `C:\pro 1.2`의 electron 재사용 — `cd "C:\pro 1.2" && npx electron <스크립트>`. 패턴은 스크래치패드 `e2e-lbx7.js`(app:// 프로토콜로 web/ 서빙 → 샘플 드롭 → DOM 계측 → 콘솔 에러 0 판정). 다운로드 검증은 `session.on('will-download')`.
- 캡처 육안: 같은 패턴으로 `capturePage()` → PNG를 직접 읽어 확인(cap-lbx*.js 패턴).
- 커밋 = 한국어, 무엇/왜. main 푸시 = CI가 테스트+빌드+배포(secret 등록 완료, 배포 실패 시 롤백 불필요 — 다음 푸시가 덮음).

## 4. ★1차 작업 A — 내보내기 포맷 선택

**배경**: New_TSF처럼 이름은 .charx인데 실제는 JPEG 폴리글랏인 카드가 있음 → 수술 재포장이 원본 매직대로 jpeg를 내놓아 사장님이 charx를 못 얻었음. 선택권 필요.

**스펙**:
1. 내보내기 모달(`openExportModal`)의 히어로("원본 형식으로 저장") 아래에 형식 줄 추가: `다른 형식으로: [charx] [png] [json]` 버튼 3개.
2. 경로 분기(신규 `exportAs(format)`):
   - 원본이 **JPEG 폴리글랏이고 charx 선택** → 수술: `zipStartInBytes`(repack.js에 이미 있음)로 zip 부분만 잘라 `repackCharx`로 로어북 반영 후 저장. 에셋 디코드 불필요(빠름).
   - 그 외 형식 변환 → `cardEncode.js`의 `encodeCharx/encodePng/encodeJson` 사용. 입력 = parseCard **비-lazy** 재파싱(에셋 필요: `parseCard(bytes, name)` lazy 없이) 후 `applyLorebookToCard`로 로어북 반영한 card를 parsed에 심어 전달. `getBytes(asset)` 구현은 `core/card/cardAssets.js`의 디코더 참고(에셋추출기2 `C:\assetextractor2\web\src\main.ts`의 변환 버튼 구현이 정확한 선례 — 그대로 이식 가능).
   - png 선택인데 베이스 이미지 없음(`pickPngBase` null) → toast '이 카드엔 PNG로 쓸 이미지가 없어요'.
   - .risum(모듈)/risu-export는 형식 변환 비대상 → 버튼 숨김(원본 그대로만).
3. 대형 카드 대비: 변환 중 `statusText` 진행 표시, try/catch로 toast.
4. **완료 조건**: New_TSF(JPEG 폴리글랏)에서 charx 선택 → 내려받은 파일이 PK 매직 + parseCard 재파싱 시 로어북 수정 반영 + 에셋 수 동일(node 테스트로 고정: `repack.test.js`에 케이스 추가). png/json 변환도 각 1케이스. E2E에서 다운로드 파일명 `<base>_수정.charx` 확인.

## 5. ★1차 작업 B — 미니 서재 (파일·작업상태 영속)

**배경**: 지금은 파일을 다시 드롭해야 하고, 번역 상태는 초안에 미포함. 사장님 요구 = "이전 작업이 안 꺼놓으면 여전히 있는" 경험. **Firebase 아님 — 전부 IndexedDB**(Chrome 디스크 60%까지 = 봇카드 수백 장 여유. localStorage 5MB와 격이 다름).

**스펙**:
1. **IDB 스키마**(신규 `web/src/library.ts` 모듈 권장): DB `lbx` v1 — store `files`(keyPath: hash){hash, name, size, bytes(Blob), openedAt} · store `drafts`(keyPath: hash){hash, edits, removedUids, addedEntries, keyAdds, **translations**, t}.
2. 드롭/열기 시 **자동 보관**(해시 dedup — 같은 파일 재드롭이면 openedAt만 갱신). 설정 토글 없이 v1은 항상 저장(사장님 추천 수용 — 단 착수 보고 때 재확인).
3. 초안을 localStorage → IDB drafts로 승격 + **translations 포함**(이게 핵심 추가). 기존 localStorage 초안(`lb-draft-*`)은 1회 마이그레이션(읽어서 IDB로, 성공 시 삭제).
4. 빈 화면 "최근 파일" 목록(에셋추출기2 `web/src/main.ts`의 recent UI 패턴 참고): 이름·크기·마지막 열람·[열기=바이트 즉시 로드]·[삭제]. 목록 위에 `storage.estimate()` 용량 게이지 + `navigator.storage.persist()` 1회 요청(콘솔 로그로 결과 기록).
5. 파일 삭제 시 drafts도 함께 삭제. "초안 버리기"는 drafts만.
6. **완료 조건**: E2E — 드롭→편집+번역상태 주입→**새로고침(재드롭 없이)** 최근 목록에서 클릭→편집·번역 상태 복원 확인 / 삭제 동작 / 콘솔 0. 기존 43테스트 유지.

## 6. 2차 작업(1차 후, 별도 승인 확인) — 편집기 1군

- 선택 모드: 목록에 체크박스(호버 노출) → 하단바에 선택 액션바(일괄 활성/비활성·언제나 활성화 켬/끔·일괄 삭제·일괄 번역·선택분 활성화 키 추가). 에셋추출기2의 thumb-check 패턴 참고.
- 엔트리 복제(편집 폼에 버튼), 순서 위/아래 이동(배치 순서 재부여 — order 스왑).
- 검색&치환: 전 엔트리 대상, 정규식 옵션, 치환은 edits 오버레이로(원본 보존), 실행 전 매치 수 미리보기.
- (3차 후보) undo 스택 · 로어북 설정 편집(검색 깊이/최대 토큰/재귀) · 데코레이터 빌더 · 빈 로어북 신규 작성 · 병합.

## 7. 미결·주의 사항

- **활성화 키 번역 추가 "실패 70"**: 원인 미확정 — 이제 상태줄에 실패 사유가 표시되므로 사장님 재실행 메시지를 받으면 그걸로 진단. (파이프라인은 정상 — max_tokens=0은 생략 처리 확인됨.)
- 번역 실키 스모크(Gemini/OpenAI/Anthropic CORS) 미실시 — 사장님 키 필요.
- New_TSF.charx가 JPEG 폴리글랏이라는 사실을 잊지 말 것(테스트 기대값에 반영돼 있음).
- E2E에서 clipboard.readText는 포커스 제약으로 불가 — 텍스트 검증은 node 테스트로.

## 8. 참고 선례 경로

- 형식 변환 구현 선례: `C:\assetextractor2\web\src\main.ts`(변환 버튼·getBytes 배선) — 같은 코어 사용.
- IDB·최근 파일·persist: LogPapa `C:\pro 1.2\web\src\store.ts`(idbOpen 패턴) / 에셋추출기2 recent UI.
- 완료 후: 이 문서 하단에 "작업 결과" 섹션 추가 + BACKLOG.md 갱신 + 커밋·푸시.

## 9. 작업 결과 (2026-07-08, Claude — 1차 완료)

- **★A 내보내기 포맷 선택** = 커밋 b549fb4. 모달 히어로 아래 `다른 형식으로: [.charx][.png][.json]`(봇카드만, 원본과 같은 형식은 숨김 — `srcFormat` = 원본 매직으로 판별, 폴리글랏의 parsed.format='charx'와 구분). JPEG 폴리글랏→charx는 스펙대로 zip 수술(공짜), 그 외는 cardEncode+`cardAssetBytes` 배선. **발견**: New_TSF 에셋은 ext=png 거짓말(실제 RIFF/WebP) → `pickPngBase` null = png 변환 불가 카드가 맞음 → toast 가드 경로(테스트로 고정). 테스트 4종 추가(총 47).
- **★B 미니 서재** = 커밋 556d016. 신규 `web/src/library.ts`(DB `lbx` v1, 스펙 §5 스키마 그대로). 자동 보관(해시 dedup)·초안 IDB 승격+translations 포함·LS 1회 마이그레이션·최근 파일 목록(용량 표시+persist 1회)·삭제 시 초안 동반. saveDraft는 호출 시점 스냅샷 캡처(디바운스 중 파일 전환 오염 방지 — 스펙에 없던 경쟁 조건 수선).
- 검증: `npm test` 47개 전부 통과 · `web:build` OK · E2E 3종(e2e-fmt/e2e-lib/e2e-mig, 콘솔 에러 0) 전부 통과.
- 미결이던 "활성화 키 번역 실패 70" = 사장님 확인 결과 엔드포인트 URL 오입력이었음(파이프라인 정상) — 종결.
- 다음 = §6 편집기 1군(선택 모드·일괄 작업·복제·순서 이동·검색&치환) — **착수 전 사장님 별도 승인 필요**.
