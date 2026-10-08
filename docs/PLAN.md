# what-did-i-say — PLAN

> 상태: 완료 (0.3.1)

> 작성 2026-08-09 · 갱신 2026-10-08 · 선행 문서: [PRD.md](./PRD.md)(무엇을 만드는가) · [TECH_SPEC.md](./TECH_SPEC.md)(어떻게 구현하는가)

## 1. 완료 이력

| PR | 버전 | 내용 |
|---|---|---|
| #1 | — | 기획 문서 3종(PRD·TECH_SPEC·PLAN) |
| #2 | 0.1.0 | 스캐폴드 → jsonl 파서·필터 → Stop 훅 `systemMessage` 한 줄 → `/wdis` 커맨드 → README |
| #3 | 0.2.0 | `/wdis` 턴 0 처리(`UserPromptExpansion` 훅), N 상한 10 |
| #4 | 0.3.0 | Stop 훅 한 줄 출력 제거 → 프롬프트 위 띠 박스(mod) |
| #5 | 0.3.1 | `/compact`(manual·plugin) 직후 띠 비우기 |

token-keeper `plugins` 마켓플레이스에 등록됨 — 설치 키 `what-did-i-say@token-keeper`.

0.1.0~0.2.0의 커밋 단위 계획(Stop 훅 기준 5커밋·실측 체크리스트)은 git 이력의 이 파일에 남아 있다.

## 2. 남은 일

| 항목 | 상태 |
|---|---|
| 띠를 입력창 아래로 옮기는 안 | 대표 보류 중 |
| Codex 지원 | 범위 외 (TECH_SPEC §10) |

## 3. 검증 명령

```bash
node --test                  # /wdis 스크립트
claude plugin validate .     # 매니페스트·hooks·mod 모듈
claude plugin test .         # 띠 박스 mod
```

## 4. 롤백

무상태 설계라 남는 데이터가 없다. 플러그인 제거(`--plugin-dir` 미지정 또는 `claude plugin uninstall`)만으로 완전 원복된다.
