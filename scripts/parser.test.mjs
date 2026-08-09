import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAX_LIMIT, MAX_SCAN_BYTES, collectRecent, extractRequest, normalizeText } from './parser.mjs';

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const userLine = (content, extra = {}) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content }, timestamp: '2026-08-09T00:42:19.745Z', isSidechain: false, ...extra });

test('상수는 스펙값이다', () => {
  assert.equal(MAX_LIMIT, 100);
  assert.equal(MAX_SCAN_BYTES, 10 * 1024 * 1024);
});

// 1
test('문자열 content는 텍스트 그대로 채택한다', () => {
  const got = extractRequest(userLine('@HANDOFF.md 문서 읽고 아이디어 이어나가자'));
  assert.deepEqual(got, { timestamp: '2026-08-09T00:42:19.745Z', text: '@HANDOFF.md 문서 읽고 아이디어 이어나가자' });
});

// 2
test('배열 content는 text 항목만 이어붙여 채택한다', () => {
  const got = extractRequest(userLine([
    { type: 'text', text: '파서 필터 규칙' },
    { type: 'image', source: {} },
    { type: 'text', text: '정리해줘' },
  ]));
  assert.equal(got.text, '파서 필터 규칙 정리해줘');
});

// 3
test('<command-name> 래퍼는 "/커맨드 인자" 한 줄로 환원한다', () => {
  const withArgs = extractRequest(userLine('<command-name>/wdis</command-name>\n<command-message>wdis</command-message>\n<command-args>3</command-args>'));
  assert.equal(withArgs.text, '/wdis 3');

  const noArgs = extractRequest(userLine('<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>'));
  assert.equal(noArgs.text, '/clear');
});

// 3b — 실측: teammate/task-notification 주입 턴은 isMeta 마커가 없다
test('teammate-message·task-notification·cross-session 주입 턴은 제외한다', () => {
  assert.equal(extractRequest(userLine('Another Claude session sent a message:\n<teammate-message teammate_id="impl-b" color="cyan">{"type":"idle_notification"}</teammate-message>')), null);
  assert.equal(extractRequest(userLine('[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>\n<task-id>abc</task-id>\n</task-notification>')), null);
  assert.equal(extractRequest(userLine('<cross-session-message from="worker">check tests</cross-session-message>')), null);
});

// 4
test('isSidechain: true 는 제외한다', () => {
  assert.equal(extractRequest(userLine('서브에이전트 내부 프롬프트', { isSidechain: true })), null);
});

// 5
test('배열 content에 tool_result가 있으면 제외한다', () => {
  const line = userLine([
    { type: 'tool_result', tool_use_id: 'toolu_016o', content: 'Launching skill: brainstorming' },
    { type: 'text', text: '이 텍스트도 함께 버린다' },
  ]);
  assert.equal(extractRequest(line), null);
});

// 6
test('<system-reminder> 블록을 제거하고 남은 사용자 텍스트만 채택한다', () => {
  const mixed = extractRequest(userLine('<system-reminder>Plan mode is active.</system-reminder>훅 등록 형식 확인해줘'));
  assert.equal(mixed.text, '훅 등록 형식 확인해줘');

  assert.equal(extractRequest(userLine('<system-reminder>주입 컨텍스트만 있는 라인</system-reminder>')), null);
});

// 6 (보강) — 나머지 래퍼 제외 규칙
test('local-command-stdout / local-command-caveat 라인은 제외한다', () => {
  assert.equal(normalizeText('<local-command-stdout>결과 출력</local-command-stdout>'), '');
  assert.equal(normalizeText('<local-command-caveat>Caveat: ...</local-command-caveat>'), '');
});

// 7
test('80 code points를 넘으면 79 + … 로 절단하고 surrogate pair를 깨지 않는다', () => {
  const text = normalizeText('가'.repeat(78) + '🗣🗣🗣');
  const points = Array.from(text);
  assert.equal(points.length, 80);
  assert.ok(text.endsWith('🗣…'));
  assert.ok(points.every((c) => c.codePointAt(0) < 0xd800 || c.codePointAt(0) > 0xdfff), '고립 surrogate가 남았다');

  assert.equal(Array.from(normalizeText('가'.repeat(80))).length, 80, '정확히 80이면 절단하지 않는다');
});

