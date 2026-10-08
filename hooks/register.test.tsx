import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentInfo, AgentStatus, On, PromptOrigin, SessionCompactInput, SessionMessage } from 'claude-code'

const PLUGIN = 'what-did-i-say'
const SURFACES = ['terminal', 'desktop'] as const
// 2026-10-06T15:12:00Z = KST 2026-10-07 (수) 00:12 — UTC로 포맷하면 날짜·요일이 틀린다
const AT = Date.UTC(2026, 9, 6, 15, 12)

// columns: 터미널 폭(e.viewport.columns), null 이면 viewport 없이 그린다
type BandOver = { isWorking?: boolean; isDraft?: boolean; columns?: number | null }

// 엔진 자리: 'BLOCK'으로 시작하는 프롬프트는 막고(drop), 힌트 줄은 'engine' 텍스트를 그리고, 에이전트 목록은 돌려준 배열을 따른다
function setup(on: On): { agents: AgentInfo[] } {
  const w = { agents: [] as AgentInfo[] }
  mock.clock(on, { now: AT })
  on('agent.list', () => ({ value: w.agents }))
  on('prompt.submit', (_$, e) => (e.text.startsWith('BLOCK') ? { drop: 'blocked' } : { text: e.text }))
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  return w
}

const submit = ($: Engine, text: string, origin: PromptOrigin = { kind: 'composer' }) =>
  $.prompt.submit({ text, wait: false, origin })

const mount = ($: Engine, surface: (typeof SURFACES)[number], over: BandOver = {}) => {
  const { columns = 80, isWorking = false, isDraft = false } = over
  return $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: 'PromptHint',
    props: { isDraft, isWorking, hint: '? for shortcuts' },
    ...(columns === null ? {} : { viewport: { columns, rows: 24 } }),
  })
}

type Drawing = Awaited<ReturnType<typeof mount>>

// 패널은 Box로만 그려지고, 엔진 자리(setup)는 Text 하나라서 Box 유무로 패널 여부를 가린다
const hasPanel = async (ui: Drawing) => (await ui.find({ type: 'Box' })) !== undefined
// Text 순서: [0] 날짜 · [1] 요청 · [2] 아래(엔진 자리)
const body = async (ui: Drawing) => (await ui.findAll({ type: 'Text' }))[1]?.text

test('대기 상태면 단색 띠에 KST 날짜·한글 요일과 요청을 그린다', async ($, on) => {
  setup(on)
  await submit($, '서버 배포해줘')
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    const texts = await ui.findAll({ type: 'Text' })
    const [date, req] = texts
    const boxes = await ui.findAll({ type: 'Box' })
    expect(texts).toHaveLength(3)
    expect(boxes).toHaveLength(2)
    expect(boxes[1]?.props).toEqual({ backgroundColor: '#2b2b2b', flexDirection: 'column', marginX: 1, paddingX: 2, width: 78 })
    expect(await ui.find({ type: 'Text', text: /[▗▖▝▘▄▀]/ })).toBeUndefined()
    expect(date).toMatchObject({ text: '2026-10-07 (수) 00:12', props: { color: '#9a9a9a' } })
    expect(date?.props).not.toHaveProperty('dimColor')
    expect(req).toMatchObject({ text: '서버 배포해줘', props: { color: '#e6e6e6' } })
    expect(await ui.find({ type: 'Text', text: '🗣' })).toBeUndefined()
    await ui.unmount()
  }
})

test('아래(엔진 힌트 줄·다른 플러그인)가 그린 트리는 패널 밑에 둔다', async ($, on) => {
  setup(on)
  await submit($, '서버 배포해줘')
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await ui.drawn()).toMatchObject({
      type: 'Box',
      props: { flexDirection: 'column' },
      children: [{ type: 'Box', props: { marginX: 1, backgroundColor: '#2b2b2b' } }, { type: 'Text', children: ['engine'] }],
    })
    await ui.unmount()
  }
})

test('패널 폭은 터미널 폭 - 2 이고 여백 포함 폭을 넘지 않는다 (좁은 폭 포함)', async ($, on) => {
  setup(on)
  await submit($, '서버 배포해줘')
  for (const surface of SURFACES) {
    for (const [cols, expected] of [[80, 78], [15, 13], [3, 1]] as const) {
      const ui = await mount($, surface, { columns: cols })
      const width = (await ui.findAll({ type: 'Box' }))[1]?.props['width']
      expect(width).toBe(expected)
      expect(expected + 2 <= cols).toBe(true)
      await ui.unmount()
    }
  }
})

test('답변 중이면 엔진 기본(next)으로 넘긴다', async ($, on) => {
  setup(on)
  await submit($, '서버 배포해줘')
  for (const surface of SURFACES) {
    const ui = await mount($, surface, { isWorking: true })
    expect(await hasPanel(ui)).toBe(false)
    expect(await ui.find({ type: 'Text', text: '서버 배포해줘' })).toBeUndefined()
    await ui.unmount()
  }
})

