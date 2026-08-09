# what-did-i-say — TECH_SPEC

> 작성 2026-08-09 · 대상 MVP: Claude Code 전용 · 선행 문서: `HANDOFF.md`, `docs/PRD.md`

## 1. 개요·범위

턴이 끝날 때(Stop hook) "방금 무엇을 요청했는지 + 언제 요청했는지"를 한 줄로 다시 표시하고,
`/what-did-i-say:wdis N`(단축 `/wdis N`)으로 최근 N건을 조회하는 Claude Code 플러그인.

| 구분 | 내용 |
|---|---|
| 범위(MVP) | Claude Code Stop hook `systemMessage` 한 줄 표시 · `/wdis N` 조회 · 현재 세션 한정 |
| 비범위 | Codex 지원(2단계, §10) · 세션 간 통합 조회 · 인덱스/DB · 웹 UI · 설정 파일 |
| 런타임 | Node.js **18.17+** (ESM `.mjs`), **외부 의존성 제로** — stdlib만 사용 |
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
   `stop_hook_active`는 수신만 하고 분기에 쓰지 않는다 — 이 플러그인은 턴을 block하지 않아 재진입 루프가 생기지 않으므로 gate 없이 **Stop event마다** 표시한다.
2. `transcript_path`를 그대로 역방향 스캔해 조건을 만족하는 **최신 1건**을 찾는다.
3. stdout에 `{"systemMessage":"..."}` **JSON 객체 하나만** 출력하고 **항상 exit 0**.
   hook의 plain text stdout은 debug log로만 전달되어 사용자 화면에 나타나지 않으므로, 표시 경로는 반드시 이 JSON 계약을 사용한다.

### 2.2 실행 흐름 — `/wdis N` 모드

1. `/what-did-i-say:wdis N`(단축 `/wdis N`)을 실행하면 `commands/wdis.md`가 로드되고, 본문의 `` !`...` `` **dynamic context injection**이 `node "${CLAUDE_PLUGIN_ROOT}/scripts/wdis.mjs" --list "$0" ...` 을 **먼저 실행**해 그 stdout을 프롬프트에 주입한다. Claude가 실행 여부를 판단하는 구조가 아니므로 실행 경로가 고정된다.
2. `wdis.mjs`가 현재 세션 jsonl(§2.3)을 찾아 최근 N건을 수집해 여러 줄로 출력한다. `N` 생략 시 1.
3. Claude는 주입된 출력의 **행 수·순서·내용을 유지해**(의미적 동일성) 사용자에게 표시한다. frontmatter `allowed-tools`로 이 커맨드가 쓸 수 있는 도구를 제한해 추가 조회·재가공을 막는다.

### 2.3 세션 식별 (list 모드 한정)

hook 모드는 `transcript_path`를 받으므로 탐색이 필요 없다. list 모드는 아래 **우선순위**로 현재 세션 파일을 정한다.

1. **`${CLAUDE_SESSION_ID}` — 기본 경로.** `commands/wdis.md` 본문에서 Claude Code 공식 치환 변수 `${CLAUDE_SESSION_ID}`를 스크립트 인자(`--session-id`)로 전달한다. 스크립트는 `~/.claude/projects/<슬러그>/<session-id>.jsonl`을 직접 지정하므로 현재 세션이 정확히 선택된다.
2. **환경변수 `CLAUDE_CODE_SESSION_ID`.** 1이 비어 있을 때만 사용한다.
3. **mtime 최신 파일 — 최후 fallback.** 1·2가 모두 없을 때만 슬러그 디렉터리의 `*.jsonl` 중 mtime이 가장 최신인 파일을 쓴다. **이 경로는 현재 세션을 보장하지 않는다**(§9-1).

슬러그 규칙: `process.cwd()`의 비영숫자를 `-`로 치환한다(구현: `cwd.replace(/[^a-zA-Z0-9]/g, '-')`).
`/Users/mini/Github/ai-tools/kaivo` → `-Users-mini-Github-ai-tools-kaivo`

디렉터리 또는 파일이 없으면 §7의 list 모드 에러 문구를 출력한다.

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
export const MAX_LIMIT = 100;                 // /wdis N 상한
export const MAX_SCAN_BYTES = 10 * 1024 * 1024; // 총 스캔 바이트 상한 (10MiB)

