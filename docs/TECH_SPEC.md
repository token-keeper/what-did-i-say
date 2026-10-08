# what-did-i-say — TECH_SPEC

> 기준 0.3.2 · 최초 작성 2026-08-09, 띠 박스(mod) 구조로 재작성 2026-10-08 · 대상: Claude Code 전용

## 1. 개요·범위

답변이 끝나 입력을 기다리는 동안 **입력창 바로 아래 띠**(힌트 줄 자리)에 "방금 무엇을 요청했는지 + 언제 요청했는지"를 박스로 보여주고,
`/what-did-i-say:wdis N`(단축 `/wdis N`)으로 현재 세션의 최근 N건을 조회하는 Claude Code 플러그인.

| 구분 | 내용 |
|---|---|
| 범위 | 입력창 아래 띠 박스(mod) · `/wdis N` 조회 · 현재 세션 한정 |
| 비범위 | Codex 지원(§10) · 세션 간 통합 조회 · 인덱스/DB · 웹 UI · 설정 파일 |
| 런타임 | 띠: Claude Code mods(함수 훅 모듈, TSX) / 조회: Node.js **18.17+** (ESM `.mjs`), 외부 의존성 제로 |
| 상태 | 띠는 마지막 요청 1건만 mod 상태(atom)에 보관한다(파일 아님). 조회는 무상태 — 원천 jsonl을 매번 읽는다 |
| 요구 Claude Code | 띠: **v2.1.286 이상**. `/wdis` 조회: v2.1.200 이상 실측(그 미만 미확인). 상세는 §6 |

## 2. 아키텍처

```
.claude-plugin/plugin.json   # 매니페스트 (메타데이터 + mod 상태 계약 경로 "types")
hooks/hooks.json             # UserPromptExpansion 훅(/wdis) + "modules"(띠 mod) 등록
hooks/register.tsx           # 띠 mod — 요청 기록·compact 시 비움·PromptHint 렌더
hooks/register.test.tsx      # claude plugin test
types/index.d.ts             # mod 상태 계약 (PluginState['what-did-i-say'].last)
commands/wdis.md             # /wdis 슬래시 커맨드 (UserPromptExpansion 미지원 버전용 폴백)
scripts/wdis.mjs             # /wdis 진입점 — --expand / --list 모드 분기, 시간 포맷, 세션 탐색
scripts/parser.mjs           # jsonl 역방향 스캔 + 필터 + 텍스트 정규화
scripts/*.test.mjs           # node --test
scripts/fixtures/*.jsonl     # 실제 라인을 축소한 픽스처
```

역할 경계:

- **띠(mod)와 조회(scripts)는 데이터를 공유하지 않는다.** 띠는 `prompt.submit` 이벤트로 받은 원문을 직접 기록하고, 조회는 transcript jsonl을 파싱한다. 그래서 필터·정규화·시간 표기가 서로 다르다(§5).
- `parser.mjs` — 파일을 끝에서부터 읽어 "사용자 요청" 후보를 판정하고 `{ timestamp, text }` 배열을 돌려준다. 시간 표시·터미널 출력을 알지 못한다.
- `wdis.mjs` — 실행 모드 판정, stdin 파싱, 세션 파일 탐색, 상대시간·로컬시간 포맷, stdout 출력. 진입점이므로
  `import.meta.url === pathToFileURL(process.argv[1]).href` 가드 뒤에서만 main을 실행한다.

### 2.1 띠 박스 — mod (`hooks/register.tsx`)

**상태** — `atom({ plugin: 'what-did-i-say', key: 'last' })` 하나. 값은 `{ text, at } | null`(`at` = epoch ms). 계약은 `types/index.d.ts`.

**이벤트**