test('폭을 모르면(viewport 없음) 엔진 기본(next)으로 넘긴다', async ($, on) => {
  setup(on)
  await submit($, '서버 배포해줘')
  for (const surface of SURFACES) {
    const ui = await mount($, surface, { columns: null })
    expect(await hasPanel(ui)).toBe(false)
    expect(await ui.drawn()).toMatchObject({ type: 'Text', children: ['engine'] })
    await ui.unmount()
  }
})

test('글자 치는 중(isDraft)에도 띠는 그대로 보인다', async ($, on) => {
  setup(on)
  await submit($, '서버 배포해줘')
  for (const surface of SURFACES) {
    const ui = await mount($, surface, { isDraft: true })
    expect(await body(ui)).toBe('서버 배포해줘')
    await ui.unmount()
  }
})

// ── 백그라운드 에이전트가 도는 동안은 숨김 ──
const agent = (status: AgentStatus): AgentInfo => ({ id: `a-${status}`, description: 'lane', type: 'general-purpose', status })

// 엔진 자리: 서브에이전트 요청은 빈 응답, 턴 끝은 답을 그대로 돌려준다
function agentEngine(on: On) {
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  on('turn.complete', (_$, e) => ({ text: e.answer }))
}

async function agentStep($: Engine) {
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'm', messageCount: 1, agentId: 'agent-1' })) {
    // 청크 없음
  }
}

const agentDone = ($: Engine) =>
  $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', agentId: 'agent-1', reason: 'answer' })

for (const status of ['pending', 'running', 'waiting'] as const) {
  test(`백그라운드 에이전트가 ${status} 이면 띠를 숨긴다`, async ($, on) => {
    const w = setup(on)
    w.agents = [agent('idle'), agent(status)]
    await submit($, '서버 배포해줘')
    for (const surface of SURFACES) {
      const ui = await mount($, surface)
      expect(await hasPanel(ui)).toBe(false)
      expect(await ui.drawn()).toMatchObject({ type: 'Text', children: ['engine'] })
      await ui.unmount()
    }
  })
}

test('대기 중 서브에이전트가 돌기 시작하면 숨고, 끝나면 다시 보인다', async ($, on) => {
  const w = setup(on)
  agentEngine(on)
  await submit($, '서버 배포해줘')
  for (const surface of SURFACES) {
    w.agents = [agent('idle'), agent('completed'), agent('failed'), agent('killed')]
    const ui = await mount($, surface)
    expect(await body(ui)).toBe('서버 배포해줘')
    w.agents = [agent('running')]
    await agentStep($)
    expect(await hasPanel(ui)).toBe(false)
    w.agents = [agent('completed')]
    await agentDone($)
    expect(await body(ui)).toBe('서버 배포해줘')
    await ui.unmount()
  }
})

test('에이전트 목록을 못 읽으면 띠를 그대로 보인다', async ($, on) => {
  mock.clock(on, { now: AT })
  on('agent.list', () => {
    throw new Error('boom')
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await submit($, '서버 배포해줘')
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await body(ui)).toBe('서버 배포해줘')
    await ui.unmount()
  }
})

test('저장된 요청이 없거나 공백만 제출되면 그리지 않는다', async ($, on) => {
  setup(on)
  await submit($, '   \n  ')
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await hasPanel(ui)).toBe(false)
    await ui.unmount()
  }
})

test('bridge·sdk 요청은 저장하고 plugin 프롬프트·작업 알림은 덮어쓰지 않는다', async ($, on) => {
  setup(on)
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    await submit($, `bridge ${surface}`, { kind: 'bridge' })
    expect(await body(ui)).toBe(`bridge ${surface}`)
    await submit($, `sdk ${surface}`, { kind: 'sdk' })
    expect(await body(ui)).toBe(`sdk ${surface}`)
    await submit($, 'from plugin', { kind: 'plugin', name: 'other' })
    await submit($, '<task-notification>done</task-notification>', { kind: 'task-notification' })
    expect(await body(ui)).toBe(`sdk ${surface}`)
    await ui.unmount()
  }
})

test('띠가 떠 있는 동안 새 요청이 들어오면 새 요청으로 다시 그린다', async ($, on) => {
  setup(on)
  for (const surface of SURFACES) {
    await submit($, `첫 요청 ${surface}`)
    const ui = await mount($, surface)
    expect(await body(ui)).toBe(`첫 요청 ${surface}`)
    await submit($, `둘째 요청 ${surface}`)
    expect(await body(ui)).toBe(`둘째 요청 ${surface}`)
    await ui.unmount()
  }
})

