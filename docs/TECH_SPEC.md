# what-did-i-say — TECH_SPEC

> 작성 2026-08-09 · 대상 MVP: Claude Code 전용 · 선행 문서: `HANDOFF.md`, `docs/PRD.md`

## 1. 개요·범위

턴이 끝날 때(Stop hook) "방금 무엇을 요청했는지 + 언제 요청했는지"를 터미널에 한 줄로 다시 표시하고,
`/wdis N`으로 최근 N건을 조회하는 Claude Code 플러그인.

| 구분 | 내용 |
|---|---|
| 범위(MVP) | Claude Code Stop hook 1줄 출력 · `/wdis N` 조회 · 현재 세션 한정 |
| 비범위 | Codex 지원(2단계, §10) · 세션 간 통합 조회 · 인덱스/DB · 웹 UI · 설정 파일 |
| 런타임 | Node.js 18+ (ESM `.mjs`), **외부 의존성 제로** — stdlib만 사용 |
| 상태 | 무상태. 인덱스·캐시·상태 파일을 만들지 않으며, 원천 jsonl을 매번 읽는다 |

## 2. 아키텍처

```
.claude-plugin/plugin.json   # 플러그인 매니페스트 (메타데이터만)
hooks/hooks.json             # Stop hook 등록
commands/wdis.md             # /wdis 슬래시 커맨드 정의
scripts/wdis.mjs             # 진입점 — hook 모드 / --list 모드 분기, 시간 포맷, 세션 탐색
scripts/parser.mjs           # jsonl 역방향 스캔 + 필터 + 텍스트 정규화 (핵심 로직)
scripts/parser.test.mjs      # node --test
scripts/fixtures/*.jsonl     # 실제 라인을 축소한 픽스처
```

역할 경계:

- `parser.mjs` — 파일을 끝에서부터 읽어 "사용자 요청" 후보를 판정하고 `{ timestamp, text }` 배열을 돌려준다. 시간 표시·이모지·터미널 출력을 알지 못한다.
- `wdis.mjs` — 실행 모드 판정, stdin 파싱, 세션 파일 탐색, 상대시간·로컬시간 포맷, stdout 출력.
- 두 모듈 모두 순수 함수를 named export 하여 테스트에서 직접 호출한다. `wdis.mjs`는 진입점이므로
  `import.meta.url === pathToFileURL(process.argv[1]).href` 가드 뒤에서만 main을 실행한다.

### 2.1 실행 흐름 — Stop hook 모드

1. Claude Code가 stdin으로 JSON을 전달한다: `session_id` · `transcript_path` · `cwd` · `stop_hook_active`.
2. `stop_hook_active === true`면 재진입이므로 출력 없이 종료한다(중복 표시 방지).
3. `transcript_path`를 그대로 역방향 스캔해 조건을 만족하는 **최신 1건**을 찾는다.
4. stdout에 한 줄을 출력하고 **항상 exit 0**.

### 2.2 실행 흐름 — `/wdis N` 모드

1. `commands/wdis.md`가 Claude에게 `node "${CLAUDE_PLUGIN_ROOT}/scripts/wdis.mjs" --list N` 실행을 지시한다.
2. `wdis.mjs`가 현재 세션 jsonl을 찾아 최근 N건을 수집한다. `N` 생략 시 1.
3. 표준출력의 여러 줄을 Claude가 가공 없이 그대로 사용자에게 표시한다.

### 2.3 세션 식별 (list 모드 한정)

hook 모드는 `transcript_path`를 받으므로 탐색이 필요 없다. list 모드는 아래 순서로 찾는다.

1. `process.cwd()`의 비영숫자를 `-`로 치환해 슬러그를 만든다.
   `/Users/mini/Github/ai-tools/kaivo` → `-Users-mini-Github-ai-tools-kaivo`
   (구현: `cwd.replace(/[^a-zA-Z0-9]/g, '-')`)