// 8
test('다중 줄 입력을 공백 하나로 접는다', () => {
  assert.equal(normalizeText('첫 줄\r\n\n  둘째 줄\t셋째 '), '첫 줄 둘째 줄 셋째');
});

// 9
test('timestamp가 없거나 파싱 불가면 그 라인만 skip하고 직전 정상 요청으로 fallback한다', () => {
  assert.equal(extractRequest(userLine('타임스탬프 없음', { timestamp: undefined })), null);
  assert.equal(extractRequest(userLine('타임스탬프 깨짐', { timestamp: 'not-a-date' })), null);

  const got = collectRecent(fixture('no-timestamp.jsonl'), 1);
  assert.deepEqual(got.map((r) => r.text), ['직전 정상 요청']);
});

// 10
test('역방향 스캔은 limit에서 중단하고 시간 오름차순으로 돌려준다 (chunkSize 64 — 한글 멀티바이트 경계)', () => {
  const got = collectRecent(fixture('many-kr.jsonl'), 3, { chunkSize: 64 });
  assert.deepEqual(got.map((r) => r.text), [
    '요청 18 슬래시 규칙 정리해줘',
    '요청 19 출력 규칙 정리해줘',
    '요청 20 파서 규칙 정리해줘',
  ]);
  assert.ok(got.every((r) => !r.text.includes('�')), '청크 경계에서 멀티바이트 문자가 깨졌다');
  assert.ok(got[0].timestamp < got[2].timestamp);
});

// 11
test('limit이 상한을 넘으면 MAX_LIMIT으로 보정한다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wdis-'));
  const file = path.join(dir, 'big.jsonl');
  fs.writeFileSync(file, Array.from({ length: 120 }, (_, i) => userLine(`요청 ${i}`)).join('\n') + '\n');
  try {
    assert.equal(collectRecent(file, 500).length, MAX_LIMIT);
    assert.equal(collectRecent(file, 0).length, 1, 'limit 0 이하는 1건으로 보정한다');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 12
test('maxBytes에 도달하면 예외 없이 그때까지 수집한 분량만 돌려준다', () => {
  const got = collectRecent(fixture('many-kr.jsonl'), 20, { chunkSize: 64, maxBytes: 400 });
  assert.ok(got.length > 0 && got.length < 20, `부분 수집이어야 한다 (실제 ${got.length}건)`);
  assert.ok(got.every((r) => typeof r.timestamp === 'string' && r.text.length > 0));
});

// 13 · 14
test('list 모드는 /wdis 자신만 건너뛰고 더 과거로 스캔을 이어간다', () => {
  const excluded = collectRecent(fixture('self-command.jsonl'), 5, { excludeSelf: true });
  assert.deepEqual(excluded.map((r) => r.text), ['파서 테스트 케이스 추가해줘', '/wdis-help 1']);

  const kept = collectRecent(fixture('self-command.jsonl'), 5);
  assert.deepEqual(kept.map((r) => r.text), [
    '파서 테스트 케이스 추가해줘',
    '/wdis-help 1',
    '/what-did-i-say:wdis 2',
    '/wdis 3',
  ]);
});

// 15
test('빈 파일은 빈 배열을 돌려준다', () => {
  assert.deepEqual(collectRecent(fixture('empty.jsonl'), 5), []);
});

test('손상 라인·노이즈가 섞인 실측 픽스처에서 사용자 요청만 남긴다', () => {
  const got = collectRecent(fixture('basic.jsonl'), MAX_LIMIT);
  assert.deepEqual(got.map((r) => r.text), [
    '@HANDOFF.md 문서 읽고 아이디어 이어나가자',
    '/clear',
    '파서 필터 규칙 정리해줘',
    '훅 등록 형식 확인해줘',
    '테스트 케이스 추가해줘',
  ]);
  assert.equal(got[0].timestamp, '2026-08-09T00:42:19.745Z');
});
