# what-did-i-say — 아이디어 회의 핸드오프

> 작성 2026-08-09 (일) · 작성 세션 cwd `/Users/mini/Github` · **이 문서는 회의 시작점이며 스펙이 아니다.**
> 다음 세션은 이 문서를 읽고 **brainstorming부터** 시작한다. 아래 "정해야 할 것"이 회의 안건이다.

## 1. 한 줄 정의

Claude Code·Codex에서 턴이 끝날 때(Stop hook) **"내가 뭘 요청했는지 + 언제 요청했는지"** 를 다시 보여주는 플러그인.

## 2. 대표 원문 요청 (2026-08-09)

- 이름: `what-did-i-say`, 슬래시 커맨드 `/wdis`
- 기능: "claude code, codex 같은거에서 stop hook 만났을때 내가 요청한 프롬프트랑 요청시간이 나오게 하는거임"
- 이력 조회: "그전에 몇개 요청사항을 보고싶으면 `/wdis 3` 하면 쭉쭉 나오는거고"

이게 전부다. 나머지는 전부 미정 — 회의에서 정한다.

## 3. 확인된 사실 (실측 완료 — 회의에서 재조사 불필요)

| 항목 | 실측 결과 |
|---|---|
| 프롬프트 원천 | `~/.claude/projects/<슬러그>/<session-id>.jsonl`. `type:"user"` 라인에 `timestamp`(ISO, UTC) · `uuid` · `sessionId` · `cwd` · `message.content` 존재 → **요청문+시간 추출 가능** |
| 슬러그 규칙 | cwd의 비영숫자를 `-`로 치환. 예 `/Users/mini/Github/ai-tools/kaivo` → `-Users-mini-Github-ai-tools-kaivo` |
| Stop hook 입력 | Claude Code가 `session_id` · `transcript_path` · `cwd` · `stop_hook_active`를 stdin JSON으로 전달 |
| **Stop 슬롯 선점** | 현재 하네스 `Stop`에 orca `claude-hook.sh`가 이미 등록됨. 플러그인 훅은 settings 훅과 **병합**되므로 공존은 되지만, 출력이 섞이는지 회의에서 확인 필요 |
| **Codex 쪽 제약** | `~/.codex/config.toml`의 `notify`가 **단일 슬롯**이고 이미 oh-my-codex가 점유 중 (`notify-hook.js`). Codex 지원은 이 충돌을 어떻게 푸느냐가 관건 |
| 노이즈 | `type:"user"` 라인에 실제 프롬프트 외에 슬래시 커맨드 래퍼(`<command-name>`, `<local-command-stdout>`) · hook 주입 컨텍스트 · tool_result가 섞여 들어옴 → **필터링이 이 플러그인의 핵심 난이도** |
| 구조 레퍼런스 | `../hook-raider/` — `.claude-plugin/` · `hooks/` · `commands/` · `server/`(+ `*.test.mjs`) 레이아웃 |
| 배포 경로 | `../plugins/` = token-keeper 마켓플레이스. `plugins/<name>` 을 **git submodule**로 등록하는 방식 (`.gitmodules`) |

## 4. 회의에서 정해야 할 것

1. **출력 위치** — Stop hook의 stdout은 터미널에 찍힌다. 대표 룰상 "턴 끝 푸시가 최종 보고를 덮는" 문제를 싫어함. 터미널 직접 출력 / statusline / 별도 파일 중 무엇인가
2. **노이즈 필터 기준** — 순수 사용자 타이핑만? 슬래시 커맨드도 포함? hook 주입 컨텍스트는 무조건 제외?
3. **`/wdis N` 범위** — 현재 세션 한정인가, 같은 프로젝트(슬러그)의 이전 세션까지인가
4. **시간 표기** — ISO UTC 원본 vs KST 변환 vs 상대시간("12분 전"). 대표 룰은 "UTC 기준 계산, KST는 표시용"
5. **Codex 지원 범위** — MVP는 Claude Code만? notify 단일 슬롯 충돌을 체이닝으로 풀지, Codex는 후순위로 뺄지
6. **저장 방식** — 매번 jsonl을 파싱할지, 자체 인덱스를 쌓을지 (jsonl은 수백MB 규모: `where-is-token` 176세션 등)
7. **배포** — 독립 repo 유지 vs token-keeper 마켓플레이스 submodule 등록. 등록한다면 시점

## 5. 진행 규칙

- 회의는 `superpowers:brainstorming`으로 시작
- 결론 나오면 PRD → TECH_SPEC → PLAN 3종을 **한 PR**로 (기획 문서 PR 단위 룰)
- 구현은 PLAN의 단계를 커밋 단위(프로덕션 코드 300줄 이하)로 분해

## 6. 상태

- repo: `git init` 완료 (`main`), **커밋 0개**, 이 문서가 유일한 파일
- 스캐폴드·README·CLAUDE.md 없음 — 회의 결론 후 생성
