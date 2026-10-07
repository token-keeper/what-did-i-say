import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { WhatDidISay } from '../types'

const last = atom({ plugin: 'what-did-i-say', key: 'last' } as const, null as WhatDidISay | null)

const KST_OFFSET_MS = 9 * 60 * 60 * 1000
const DAYS = ['일', '월', '화', '수', '목', '금', '토']
const MAX_LINES = 5
const MAX_CHARS = 400
const PANEL = '#2b2b2b'
// 사람이 직접 친 요청만 기록 (알림·예약·피어·플러그인 프롬프트는 제외)
const USER_ORIGINS = new Set(['composer', 'bridge', 'sdk'])

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

export const register: Register = on => {
  on('prompt.submit', async ($, e, next) => {
    if (e.text.trim() === '' || !USER_ORIGINS.has(e.origin.kind)) return next(e)
    const at = await $.clock.now()
    const r = await next(e)
    if (r.drop === undefined) await update($, last, () => ({ text: clip(e.text), at }))
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)
    if (e.props.isWorking || e.props.hasSurvey) return next(e)

    const said = await read($, last)
    if (said === null) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    // cache-necromancer 띠와 같은 규격(marginX 1·폭 W·paddingX 2)이라 위아래로 붙으면 한 사각형이 된다
    const W = Math.max(1, e.props.bodyColumns - 2)

    const below = await next(e)
    return (
      <Box flexDirection="column">
        {below}
        <Box backgroundColor={PANEL} flexDirection="column" marginX={1} paddingX={2} width={W}>
          <Text color="#9a9a9a">{formatKst(said.at)}</Text>
          <Text color="#e6e6e6">{said.text}</Text>
        </Box>
      </Box>
    )
  })
}