| 이벤트 | 처리 |
|---|---|
| `prompt.submit` | `e.origin.kind`가 `composer`·`bridge`·`sdk`(사람이 직접 입력)이고 공백이 아닌 요청만 대상. 시각(`$.clock.now()`)을 먼저 잡고 `next(e)`를 부른 뒤, 아래 체인이 막지 않았으면(`r.drop === undefined`) `{ text: clip(e.text), at }`로 덮어쓴다. 프롬프트 내용은 바꾸지 않는다 |
| `session.compact` | `next(e)` 결과가 거부(`r.skip`)가 아니고, 메인 대화(`e.agentId` 없음)이며, `trigger`가 `manual`(`/compact`) 또는 `plugin`일 때만 상태를 `null`로 비운다. `auto`(답변 도중 자동 compact — 진행 중 요청이 지워진다)·`precompute`(아무것도 설치하지 않음)·서브에이전트 compact·거부된 compact는 그대로 둔다 |
| `turn.step`·`turn.complete` | 서브에이전트 것(`e.agentId` 있음)이면 `$.ui.invalidate('ui.render')`로 띠를 다시 그려 에이전트 목록을 새로 읽게 한다 (`agent.list`는 그리기 구독 대상이 아니라서) |
| `ui.render` (`component: 'PromptHint'`) | 아래 조건에서만 그리고, 그 밖에는 `next(e)`로 넘긴다 |

**렌더 조건** — `surface`가 `terminal` 또는 `desktop`이고, `props.isWorking`(답변 중)이 거짓이고, `e.viewport.columns`(폭)가 있고, 상태가 `null`이 아니고, `$.agent.list()`에 `pending`·`running`·`waiting` 에이전트가 없을 때(목록을 못 읽으면 없는 것으로 본다). `props.isDraft`(글자 치는 중)에는 숨기지 않는다.

**렌더 구조** — 박스를 위에 두고 `next(e)`가 그린 트리(다른 플러그인 띠·엔진 힌트 줄)를 그 아래에 둔다. 입력창 위(AbovePrompt)에 두면 `/` 명령 목록이 띠 위로 밀려 뜬다.

| 항목 | 값 |
|---|---|
| 박스 | `backgroundColor #2b2b2b` · `marginX 1` · `paddingX 2` · `width = max(1, viewport.columns - 2)` — cache-necromancer 띠와 같은 규격이라 위아래로 붙으면 한 사각형이 된다 |
| 1줄 | 요청 시각, 색 `#9a9a9a`, **KST 고정** `YYYY-MM-DD (요일) HH:MM` (요일 한글) |
| 2줄~ | 요청 원문, 색 `#e6e6e6` |

**자르기(`clip`)** — 저장 시점에 한 번. 앞뒤 공백 제거 → 줄바꿈 유지 → **최대 5줄(빈 줄 포함)·400 code points**, 어느 쪽이든 넘치면 끝에 `…`.

### 2.2 `/wdis N` 조회

경로가 둘이다. **1순위는 `UserPromptExpansion` 훅**이며 LLM 턴·컨텍스트를 전혀 쓰지 않는다(턴 0). 훅을 지원하지 않는 구버전에서만 `commands/wdis.md` 폴백으로 내려간다.

**1순위 — `UserPromptExpansion` 훅 (턴 0)**

1. 사용자가 `/wdis N`을 입력하면 슬래시 커맨드가 전개되기 전에 훅이 `wdis.mjs --expand`를 실행하고 stdin으로 payload를 넘긴다: `command_name` · `command_args` · `prompt` · `session_id` · `transcript_path` · `cwd`.
2. **라우팅** — `command_name`이 `wdis` 또는 `what-did-i-say:wdis`(앞의 `/` 유무 무관)일 때만 처리한다. `command_name`이 없으면 `prompt`의 첫 토큰이 `/wdis`·`/what-did-i-say:wdis`인 경우만 처리한다. **그 외에는 아무것도 출력하지 않고 exit 0** — 다른 플러그인의 커맨드를 막지 않기 위한 필수 조건이다.
3. `N`은 `command_args` 우선, 없으면 `prompt`에서 커맨드 토큰을 뗀 첫 토큰을 쓴다(보정 규칙은 §4·§5).
4. transcript는 stdin `transcript_path`(실존할 때) → stdin `session_id` → §2.3 체인 순으로 정한다. `cwd`도 stdin 값을 우선한다.
5. stdout에 `{"decision":"block","reason":"<목록>"}` **한 줄**을 쓰고 exit 0. Claude Code가 프롬프트를 차단하고 `reason`을 터미널에 직접 표시한다 — LLM 호출이 발생하지 않는다.
6. 조회 실패(세션 파일 없음 등)도 §7의 안내 문구를 `reason`에 담아 block으로 돌려준다. **단, 우리 커맨드로 라우팅이 확정된 뒤에만** 그렇게 한다. 라우팅 이전 실패(stdin 손상 등)는 무출력 exit 0이다.

