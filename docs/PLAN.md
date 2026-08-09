# what-did-i-say — PLAN

> 작성 2026-08-09 · 선행 문서: [PRD.md](./PRD.md)(무엇을 만드는가) · [TECH_SPEC.md](./TECH_SPEC.md)(어떻게 구현하는가)
> 이 문서는 **언제·어떤 순서로** 진행할지만 다룬다.

## 1. 개요

Claude Code 턴 종료 시(Stop hook) "방금 사용자 요청 + 요청 시간"을 `systemMessage` 한 줄로 재표시하고, `/what-did-i-say:wdis N`(단축 `/wdis N`)으로 최근 N건을 조회하는 플러그인. 무상태(현재 세션 jsonl 역방향 스캔), 외부 의존성 제로 Node 18.17+(`.mjs`), 테스트는 `node --test`. MVP 범위는 Claude Code 전용이다.

구성 파일 (총 7개):

| 파일 | 역할 |
|---|---|
| `.claude-plugin/plugin.json` | 매니페스트 (메타데이터만) |
| `hooks/hooks.json` | Stop hook 등록 |
| `commands/wdis.md` | 슬래시 커맨드 정의 |
| `scripts/wdis.mjs` | 진입점 (hook 모드 / `--list` 모드) |
| `scripts/parser.mjs` | jsonl 역방향 스캔 + 노이즈 필터 (핵심 로직) |
| `scripts/parser.test.mjs` | 파서 단위 테스트 |
| `scripts/fixtures/*.jsonl` | 테스트용 jsonl 샘플 |

## 2. 커밋 단위 분해

기준: **커밋 1개 = 프로덕션 코드 300줄 이하** (테스트 코드는 별도 계산). 전체 5개 커밋, PR 1개.

### 커밋 1 — `chore: 플러그인 스캐폴드`

- 산출: `.claude-plugin/plugin.json`(매니페스트만, hooks 필드 없음), `scripts/`·`commands/` 디렉터리 골격, `README.md` 최소본(한 줄 정의 + WIP 표기), `.gitignore`
- 완료 기준:
  1. `claude plugin validate . --strict` 통과
  2. `claude --plugin-dir /Users/mini/Github/ai-tools/what-did-i-say` 세션에서 `/help`(또는 `/plugin`)에 `wdis` 커맨드가 노출된다
- 참고: 레이아웃은 `../hook-raider/`를 따른다.

### 커밋 2 — `feat: jsonl 파서·필터`

- 산출: `scripts/parser.mjs`, `scripts/parser.test.mjs`, `scripts/fixtures/*.jsonl`
- 순서: fixtures → 테스트 → 구현 (TDD, Red→Green→Refactor)
- 필터 대상 케이스는 fixtures로 고정한다: 순수 사용자 프롬프트 / 슬래시 커맨드 래퍼(`<command-name>`, `<local-command-stdout>`) / hook 주입 컨텍스트 / `tool_result` / 빈 content.
- 엣지 케이스: 파일 없음, 빈 파일, 손상된 JSON 라인, **`timestamp` 누락·파싱 불가 라인(그 라인만 skip하고 직전 정상 요청으로 fallback)**, 사용자 프롬프트가 0건, 요청 N이 실제 건수보다 큰 경우, **N이 상한 10을 초과하는 경우(10으로 보정)**, **스캔 바이트가 10MiB 상한에 도달하는 경우**.
- 완료 기준: `node --test` **전체 통과** (통과 수를 "N/N 통과"로 보고). 커버리지는 참고 목표일 뿐 게이트가 아니다. 이 커밋 시점에는 아직 hook에 연결하지 않으므로 실 세션 동작 변화가 없다.

### 커밋 3 — `feat: Stop hook 출력`