2. `~/.claude/projects/<슬러그>/` 안의 `*.jsonl` 중 **mtime이 가장 최신인 파일**을 현재 세션으로 간주한다.
3. 디렉터리 또는 파일이 없으면 §7의 list 모드 에러 문구를 출력한다.

## 3. 데이터 소스 (jsonl 스키마)

원천은 `~/.claude/projects/<슬러그>/<session-id>.jsonl`. 한 줄이 JSON 객체 하나이며, 아래는 실측한 필드다.

| 필드 | 타입 | 용도 |
|---|---|---|
| `type` | string | `"user"` / `"assistant"` / `"system"` — 사용자 요청 후보는 `"user"`만 |
| `timestamp` | string | ISO 8601 UTC (예: `2026-08-09T00:42:19.745Z`) — 요청 시각의 유일한 출처 |
| `message.content` | string \| array | 문자열이거나 `{type:"text"|"tool_result", ...}` 항목의 배열 |
| `isSidechain` | boolean | 서브에이전트 대화 여부 |
| `isMeta` | boolean | 시스템이 삽입한 메타 라인 여부 |
| `cwd` · `sessionId` · `uuid` | string | 검증·디버깅용. MVP 로직은 사용하지 않는다 |

실측 예시 (요약):

```jsonl
{"type":"user","message":{"role":"user","content":"@HANDOFF.md 문서 읽고 아이디어 이어나가자"},"timestamp":"2026-08-09T00:42:19.745Z","isSidechain":false,"cwd":"/Users/mini/Github/ai-tools/what-did-i-say"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_016o","content":"Launching skill: ..."}]},"timestamp":"2026-08-09T00:42:31.860Z"}
{"type":"user","message":{"role":"user","content":"<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>"},"timestamp":"2026-08-08T10:48:39.813Z"}
```

파일은 세션당 수십 MB까지 커진다(176세션 규모 사례 있음). 전체 읽기는 금지하고 §4.1의 역방향 스캔만 사용한다.

## 4. 파서·필터 명세

### 4.1 역방향 스캔

```js
// parser.mjs
export function collectRecent(filePath, limit, { chunkSize = 65536 } = {})  // → [{ timestamp, text }] 오름차순
export function extractRequest(line)                                        // → { timestamp, text } | null
export function normalizeText(raw)                                          // → string (첫 줄 + 절단)
```

절차:

1. `fs.openSync` + `fstatSync`로 파일 크기를 구한다.
2. 파일 끝에서 `chunkSize` 바이트씩 앞으로 이동하며 읽고, 읽은 Buffer를 **앞쪽에 이어붙인다**.
3. **Buffer를 모두 이어붙인 뒤에 `toString('utf8')`을 호출한다** — 청크 경계에서 한글 등 멀티바이트 문자가 잘리는 문제를 피한다.
4. 개행으로 분리해 뒤에서부터 `extractRequest`에 넘긴다. 첫 조각(파일 앞쪽으로 이어지는 불완전 라인)은 다음 청크와 결합할 때까지 보류한다.
5. 채택 건수가 `limit`에 도달하거나 파일 시작에 도달하면 즉시 중단하고 `closeSync`.
6. 수집 결과를 뒤집어 **시간 오름차순**으로 반환한다.

### 4.2 채택 조건

`extractRequest`는 아래를 모두 만족할 때만 결과를 돌려주고, 하나라도 어긋나면 `null`을 돌려준다.

1. JSON 파싱에 성공한다(실패 시 `null`).
2. `type === "user"`.
3. `isSidechain !== true`.
4. `isMeta !== true`.
5. `message.content`가 배열이고 `type === "tool_result"` 항목을 포함하면 제외한다.
6. 텍스트를 아래 §4.3으로 정규화한 결과가 빈 문자열이 아니다.

배열 content에서 텍스트를 얻을 때는 `type === "text"` 항목의 `text`만 이어붙인다.

### 4.3 텍스트 정규화

순서대로 적용한다.