**폴백 — `commands/wdis.md` (LLM 턴 소비)**

1. 훅이 가로채지 못했을 때만 `commands/wdis.md`가 로드되고, 본문의 `` !`...` `` **dynamic context injection**이 `node "${CLAUDE_PLUGIN_ROOT}/scripts/wdis.mjs" --list "$0" ...` 을 **먼저 실행**해 그 stdout을 프롬프트에 주입한다.
2. `wdis.mjs`가 현재 세션 jsonl(§2.3)을 찾아 최근 N건을 수집해 여러 줄로 출력한다. `N` 생략 시 1. 인자 없이 실행해도 `--list 1`과 같다.
3. Claude는 주입된 출력의 **행 수·순서·내용을 유지해**(의미적 동일성) 사용자에게 표시한다. frontmatter `allowed-tools`로 추가 조회·재가공을 막는다.

### 2.3 세션 식별 (list·expand 모드)

expand 모드는 stdin에 실존하는 `transcript_path`가 오면 그것을 그대로 쓰고, 없을 때만 아래 체인으로 내려간다. list 모드는 항상 아래 **우선순위**로 현재 세션 파일을 정한다.

1. **세션 ID 인자** — list는 `commands/wdis.md`가 넘기는 `--session-id "${CLAUDE_SESSION_ID}"`, expand는 stdin `session_id`. `~/.claude/projects/<슬러그>/<session-id>.jsonl`을 직접 지정하므로 현재 세션이 정확히 선택된다.
2. **환경변수 `CLAUDE_CODE_SESSION_ID`.** 1이 비어 있을 때만 사용한다.
3. **mtime 최신 파일 — 최후 fallback.** 1·2가 모두 없을 때만 슬러그 디렉터리의 `*.jsonl` 중 mtime이 가장 최신인 파일을 쓴다. **이 경로는 현재 세션을 보장하지 않는다**(§9-1).

슬러그 규칙: `cwd`의 비영숫자를 `-`로 치환한다(구현: `cwd.replace(/[^a-zA-Z0-9]/g, '-')`).
`/Users/mini/Github/ai-tools/kaivo` → `-Users-mini-Github-ai-tools-kaivo`

디렉터리 또는 파일이 없으면 §7의 안내 문구를 출력한다.

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
export const MAX_LIMIT = 10;                  // /wdis N 상한
export const MAX_SCAN_BYTES = 10 * 1024 * 1024; // 총 스캔 바이트 상한 (10MiB)

export function collectRecent(filePath, limit, { chunkSize = 65536, maxBytes = MAX_SCAN_BYTES } = {})
                                            // → [{ timestamp, text }] 오름차순
export function extractRequest(line)        // → { timestamp, text } | null
export function normalizeText(raw)          // → string (공백 collapse + trim + 절단)
```

절차:

1. `fs.openSync` + `fstatSync`로 파일 크기를 구한다. `limit`은 호출 전에 **1~`MAX_LIMIT`(10)** 으로 보정한다.
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

**`/wdis` 자기 제외** — `--list`·`--expand` 모드 모두 `/wdis` 커맨드 자신을 결과에서 제외한다. §4.3의 1번 규칙으로 환원한 결과의 **커맨드 토큰이 정확히 `/wdis` 또는 `/what-did-i-say:wdis`인 경우**(커맨드명 뒤가 문자열 끝이거나 공백일 때)만 건너뛰고, **부족한 건수만큼 더 과거로 역스캔을 이어간다**. `/wdis-help`처럼 이름이 이어지는 다른 커맨드는 제외 대상이 아니다.

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

### 5.1 띠 박스

```
  2026-10-07 (수) 14:32
  파서 필터 규칙 정리해줘