test('아래에서 막힌(drop) 프롬프트는 저장하지 않는다', async ($, on) => {
  setup(on)
  expect(await submit($, 'BLOCK first')).toEqual({ drop: 'blocked' })
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await hasPanel(ui)).toBe(false)
    await ui.unmount()
  }
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    await submit($, `통과 ${surface}`)
    await submit($, `BLOCK again ${surface}`)
    expect(await body(ui)).toBe(`통과 ${surface}`)
    await ui.unmount()
  }
})

// 엔진 자리 compact: 'SKIP'으로 시작하는 instructions 는 거부(skip)하고, 나머지는 요약 한 줄로 정리한 셈 친다
const SUMMARY: SessionMessage = { role: 'user', text: 'summary', toolUses: [] }
function compactEngine(on: On) {
  on('session.compact', (_$, e) => (e.instructions?.startsWith('SKIP') ? { skip: 'refused' } : { messages: [SUMMARY] }))
}

const compact = ($: Engine, over: Partial<Pick<SessionCompactInput, 'trigger' | 'agentId' | 'instructions'>> = {}) =>
  $.session.compact({ trigger: 'manual', messages: [SUMMARY], ...over })

test('/compact 후에는 띠를 비우고, 다음 요청부터 다시 그린다', async ($, on) => {
  setup(on)
  compactEngine(on)
  for (const surface of SURFACES) {
    await submit($, `정리 전 ${surface}`)
    const ui = await mount($, surface)
    expect(await body(ui)).toBe(`정리 전 ${surface}`)
    expect(await compact($)).toEqual({ messages: [SUMMARY] })
    expect(await hasPanel(ui)).toBe(false)
    await submit($, `정리 후 ${surface}`)
    expect(await body(ui)).toBe(`정리 후 ${surface}`)
    await ui.unmount()
  }
})

test('플러그인이 부른 compact 도 띠를 비운다', async ($, on) => {
  setup(on)
  compactEngine(on)
  await submit($, '서버 배포해줘')
  await compact($, { trigger: 'plugin' })
  for (const surface of SURFACES) {
    const ui = await mount($, surface)
    expect(await hasPanel(ui)).toBe(false)
    await ui.unmount()
  }
})

// 거부된 compact · 서브에이전트 compact · 자동(auto)·사전계산(precompute) compact 는 띠를 그대로 둔다
const keeps: ReadonlyArray<readonly [string, Partial<Pick<SessionCompactInput, 'trigger' | 'agentId' | 'instructions'>>]> = [
  ['skip 으로 거부된 compact', { instructions: 'SKIP please' }],
  ['서브에이전트(agentId) compact', { agentId: 'agent-1' }],
  ['자동(auto) compact', { trigger: 'auto' }],
  ['사전계산(precompute) compact', { trigger: 'precompute' }],
]

for (const [name, over] of keeps) {
  test(`${name}는 띠를 유지한다`, async ($, on) => {
    setup(on)
    compactEngine(on)
    await submit($, '서버 배포해줘')
    await compact($, over)
    for (const surface of SURFACES) {
      const ui = await mount($, surface)
      expect(await body(ui)).toBe('서버 배포해줘')
      await ui.unmount()
    }
  })
}

// 자르기 규칙: 최대 5줄(빈 줄 포함), 줄바꿈 포함 200자(코드포인트), 넘치면 끝에 …
const cases: ReadonlyArray<readonly [string, string, string]> = [
  ['6줄 → 5줄 + …', Array(6).fill('ㄱ'.repeat(50)).join('\n'), `${Array(5).fill('ㄱ'.repeat(50)).join('\n')}…`],
  ['빈 줄도 한 줄로 센다 (6줄 → 5줄 + …)', 'a\n\nb\n\nc\nd', 'a\n\nb\n\nc…'],
  ['450자 한 줄 → 400자 + …', 'ㄴ'.repeat(450), `${'ㄴ'.repeat(400)}…`],
  ['정확히 400자 한 줄 → 그대로', 'ㄷ'.repeat(400), 'ㄷ'.repeat(400)],
  ['정확히 5줄·400자(줄바꿈 포함) → 그대로', ['ㄹ'.repeat(80), 'ㄹ'.repeat(80), 'ㄹ'.repeat(80), 'ㄹ'.repeat(80), 'ㄹ'.repeat(76)].join('\n'), ['ㄹ'.repeat(80), 'ㄹ'.repeat(80), 'ㄹ'.repeat(80), 'ㄹ'.repeat(80), 'ㄹ'.repeat(76)].join('\n')],
  ['CRLF 7줄 → LF 5줄 + …', 'a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng', 'a\nb\nc\nd\ne…'],
  ['400자 경계의 이모지는 반으로 안 잘린다', `${'x'.repeat(399)}😀yy`, `${'x'.repeat(399)}😀…`],
]

for (const [name, input, expected] of cases) {
  test(`자르기: ${name}`, async ($, on) => {
    setup(on)
    await submit($, input)
    for (const surface of SURFACES) {
      const ui = await mount($, surface)
      expect(await body(ui)).toBe(expected)
      await ui.unmount()
    }
  })
}
