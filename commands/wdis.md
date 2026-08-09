---
description: 최근 요청한 내용을 시각과 함께 최대 N건 표시합니다 (기본 1건, 최대 100건)
argument-hint: "[N]"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/wdis.mjs" --list "$0" --session-id "${CLAUDE_SESSION_ID}"`

위 실행 결과가 이 프롬프트에 이미 주입되어 있습니다.
주입된 출력의 **행 수·순서·내용을 유지해** 사용자에게 표시하세요. 요약·재정렬·해설·추가 조회를 하지 마세요.