- 산출: `scripts/wdis.mjs`(hook 모드 — stdin JSON에서 `transcript_path` 수신 → parser 호출 → `{"systemMessage":"..."}` JSON 1개 출력), `hooks/hooks.json`에 Stop 엔트리 추가
- 완료 기준:
  1. `node --test` 통과 유지
  2. 수동 E2E: `claude --plugin-dir <repo>` 로 새 세션 기동 → 아무 프롬프트나 1회 입력 → 턴 종료 시 요청문+시간 한 줄이 사용자에게 표시됨
  3. **`systemMessage` 렌더 실측** — 실제 화면에 어떻게 표시되는지, 호스트가 prefix(`Stop says:` 등)를 덧붙이는지 육안 확인하고 그 결과로 최종 출력 포맷을 확정한다. 확정 결과를 커밋 3 메시지에 기록한다
  4. 실패 안전: 손상된 transcript_path를 넘겨도 hook이 exit 0으로 종료하고 세션을 방해하지 않음 (`echo '{"transcript_path":"/nonexistent"}' | node scripts/wdis.mjs` → 종료 코드 0, 출력 없음)
- 주의: 현재 하네스 `Stop` 슬롯에 orca `claude-hook.sh`가 이미 등록돼 있다. 병합 동작이므로 공존은 되지만 **출력 섞임을 이 커밋에서 실측**한다 (§3 체크리스트).

### 커밋 4 — `feat: /wdis 커맨드`

- 산출: `commands/wdis.md`(`allowed-tools` 제한 + `` !`...` `` dynamic context injection 구조), `scripts/wdis.mjs`에 `--list N` 모드 추가
- 인자 규칙: **커맨드 인자의 첫 번째는 `$0`** 이다(`$1` 아님). `/wdis` = 기본 1건, `/wdis N` = 최근 N건. N이 숫자가 아니거나 0 이하면 기본값으로 처리하고 사유를 한 줄 안내하며, **10을 초과하면 10으로 보정**하고 보정 사실을 한 줄 안내한다. 세션 지정은 `--session-id "${CLAUDE_SESSION_ID}"`로 전달한다.
- 완료 기준:
  1. `node --test` 통과 유지
  2. 수동 E2E: 실 세션에서 `/wdis 3` 입력 → 최근 3건이 시간 오름차순(가장 최근이 마지막 줄)으로 출력됨. 건수가 3 미만인 세션에서도 있는 만큼만 정상 출력.
  3. 수동 E2E: 결과에 **`/wdis` 자신이 포함되지 않고**, `/wdis` 실행 직전의 일반 프롬프트가 반환된다.
  4. 표시 충실도는 **의미적 동일성**으로 판정한다 — 주입된 출력의 행 수·순서·내용이 그대로 유지되면 통과(요약·재정렬·해설 추가는 불합격).

### 커밋 5 — `docs: README 완성`

- 산출: `README.md`(설치 방법, 사용법, 출력 예시, 알려진 한계), 필요 시 `CLAUDE.md`
- 알려진 한계에 명시할 항목: 현재 세션 한정(이전 세션 미조회) / Claude Code 전용(Codex 미지원) / Stop 슬롯을 다른 훅과 공유할 때의 출력 순서는 보장되지 않음.
- 완료 기준: README의 설치 절차를 그대로 따라 했을 때 처음부터 동작한다 (직접 재현 1회).

## 3. 검증 계획

### 로컬 설치 (마켓플레이스 등록 전)

1. `claude plugin validate . --strict` — 매니페스트·hooks·커맨드 정의의 정합성을 먼저 정적 검증한다.
2. `claude --plugin-dir <절대경로>` — CLI에 실존하는 옵션이며(`--plugin-dir <path>`: 디렉터리 또는 .zip을 해당 세션에만 로드, 반복 지정 가능) 세션 한정이라 전역 설정을 오염시키지 않는다. 로드 확인은 세션 안에서 `/help`(또는 `/plugin`)에 `wdis` 커맨드가 노출되는지로 판정한다.

대안(플러그인 사이드 이펙트를 여러 세션에 걸쳐 봐야 할 때): `claude plugin marketplace add <로컬 경로>` 후 `claude plugin install`. MVP 검증에는 불필요하므로 필요해질 때 확인한다.

### 실측 체크리스트