export function collectRecent(filePath, limit, { chunkSize = 65536, maxBytes = MAX_SCAN_BYTES } = {})
                                            // → [{ timestamp, text }] 오름차순
export function extractRequest(line)        // → { timestamp, text } | null
export function normalizeText(raw)          // → string (공백 collapse + trim + 절단)
```

절차:

1. `fs.openSync` + `fstatSync`로 파일 크기를 구한다. `limit`은 호출 전에 **1~`MAX_LIMIT`(100)** 으로 보정한다.
2. 파일 끝에서 `chunkSize` 바이트씩 앞으로 이동하며 읽고, 읽은 Buffer를 **앞쪽에 이어붙인다**.
3. **Buffer를 모두 이어붙인 뒤에 `toString('utf8')`을 호출한다** — 청크 경계에서 한글 등 멀티바이트 문자가 잘리는 문제를 피한다.
4. 개행으로 분리해 뒤에서부터 `extractRequest`에 넘긴다. 첫 조각(파일 앞쪽으로 이어지는 불완전 라인)은 다음 청크와 결합할 때까지 보류한다.
5. 아래 셋 중 하나에 도달하면 즉시 중단하고 `closeSync` 한다.
   - 채택 건수가 `limit`에 도달
   - 파일 시작에 도달
   - **읽은 누적 바이트가 `maxBytes`(10MiB)에 도달** — 이 경우 예외 없이 **그때까지 수집한 분량만** 반환한다
6. 수집 결과를 뒤집어 **시간 오름차순**으로 반환한다.

### 4.2 채택 조건

`extractRequest`는 아래를 모두 만족할 때만 결과를 돌려주고, 하나라도 어긋나면 `null`을 돌려준다.

1. JSON 파싱에 성공한다(실패 시 `null`).
2. `type === "user"`.
3. **`timestamp`가 유효하다** — `typeof timestamp === "string" && Number.isFinite(Date.parse(timestamp))`. 어긋나면 그 라인만 `null`로 흘리고 역방향 스캔을 계속해 **직전의 정상 요청**으로 넘어간다.
4. `isSidechain !== true`.
5. `isMeta !== true`.
6. `message.content`가 배열이고 `type === "tool_result"` 항목을 포함하면 제외한다.
7. 텍스트를 아래 §4.3으로 정규화한 결과가 빈 문자열이 아니다.

배열 content에서 텍스트를 얻을 때는 `type === "text"` 항목의 `text`만 이어붙인다.

**list 모드 자기 제외** — `--list` 모드에서는 `/wdis` 커맨드 자신을 결과에서 제외한다. §4.3의 1번 규칙으로 환원한 결과의 **커맨드 토큰이 정확히 `/wdis` 또는 `/what-did-i-say:wdis`인 경우**(커맨드명 뒤가 문자열 끝이거나 공백일 때)만 건너뛰고, **부족한 건수만큼 더 과거로 역스캔을 이어간다**. `/wdis-help`처럼 이름이 이어지는 다른 커맨드는 제외 대상이 아니다. hook 모드에는 적용하지 않는다.

### 4.3 텍스트 정규화

순서대로 적용한다.

| # | 규칙 | 처리 |
|---|---|---|
| 1 | `<command-name>` 래퍼 | `<command-name>`과 `<command-args>` 값을 뽑아 `/커맨드 인자` 한 줄로 환원해 채택한다. 인자가 비면 커맨드명만 남긴다 |
| 2 | `<local-command-stdout>` | 해당 라인은 제외한다 |
| 3 | `<local-command-caveat>` | 슬래시 커맨드 실행에 딸려오는 안내 문구이므로 제외한다 |
| 4 | `<system-reminder>` 등 주입 컨텍스트 | 태그 블록을 제거한다. 제거 후 남은 사용자 텍스트가 있으면 그 텍스트만 채택하고, 남는 것이 없으면 제외한다 |
| 4b | `<teammate-message>`·`<task-notification>`·`<cross-session-message>` 포함 라인 | 시스템·타 에이전트가 주입한 user 턴이므로 **라인 전체 제외** — 실측상 `isMeta` 마커가 없어 텍스트 패턴으로만 걸러진다 |
| 5 | 공백 정규화 | CRLF/LF를 포함한 **연속 공백을 단일 공백으로 collapse** 한 뒤 앞뒤 공백을 제거한다 (`raw.replace(/\s+/g, ' ').trim()`). 첫 줄만 취하지 않고 전체를 한 줄로 접는다 |
| 6 | 길이 제한 | **Unicode code point 기준 최대 80** — `Array.from(text).length > 80`이면 앞 **79 code points + `…`** 로 절단한다(결과 80 code points). `Array.from`을 쓰므로 이모지 등의 surrogate pair가 반으로 갈리지 않는다 |

## 5. 출력 포맷

시간은 ISO UTC를 파싱해 **시스템 로컬 타임존**으로 표시한다. 상대시간 기준:

| 경과 | 표기 |
|---|---|
| 60초 미만 | `방금` |
| 60분 미만 | `N분 전` |
| 24시간 미만 | `N시간 전` |
| 그 이상 | `N일 전` |

Stop hook — stdout에는 **JSON 객체 하나**만 쓴다.

```json
{"systemMessage":"🗣 14:32 (12분 전) | 파서 필터 규칙 정리해줘"}
```

Claude Code가 `systemMessage` 값을 사용자에게 표시한다. 사용자가 보는 한 줄:

```
🗣 14:32 (12분 전) | 파서 필터 규칙 정리해줘
```

`systemMessage` 값에는 개행이 없다(§4.3-5). 호스트가 표시 시 prefix(`Stop says:` 등)를 덧붙일 수 있으므로, 최종 포맷은 실측 후 확정한다(PLAN 커밋 3 완료 기준).

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

`commands/wdis.md` — Claude에게 실행을 부탁하는 prompt가 아니라, **`allowed-tools` 제한 + dynamic context injection**으로 실행 결과를 사전 주입하는 구조다. 커맨드 인자 중 **첫 번째는 `$0`** 이다(`$1`이 아니다).

```markdown
---
description: 최근 요청한 내용을 시각과 함께 최대 N건 표시합니다 (기본 1건, 최대 100건)
argument-hint: "[N]"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/wdis.mjs" --list "$0" --session-id "${CLAUDE_SESSION_ID}"`

