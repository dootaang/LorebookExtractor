# 로어북 추출기

RisuAI 봇카드와 모듈에서 로어북을 추출해 읽기 좋게 보여주는 웹앱입니다.

## 지원 입력

- `.charx`, `.module.charx`
- `.png`, `.jpeg`, `.jpg` 캐릭터 카드
- `.json` 캐릭터 카드
- `.risum` 리스 모듈

## 주요 기능

- CCv3 `character_book.entries`와 Risu module `module.lorebook` 정규화
- 폴더, 검색, 필터, 정렬, 키워드/2차 키/상시활성 표시
- Markdown, CCv3 character book JSON, 정규화 JSON 내보내기
- 개인 API 키 기반 본문+이름 번역
- 키워드는 발동 조건이므로 번역하지 않고 원문을 유지
- LogPapa 방식의 결합 번역, 마크업 보존, 429 재시도, 프롬프트 프리셋, 세션 전용 키 저장, IndexedDB 번역 캐시

## 개발

```powershell
npm ci
npm test
npm run web:build
npm run web:dev
```

개발 서버 기본 주소는 `http://127.0.0.1:8134/`입니다.

## 배포

Firebase Hosting 프로젝트는 `lorebookextractor`로 설정되어 있습니다. GitHub Actions 배포에는 저장소 secret `FIREBASE_SERVICE_ACCOUNT_LOREBOOKEXTRACTOR`가 필요합니다.

## 디자인 메모

초기 UI는 기능 구현 우선입니다. 향후 디자인 리워크 항목은 `BACKLOG.md`에 남겨두었습니다.