| # | 규칙 | 처리 |
|---|---|---|
| 1 | `<command-name>` 래퍼 | `<command-name>`과 `<command-args>` 값을 뽑아 `/커맨드 인자` 한 줄로 환원해 채택한다. 인자가 비면 커맨드명만 남긴다 |
| 2 | `<local-command-stdout>` | 해당 라인은 제외한다 |
| 3 | `<local-command-caveat>` | 슬래시 커맨드 실행에 딸려오는 안내 문구이므로 제외한다 |
| 4 | `<system-reminder>` 등 주입 컨텍스트 | 태그 블록을 제거한다. 제거 후 남은 사용자 텍스트가 있으면 그 텍스트만 채택하고, 남는 것이 없으면 제외한다 |
| 5 | 첫 줄만 사용 | 개행 기준 첫 줄을 취하고 앞뒤 공백을 제거한다 |
| 6 | 길이 제한 | 80자를 넘으면 **앞 79자 + `…`** 로 절단한다(결과 길이 80자) |

## 5. 출력 포맷

시간은 ISO UTC를 파싱해 **시스템 로컬 타임존**으로 표시한다. 상대시간 기준:

| 경과 | 표기 |
|---|---|
| 60초 미만 | `방금` |
| 60분 미만 | `N분 전` |
| 24시간 미만 | `N시간 전` |
| 그 이상 | `N일 전` |

Stop hook (항상 1줄):

```
🗣 14:32 (12분 전) | 파서 필터 규칙 정리해줘
```

`/wdis N` (시간 오름차순, 인덱스는 "몇 번째 이전 요청"을 뜻하므로 `[1]`이 가장 최근):

```
[3] 14:20 (25분 전) | 훅 등록 형식 확인해줘
[2] 14:32 (12분 전) | 파서 필터 규칙 정리해줘
[1] 14:44 (방금) | 테스트 케이스 추가해줘
```

요청 시각이 오늘이 아니면 날짜를 덧붙인다.

```
[3] 08-08 23:10 (15시간 전) | 슬러그 규칙 실측해줘
```

## 6. 커맨드·훅 등록

패밀리 컨벤션(hook-raider 실물)대로 매니페스트와 hooks 등록을 분리한다. `${CLAUDE_PLUGIN_ROOT}`는
Claude Code가 플러그인 설치 경로로 치환한다.

`.claude-plugin/plugin.json` — 메타데이터만 담는다.

```json
{
  "$schema": "https://json.schemastore.org/claude-code-plugin-manifest.json",
  "name": "what-did-i-say",
  "version": "0.1.0",
  "description": "턴이 끝날 때 방금 요청한 내용과 시각을 한 줄로 다시 표시하고 /wdis 로 최근 요청을 조회",
  "author": { "name": "brody424" },
  "license": "MIT",
  "keywords": ["hooks", "prompt-history", "productivity"]
}
```

`hooks/hooks.json` — Stop hook 등록.

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/wdis.mjs\"",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

`commands/wdis.md` — frontmatter에 `description`, 본문에 실행 지시를 담는다.

```markdown
---
description: 최근 요청한 내용을 시각과 함께 최대 N건 표시합니다 (기본 1건)
argument-hint: "[N]"
---

`node "${CLAUDE_PLUGIN_ROOT}/scripts/wdis.mjs" --list $1` 을 실행하고,
표준출력을 **가공하지 말고 그대로** 사용자에게 표시하세요. 요약·재정렬·해설을 덧붙이지 마세요.
```

기존 Stop hook(하네스의 orca `claude-hook.sh` 등)과는 병합되어 공존한다. 이 플러그인은 stdout에 한 줄만
쓰고 종료 코드로 흐름을 제어하지 않으므로 다른 Stop hook의 동작에 관여하지 않는다.

## 7. 에러 처리

hook 모드의 원칙은 **턴 완료를 절대 방해하지 않는 것**이다.