```

- 시각은 **KST 고정**·한글 요일이다(§2.1). 상대시간은 표시하지 않는다.
- 요청은 원문 그대로(줄바꿈 유지), 최대 5줄·400 code points.

### 5.2 `/wdis N`

시간은 ISO UTC를 파싱해 **시스템 로컬 타임존**으로 표시한다. 상대시간 기준:

| 경과 | 표기 |
|---|---|
| 60초 미만 | `방금` |
| 60분 미만 | `N분 전` |
| 24시간 미만 | `N시간 전` |
| 그 이상 | `N일 전` |

시간 오름차순, 인덱스는 "몇 번째 이전 요청"을 뜻하므로 `[1]`이 가장 최근이다. 각 요청은 §4.3으로 한 줄·80 code points로 정규화된다.

```
[3] 14:20 (25분 전) | 훅 등록 형식 확인해줘
[2] 14:32 (12분 전) | 파서 필터 규칙 정리해줘
[1] 14:44 (방금) | 테스트 케이스 추가해줘
```

요청 시각이 오늘이 아니면 날짜를 덧붙인다.

```
[3] 08-08 23:10 (15시간 전) | 슬러그 규칙 실측해줘
```

`N`이 숫자가 아니거나 1 미만이면 1건, 10을 초과하면 10건으로 보정하고 사유를 한 줄 안내한다.

## 6. 커맨드·훅·mod 등록

`.claude-plugin/plugin.json` — 메타데이터와 mod 상태 계약 경로만 담는다.

```json
{
  "$schema": "https://json.schemastore.org/claude-code-plugin-manifest.json",
  "name": "what-did-i-say",
  "version": "0.3.2",
  "description": "답변이 끝나면 입력창 아래 띠에 방금 요청한 내용과 시각을 박스로 보여주고, /wdis 로 최근 요청을 조회",
  "author": { "name": "brody424" },
  "license": "MIT",
  "keywords": ["hooks", "prompt-history", "productivity"],
  "types": "./types/index.d.ts"
}
```

`hooks/hooks.json` — settings 훅(`hooks`)과 mod 모듈(`modules`)을 한 파일에 둔다. `claude plugin validate`가 공존을 받아들인다.

```json
{
  "hooks": {
    "UserPromptExpansion": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/wdis.mjs\" --expand",
            "timeout": 10
          }
        ]
      }
    ]
  },
  "modules": ["./register.tsx"]
}
```

- `UserPromptExpansion`은 **모든 슬래시 커맨드**에 대해 호출된다. 우리 커맨드가 아닐 때 무언가를 출력하면 남의 커맨드를 막게 되므로, 라우팅에 걸리지 않으면 반드시 무출력으로 끝낸다(§2.2-2).
- `modules`를 모르는 구버전은 이 키를 오류 없이 무시하고 `UserPromptExpansion` 훅만 로드한다.

**요구 Claude Code 버전** (2026-10-07 격리 설정 `CLAUDE_CONFIG_DIR` 실측)

| 버전 | 띠 박스 | `/wdis` |
|---|---|---|
| v2.1.286 이상 | 동작 (v2.1.287·290·291·292에서 `claude plugin test` 통과) | 동작 |
| v2.1.242~v2.1.285 | mods가 서버 롤아웃 플래그 뒤에 있어 환경에 따라 다름 (플래그 켜진 환경은 미실측) | 동작 |
| v2.1.200~v2.1.241 | 없음 (`modules` 무시) | 동작 |
| v2.1.200 미만 | 미확인 | 미확인 |

`commands/wdis.md` — 훅 미지원 버전용 폴백이다. **`allowed-tools` 제한 + dynamic context injection**으로 실행 결과를 사전 주입한다. 커맨드 인자 중 **첫 번째는 `$0`** 이다(`$1`이 아니다).

```markdown
---
description: 최근 요청한 내용을 시각과 함께 최대 N건 표시합니다 (기본 1건, 최대 10건)
argument-hint: "[N]"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/wdis.mjs" --list "$0" --session-id "${CLAUDE_SESSION_ID}"`