위 실행 결과가 이 프롬프트에 이미 주입되어 있습니다.
주입된 출력의 **행 수·순서·내용을 유지해** 사용자에게 표시하세요. 요약·재정렬·해설·추가 조회를 하지 마세요.
```

- `` !`...` `` 는 커맨드 로드 시점에 명령을 실행해 stdout을 프롬프트에 주입한다 — 실행 경로가 Claude의 판단에 좌우되지 않는다.
- `allowed-tools: Bash(node:*)` 로 이 커맨드가 쓸 수 있는 도구를 주입용 실행 하나로 제한한다.
- **보장 명령은 `/what-did-i-say:wdis`** 이며, bare `/wdis`는 같은 이름의 커맨드가 없을 때만 동작하는 단축 호출이다.

기존 Stop hook(하네스의 orca `claude-hook.sh` 등)과는 병합되어 공존한다. 이 플러그인은 stdout에 `systemMessage`
JSON 한 줄만 쓰고 종료 코드로 흐름을 제어하지 않으므로 다른 Stop hook의 동작에 관여하지 않는다.

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

`node --test` 로 실행하며, 픽스처는 실제 jsonl 라인을 축소한 `scripts/fixtures/*.jsonl`을 쓴다.
**완료 게이트는 `node --test` 전체 통과 하나뿐이다.** 커버리지(`node --test --experimental-test-coverage`,
70% 이상)는 게이트가 아니라 참고 목표로만 측정한다.

| # | 케이스 | 기대 |
|---|---|---|
| 1 | 문자열 content | 텍스트 그대로 채택 |
| 2 | 배열 content (text 항목) | text만 이어붙여 채택 |
| 3 | `<command-name>` 래퍼 | `/커맨드 인자` 한 줄로 환원 |
| 4 | `isSidechain: true` | 제외 |
| 5 | 배열 content에 `tool_result` 포함 | 제외 |
| 6 | `<system-reminder>` 혼합 | 태그 블록 제거 후 사용자 텍스트만 채택 |
| 7 | 80 code points 초과 | `Array.from(결과).length === 80` (79 + `…`), 이모지 포함 입력에서 surrogate pair 미파손 |
| 8 | 다중 줄 입력 | `"첫 줄\r\n\n  둘째 줄\t셋째 "` → 정확히 `"첫 줄 둘째 줄 셋째"` (개행 없음) |
| 9 | 최신 라인의 `timestamp` 누락·파싱 불가 | 그 라인은 skip하고 **직전 정상 요청**으로 fallback |
| 10 | 역방향 스캔 N건 중단 | 픽스처가 20건이어도 `limit=3`이면 3건, 시간 오름차순 |
| 11 | `limit` 초과값 clamp | `--list 500` → 100건으로 보정하고 보정 안내 1줄 포함 |
| 12 | `maxBytes` 도달 | 예외 없이 그때까지 수집한 분량만 반환 |
| 13 | list 모드 자기 제외 | 최신 라인이 `/wdis 3`이면 건너뛰고 그 이전 요청부터 채운다 |
| 14 | 자기 제외 경계(음성) | `/wdis-help 1`은 제외하지 **않고** 그대로 채택한다 |
| 15 | 빈 파일 | 빈 배열 |
| 16 | hook 모드 stdout | `JSON.parse(stdout)`가 성공하고, `systemMessage`가 `🗣 `로 시작하며 `\n`·`\r`을 포함하지 않는다 |
| 17 | 주입 턴(§4.3-4b) | `<teammate-message>`·`<task-notification>`·`<cross-session-message>` 포함 라인 제외 |
| 18 | 커맨드 출력 래퍼(§4.3-2·3) | `<local-command-stdout>`·`<local-command-caveat>` 라인 제외 |
| 19 | 빈 content | 빈 문자열·공백만 있는 content는 제외 |

멀티바이트 경계 회귀를 막기 위해 10번 케이스는 `chunkSize`를 작게(예: 64) 주입해 한글 라인이 여러 청크에
걸치도록 만든다.

## 9. 알려진 한계

1. **같은 프로젝트 병렬 세션 — mtime fallback 경로에서만 해당.** list 모드는 `${CLAUDE_SESSION_ID}`(또는 env)로 현재 세션 파일을 정확히 지정하므로 병렬 세션에서도 정상 동작한다. 다만 두 값이 모두 없어 §2.3-3의 mtime fallback으로 내려간 경우에는, 동일 cwd의 다른 세션 요청을 표시할 수 있다. hook 모드는 `transcript_path`를 받으므로 해당하지 않는다.
2. **jsonl 스키마 의존** — Claude Code 내부 포맷이므로 상위 버전에서 필드명이 바뀔 수 있다. 파싱 실패는 조용한 무출력으로 흡수되어 사용자에게 오류로 보이지 않는다.
3. **표시 위치** — Stop hook이 반환한 `systemMessage`를 Claude Code가 턴 종료 직후 표시한다. statusline이나 별도 창을 쓰지 않으며, 표시 형식(호스트 prefix 포함 여부)은 호스트가 결정한다.
4. **스캔 상한** — 무상태 원칙을 유지하면서 대용량 jsonl에서 비용이 폭주하지 않도록 두 개의 상한을 둔다. `N` 상한은 **100**이며 초과 입력은 100으로 보정하고 한 줄 안내한다. 총 스캔 바이트 상한은 **10MiB**이며, 도달하면 그때까지 수집한 분량만 반환한다 — 세션 초반 요청까지 거슬러 올라가지 못할 수 있다.

## 10. 2단계 — Codex 지원

> 2026-08-09 조사 기록(비규범) — 2단계 착수 시 재실측 후 확정한다.

조사 시점 관찰: Codex는 `~/.codex/config.toml`의 `notify`가 단일 슬롯이며 oh-my-codex가 점유 중이었고,
notify 경로는 하위 프로세스 stdout이 폐기되어 재표시 요건을 충족하지 못했다. 유력안은 `~/.codex/hooks.json`의
Stop 엔트리 등록이다 — 조사 당시 Stop stdin 계약이 Claude Code와 유사해 `wdis.mjs`의 상당 부분을 재사용하고
`rollout-*.jsonl`용 추출기를 추가하는 방향이 가능해 보였다. 다만 이는 구현 계약이 아니라 관찰 기록이며,
stdin 계약·재사용 범위·변경량은 2단계 착수 시 rollout 포맷과 함께 재실측한 뒤 별도 TECH_SPEC으로 확정한다.