| 상황 | 처리 |
|---|---|
| stdin JSON 파싱 실패 | 출력 없이 exit 0 |
| `transcript_path` 없음·파일 없음·권한 오류 | 출력 없이 exit 0 |
| 채택 가능한 라인이 없음(빈 파일 포함) | 출력 없이 exit 0 |
| 예상 못한 예외 | main 전체를 `try/catch`로 감싸 삼키고 exit 0 |

- hook 모드는 stderr에도 쓰지 않는다. 예외를 삼키는 지점은 이 최상위 catch **한 곳뿐**이며, 내부 함수는 예외를 그대로 올린다.
- list 모드만 사람이 읽을 한 줄 에러를 허용한다. 예: `요청 기록을 찾지 못했습니다 (세션 파일 없음)`. 종료 코드는 동일하게 0.

## 8. 테스트 전략

`node --test scripts/` 로 실행하며, 픽스처는 실제 jsonl 라인을 축소한 `scripts/fixtures/*.jsonl`을 쓴다.
커버리지는 `node --test --experimental-test-coverage`로 측정하고 **70% 이상**을 목표로 한다.

| # | 케이스 | 기대 |
|---|---|---|
| 1 | 문자열 content | 텍스트 그대로 채택 |
| 2 | 배열 content (text 항목) | text만 이어붙여 채택 |
| 3 | `<command-name>` 래퍼 | `/커맨드 인자` 한 줄로 환원 |
| 4 | `isSidechain: true` | 제외 |
| 5 | 배열 content에 `tool_result` 포함 | 제외 |
| 6 | `<system-reminder>` 혼합 | 태그 블록 제거 후 사용자 텍스트만 채택 |
| 7 | 80자 초과 | 79자 + `…` (총 80자) |
| 8 | 역방향 스캔 N건 중단 | 픽스처가 20건이어도 `limit=3`이면 3건, 시간 오름차순 |
| 9 | 빈 파일 | 빈 배열 |

멀티바이트 경계 회귀를 막기 위해 8번 케이스는 `chunkSize`를 작게(예: 64) 주입해 한글 라인이 여러 청크에
걸치도록 만든다.

## 9. 알려진 한계

1. **같은 프로젝트 병렬 세션** — list 모드는 mtime이 최신인 jsonl을 현재 세션으로 간주하므로, 동일 cwd에서 세션 두 개를 함께 사용하면 다른 세션의 요청을 표시할 수 있다. hook 모드는 `transcript_path`를 받으므로 해당하지 않는다.
2. **jsonl 스키마 의존** — Claude Code 내부 포맷이므로 상위 버전에서 필드명이 바뀔 수 있다. 파싱 실패는 조용한 무출력으로 흡수되어 사용자에게 오류로 보이지 않는다.
3. **표시 위치** — Stop hook stdout은 턴 종료 직후 터미널에 남는다. statusline이나 별도 창을 쓰지 않는다.
4. **N 상한 없음** — `/wdis 500` 같은 큰 값도 그대로 스캔한다. 파일 전체를 훑을 수 있으나 무상태 원칙을 유지하기 위해 상한을 두지 않는다.

## 10. 2단계 — Codex 지원

Codex는 `~/.codex/config.toml`의 `notify`가 단일 슬롯이며 oh-my-codex가 점유 중이므로 이 경로를 쓰지 않는다.
대신 `~/.codex/hooks.json`의 Stop 엔트리로 등록한다. Codex의 Stop hook stdin 계약이 Claude Code와 호환되므로
`wdis.mjs`의 진입점·필터·출력은 그대로 재사용하고, 원천이 `rollout-*.jsonl`로 다르다는 점만 흡수하면 된다.
구체적으로는 `parser.mjs`에 rollout 라인용 `extractRequest` 변형 하나를 추가하고, 파일명 패턴으로 어느 추출기를
쓸지 고르는 분기 한 줄을 두는 수준이다. 2단계 착수 시 rollout 포맷 실측을 먼저 수행한다.
