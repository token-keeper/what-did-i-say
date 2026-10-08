import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { WhatDidISay } from '../types'

const last = atom({ plugin: 'what-did-i-say', key: 'last' } as const, null as WhatDidISay | null)

const KST_OFFSET_MS = 9 * 60 * 60 * 1000
const DAYS = ['일', '월', '화', '수', '목', '금', '토']
const MAX_LINES = 5
const MAX_CHARS = 400
const PANEL = '#2b2b2b'
// 사람이 직접 친 요청만 기록 (알림·예약·피어·플러그인 프롬프트는 제외)
const USER_ORIGINS = new Set(['composer', 'bridge', 'sdk'])
// 띠가 숨는 백그라운드 에이전트 상태 (idle·종료는 사용자 입력을 막지 않으므로 제외). cache-necromancer 띠와 같은 기준
const BUSY_AGENT = new Set(['pending', 'running', 'waiting'])

const pad = (n: number) => String(n).padStart(2, '0')

function formatKst(ms: number): string {
  const d = new Date(ms + KST_OFFSET_MS)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} (${DAYS[d.getUTCDay()]}) ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

function clip(text: string): string {
  const lines = text.trim().split(/\r?\n/)
  const chars = Array.from(lines.slice(0, MAX_LINES).join('\n'))
  const isCut = lines.length > MAX_LINES || chars.length > MAX_CHARS
  const body = chars.slice(0, MAX_CHARS).join('')
  return isCut ? `${body}…` : body
}

// 리더 턴이 끝나도 백그라운드 에이전트가 돌고 있으면 아직 "모든 작업이 끝난" 게 아니다
async function hasBusyAgent($: EngineInterface): Promise<boolean> {
  try {
    return (await $.agent.list()).some(agent => BUSY_AGENT.has(agent.status))
  } catch {
    return false
  }
}

export const register: Register = on => {
  on('prompt.submit', async ($, e, next) => {
    if (e.text.trim() === '' || !USER_ORIGINS.has(e.origin.kind)) return next(e)
    const at = await $.clock.now()
    const r = await next(e)
    if (r.drop === undefined) await update($, last, () => ({ text: clip(e.text), at }))
    return r
  })

  // /compact(또는 플러그인 compact)로 대화가 정리되면 띠도 비운다. 메인 대화만(agentId 없음), 거부된(skip) compact 는 그대로
  // auto(답변 도중 자동 compact — 진행 중 요청이 지워짐)·precompute(아무것도 설치 안 함)는 제외
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (r.skip === undefined && e.agentId === undefined && (e.trigger === 'manual' || e.trigger === 'plugin')) {
      await update($, last, () => null)
    }
    return r
  })

  // 띠는 agent.list 를 atom 처럼 구독할 수 없어 에이전트 시작·끝을 스스로 알지 못한다.
  // 서브에이전트의 요청(turn.step)과 턴 끝(turn.complete)에 다시 그려 agent.list 를 새로 읽게 한다
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) $.ui.invalidate('ui.render')
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) $.ui.invalidate('ui.render')
    return r
  })

  // 입력창 아래 힌트 줄(PromptHint) 자리에 띠. 아래(엔진 힌트 줄·다른 플러그인)가 그린 것은 그 밑에 둔다.
  // 입력창 위(AbovePrompt)에 두면 / 명령 목록이 띠 위로 밀려 뜬다
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)
    // 답변이 끝난 대기 상태에서만 표시 (글자 치는 중에는 그대로 둔다). 폭을 모르면(surface 가 아직 안 잼) 그리지 않는다
    const columns = e.viewport?.columns
    if (e.props.isWorking || columns === undefined) return next(e)

    const said = await read($, last)
    if (said === null || (await hasBusyAgent($))) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    // cache-necromancer 띠와 같은 규격(marginX 1·폭 W·paddingX 2)이라 위아래로 붙으면 한 사각형이 된다
    const W = Math.max(1, columns - 2)

    const below = await next(e)
    return (
      <Box flexDirection="column">
        <Box backgroundColor={PANEL} flexDirection="column" marginX={1} paddingX={2} width={W}>
          <Text color="#9a9a9a">{formatKst(said.at)}</Text>
          <Text color="#e6e6e6">{said.text}</Text>
        </Box>
        {below}
      </Box>
    )
  })
}