위 실행 결과가 이 프롬프트에 이미 주입되어 있습니다.
주입된 출력의 **행 수·순서·내용을 유지해** 사용자에게 표시하세요. 요약·재정렬·해설·추가 조회를 하지 마세요.
```

- **보장 명령은 `/what-did-i-say:wdis`** 이며, bare `/wdis`는 같은 이름의 커맨드가 없을 때만 동작하는 단축 호출이다.

## 7. 에러 처리

원칙은 **사용자 턴과 다른 플러그인을 절대 방해하지 않는 것**이다.

| 경로 | 상황 | 처리 |
|---|---|---|
| 띠 mod | 저장된 요청 없음·답변 중·에이전트 실행 중·폭 모름·지원 외 surface | `next(e)`로 엔진 기본에 넘긴다(아무것도 그리지 않음) |
| `--expand` | 우리 커맨드가 아님 · 라우팅 이전 실패(stdin 손상 등) | 무출력 exit 0 |
| `--expand` | 라우팅 확정 후 조회 실패 | 안내 문구를 `reason`에 담아 block |
| `--list` | 세션 파일 없음·채택 0건·예외 | 사람이 읽을 안내 한 줄, exit 0. stdout이 죽었어도(EPIPE) exit 0 |

내부 함수는 예외를 그대로 올리고, 삼키는 지점은 각 모드의 최상위 catch뿐이다.

## 8. 테스트 전략

| 대상 | 명령 | 범위 |
|---|---|---|
| `/wdis` 스크립트 | `node --test` | 파서·필터·정규화·시간 포맷·N 보정·세션 탐색·`--expand` 라우팅 |
| 띠 mod | `claude plugin test .` | 렌더 조건·박스 규격·자르기·origin 필터·drop·compact 비움/유지·에이전트 숨김 (terminal·desktop) |
| 매니페스트 | `claude plugin validate .` | plugin.json·hooks.json·mod 모듈 |

통과 수는 README "개발" 절이 기록한다. 픽스처는 실제 jsonl 라인을 축소한 `scripts/fixtures/*.jsonl`을 쓴다.
커버리지(`node --test --experimental-test-coverage`, 70% 이상)는 게이트가 아니라 참고 목표다.

파서 주요 케이스:

| # | 케이스 | 기대 |
|---|---|---|
| 1 | 문자열 content | 텍스트 그대로 채택 |
| 2 | 배열 content (text 항목) | text만 이어붙여 채택 |
| 3 | `<command-name>` 래퍼 | `/커맨드 인자` 한 줄로 환원 |
| 4 | `isSidechain: true` | 제외 |
| 5 | 배열 content에 `tool_result` 포함 | 제외 |
| 6 | `<system-reminder>` 혼합 | 태그 블록 제거 후 사용자 텍스트만 채택 |
| 7 | 80 code points 초과 | `Array.from(결과).length === 80` (79 + `…`), surrogate pair 미파손 |
| 8 | 다중 줄 입력 | `"첫 줄\r\n\n  둘째 줄\t셋째 "` → `"첫 줄 둘째 줄 셋째"` |
| 9 | 최신 라인의 `timestamp` 누락·파싱 불가 | 그 라인은 skip하고 **직전 정상 요청**으로 fallback |
| 10 | 역방향 스캔 N건 중단 | 픽스처가 20건이어도 `limit=3`이면 3건, 시간 오름차순 (`chunkSize`를 작게 줘 한글이 청크 경계에 걸치게 한다) |
| 11 | `limit` 초과값 clamp | `--list 500` → 10건으로 보정하고 보정 안내 1줄 포함 |
| 12 | `maxBytes` 도달 | 예외 없이 그때까지 수집한 분량만 반환 |
| 13 | 자기 제외 | 최신 라인이 `/wdis 3`이면 건너뛰고 그 이전 요청부터 채운다 (`--list`·`--expand` 모두) |
| 14 | 자기 제외 경계(음성) | `/wdis-help 1`은 제외하지 **않는다** |
| 15 | 빈 파일 | 빈 배열 |
| 16 | 주입 턴(§4.3-4b) | `<teammate-message>`·`<task-notification>`·`<cross-session-message>` 포함 라인 제외 |
| 17 | 커맨드 출력 래퍼(§4.3-2·3) | `<local-command-stdout>`·`<local-command-caveat>` 라인 제외 |
| 18 | 빈 content | 빈 문자열·공백만 있는 content는 제외 |

## 9. 알려진 한계

1. **같은 프로젝트 병렬 세션 — mtime fallback 경로에서만 해당.** 세션 ID를 얻으면 정확히 지정되지만, §2.3-3으로 내려간 경우 동일 cwd의 다른 세션 요청을 표시할 수 있다. 띠 mod는 세션 안의 이벤트만 쓰므로 해당하지 않는다.
2. **jsonl 스키마 의존(`/wdis`)** — Claude Code 내부 포맷이므로 상위 버전에서 필드명이 바뀔 수 있다.
3. **띠는 로드 이후 요청만** — 띠 상태는 세션 메모리의 atom이라, 이 세션에서 플러그인이 로드되기 전 요청은 보여주지 않는다. 이전 요청은 `/wdis`로 조회한다.
4. **띠 공유** — 입력창 아래 띠를 쓰는 다른 플러그인이 있으면 함께 쌓이며, 이 플러그인은 항상 그 위에 둔다(엔진 힌트 줄은 맨 아래).
5. **두 경로의 표기 차이** — 띠는 KST 고정·원문 5줄, `/wdis`는 로컬 타임존·한 줄 80자다(§5).
6. **스캔 상한(`/wdis`)** — `N` 상한 **10**, 총 스캔 바이트 상한 **10MiB**. 도달하면 그때까지 수집한 분량만 반환해 세션 초반 요청까지 거슬러 올라가지 못할 수 있다.

## 10. Codex 지원 — 범위 외

> 비규범 기록. 착수 시 재실측 후 별도 문서로 확정한다.

띠는 Claude Code mods에, `/wdis`는 Claude Code transcript 포맷에 의존하므로 Codex에는 그대로 옮길 수 없다.
2026-08-09 조사 당시 관찰: Codex `notify`는 단일 슬롯이며 하위 프로세스 stdout이 버려져 재표시에 쓸 수 없었고,
`~/.codex/hooks.json` Stop 엔트리와 `rollout-*.jsonl` 추출기 조합이 유력해 보였다.

## 11. 이력

- **0.1.0~0.2.0 (2026-08-09)** — 턴 끝 **Stop 훅**이 `wdis.mjs`(인자 없음, hook 모드)를 실행해 transcript를 역스캔하고
  `{"systemMessage":"🗣 14:32 (12분 전) | 요청"}` 한 줄을 출력했다. 요청은 §4.3으로 한 줄·80자 정규화, 실패는 무출력 exit 0.
  0.2.0에서 `/wdis`를 `UserPromptExpansion` 훅으로 턴 0 처리하게 바꿨다.
- **0.3.0 (2026-10-07)** — Stop 훅과 hook 모드를 삭제하고 프롬프트 위 띠 박스(mod)로 대체했다. `/wdis` 경로는 그대로.
- **0.3.1 (2026-10-07)** — `/compact`(manual·plugin) 직후 띠를 비운다.
- **0.3.2 (2026-10-08)** — 띠를 입력창 위(AbovePrompt)에서 아래 힌트 줄 자리(PromptHint)로 옮겼다(`/` 명령 목록이 띠 위로 밀리던 문제). 백그라운드 에이전트가 도는 동안 숨기고, 설문 판정은 뺐다(설문은 입력창 위라 겹치지 않음).