| # | 항목 | 판정 |
|---|---|---|
| 1 | 파서 단위 테스트 | `node --test` N/N 통과 |
| 2 | Stop hook 표시 | 새 세션에서 턴 종료 시 요청문+시간 한 줄 표시 |
| 3 | **`systemMessage` 렌더 실측** | stdout JSON이 실제 화면에 어떻게 렌더되는지, 호스트 prefix(`Stop says:` 등)가 붙는지 확인 → 최종 포맷 확정 후 커밋 3 메시지에 기록 |
| 4 | **orca `claude-hook.sh`와 Stop 슬롯 공존** | 두 훅이 함께 등록된 상태로 1회 턴 종료 → 출력이 섞이거나 잘리지 않는지 육안 확인. 섞이면 출력 형식을 조정하고 결과를 커밋 3 메시지에 기록 |
| 5 | 실패 안전 | 존재하지 않는 transcript 경로 → exit 0, 출력 없음 |
| 6 | `/wdis N` 조회 | 3건 요청 → 오름차순 3건, `/wdis` 자신 미포함, 건수 부족 시 있는 만큼 |
| 7 | README 재현 | 문서만 보고 설치·실행 성공 |

체크리스트 3·4번은 이 플러그인 고유의 위험 요소이므로 **최소 1회는 반드시 실세션에서 수행**한다.

## 4. 마일스톤

| 마일스톤 | 포함 커밋 | 종료 조건 |
|---|---|---|
| **M1 — 파서 검증** | 커밋 1~2 | 플러그인이 인식되고, 파서 테스트 N/N 통과. 실 세션 동작 변화 없음 |
| **M2 — E2E 동작** | 커밋 3~4 | Stop hook 한 줄 표시 + `/wdis N` 조회가 실 세션에서 동작. 체크리스트 1~6 전부 통과 |
| **M3 — 배포** | 커밋 5 + 등록 | README 완성, `../plugins/`(token-keeper 마켓플레이스)에 git submodule로 등록 |

M3의 submodule 등록은 원격 repo 생성이 선행돼야 하며(`.gitmodules`가 `https://github.com/token-keeper/<name>.git` 형식), **대표 승인 후 실행**한다.

## 5. 2단계 — 범위 외 예고

> 2026-08-09 조사 기록(비규범) — 2단계 착수 시 재실측 후 확정한다.

MVP 이후 후보. 이번 PR에서는 구현하지 않는다.

- **Codex 네이티브 지원** — `~/.codex/hooks.json`에 Stop 엔트리를 추가하고, `rollout-*.jsonl` 포맷용 파서를 확장한다. `config.toml`의 `notify` 단일 슬롯과 무관하므로 oh-my-codex와 충돌하지 않는다.
- notify 체이닝 방식은 **탈락**했다 — 조사 결과 notify 경로는 stdout이 폐기되어 터미널 재표시가 불가능하다.
- 이전 세션 조회, statusline 출력은 실사용 피드백을 본 뒤 판단한다.

## 6. 리스크·롤백

| 리스크 | 대응 |
|---|---|
| Stop hook 실패가 세션을 방해 | **exit 0 원칙** — 파싱 실패·파일 없음·JSON 손상 전부 조용히 빈 출력으로 종료. 훅에서 예외를 밖으로 던지지 않는다 (체크리스트 4) |
| orca 훅과 출력 충돌 | 커밋 3에서 실측 후 형식 조정. 해결 안 되면 출력 위치 변경을 대표에게 보고하고 판단을 요청 |
| jsonl 대용량(수백 MB) | 역방향 스캔으로 필요한 만큼만 읽고, 전체 로드는 금지한다(TECH_SPEC의 청크 읽기 방식). 추가로 **N 상한 10**(초과 입력은 10으로 보정 + 한 줄 안내)과 **총 스캔 바이트 상한 10MiB**(도달 시 그때까지 수집분만 반환)로 최악 케이스 비용을 고정한다 |
| 롤백 | 무상태 설계라 남는 데이터가 없다. **플러그인 제거(`--plugin-dir` 미지정 또는 `claude plugin uninstall`)만으로 완전 원복** |
