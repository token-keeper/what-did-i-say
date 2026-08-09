import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatLine, parseLimit, relativeTime, resolveTranscript, runList, sessionDir } from './wdis.mjs';

const entry = fileURLToPath(new URL('./wdis.mjs', import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const run = (args, input) => spawnSync(process.execPath, [entry, ...args], { input, encoding: 'utf8' });

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test('상대시간은 60초·60분·24시간 경계에서 단위가 바뀐다', () => {
  assert.equal(relativeTime(0), '방금');
  assert.equal(relativeTime(-5000), '방금', '미래 timestamp도 방금으로 흡수한다');
  assert.equal(relativeTime(59_999), '방금');
  assert.equal(relativeTime(MINUTE), '1분 전');
  assert.equal(relativeTime(59 * MINUTE), '59분 전');
  assert.equal(relativeTime(HOUR), '1시간 전');
  assert.equal(relativeTime(23 * HOUR), '23시간 전');
  assert.equal(relativeTime(DAY), '1일 전');
  assert.equal(relativeTime(2 * DAY + HOUR), '2일 전');
});

test('같은 날은 HH:MM, 다른 날은 MM-DD HH:MM 접두를 붙인다', () => {
  const at = new Date('2026-08-09T05:32:00.000Z');
  const clock = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const stamp = `${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')} ${clock}`;
  const row = { timestamp: at.toISOString(), text: '파서 필터 규칙 정리해줘' };

  const sameDay = new Date(at.getTime() + 12 * MINUTE);
  assert.equal(formatLine(row, sameDay), `${clock} (12분 전) | 파서 필터 규칙 정리해줘`);

  const nextDay = new Date(at.getTime() + 15 * HOUR);
  assert.equal(formatLine(row, nextDay), `${stamp} (15시간 전) | 파서 필터 규칙 정리해줘`);
});

test('N은 1 미만·비숫자면 1건, 100 초과면 100건으로 보정하고 사유를 안내한다', () => {
  assert.equal(parseLimit(undefined), 1, '인자 생략은 기본값');
  assert.equal(parseLimit(''), 1);
  assert.deepEqual([parseLimit(''), []].slice(1), [[]], '기본값에는 안내를 붙이지 않는다');

  const zero = [];
  assert.equal(parseLimit('0', zero), 1);
  assert.equal(zero.length, 1);

  const bad = [];
  assert.equal(parseLimit('세건', bad), 1);
  assert.match(bad[0], /읽지 못해/);

  const over = [];
  assert.equal(parseLimit('500', over), 100);
  assert.match(over[0], /100건으로 보정/);

  assert.equal(parseLimit('3'), 3);
});

test('슬러그는 비영숫자를 -로 치환한다', () => {
  assert.equal(
    sessionDir('/Users/mini/Github/ai-tools/kaivo', '/home'),
    path.join('/home', '.claude', 'projects', '-Users-mini-Github-ai-tools-kaivo'),
  );
});

function withSession(cwd, sessionId, fixtureName, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wdis-home-'));
  const dir = sessionDir(cwd, home);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(fixture(fixtureName), path.join(dir, `${sessionId}.jsonl`));
  try {
    fn(home, dir);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('--list는 자기 제외 후 [1]이 가장 최근이 되도록 번호를 매긴다', () => {
  const cwd = '/Users/mini/Github/ai-tools/what-did-i-say';
  withSession(cwd, 'abc-123', 'self-command.jsonl', (home) => {
    const out = runList(['--list', '5', '--session-id', 'abc-123'], {
      now: new Date('2026-08-09T02:05:00.000Z'),
      env: {},
      cwd,
      home,
    });
    const lines = out.trimEnd().split('\n');
    assert.equal(lines.length, 2, '/wdis 자신 2건은 제외된다');
    assert.match(lines[0], /^\[2\] .+ \(5분 전\) \| 파서 테스트 케이스 추가해줘$/);
    assert.match(lines[1], /^\[1\] .+ \(4분 전\) \| \/wdis-help 1$/);
  });
});

test('세션 id가 없으면 mtime 최신 파일로 fallback한다', () => {
  const cwd = '/Users/mini/Github/ai-tools/what-did-i-say';
  withSession(cwd, 'old-session', 'empty.jsonl', (home, dir) => {
    const recent = path.join(dir, 'new-session.jsonl');
    fs.copyFileSync(fixture('self-command.jsonl'), recent);
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(recent, future, future);

    assert.equal(resolveTranscript(dir, undefined), recent);
    // 형식이 어긋난 id는 "값 없음"으로 보고 mtime fallback으로 내려간다 — 슬러그 디렉터리 밖으로 나가지 않는다
    assert.equal(resolveTranscript(dir, '${CLAUDE_SESSION_ID}'), recent, '치환되지 않은 변수는 id로 쓰지 않는다');
    assert.equal(resolveTranscript(dir, '../../escape'), recent, '경로 이탈 시도는 id로 쓰지 않는다');
    assert.equal(resolveTranscript(dir, 'no-such-session'), null, '지정한 세션 파일이 없으면 fallback하지 않는다');

    const out = runList(['--list', '1'], { now: new Date('2026-08-09T02:05:00.000Z'), env: {}, cwd, home });
    assert.match(out, /^\[1\] /);
  });
});

test('세션 파일이 없거나 채택할 요청이 0건이면 안내 한 줄만 출력한다', () => {
  const cwd = '/Users/mini/Github/ai-tools/what-did-i-say';
  assert.equal(
    runList(['--list', '3'], { env: {}, cwd, home: path.join(os.tmpdir(), 'wdis-absent-home') }),
    '요청 기록을 찾지 못했습니다 (세션 파일 없음)\n',
  );
  withSession(cwd, 'empty-session', 'empty.jsonl', (home) => {
    assert.equal(
      runList(['--list', '3', '--session-id', 'empty-session'], { env: {}, cwd, home }),
      '표시할 요청이 없습니다\n',
    );
  });
});

// TECH_SPEC §8 케이스 16
test('hook 모드 stdout은 개행 없는 systemMessage JSON 하나다', () => {
  const got = run([], JSON.stringify({ transcript_path: fixture('basic.jsonl') }));
  assert.equal(got.status, 0);
  const payload = JSON.parse(got.stdout);
  assert.ok(payload.systemMessage.startsWith('🗣 '));
  assert.ok(!/[\n\r]/.test(payload.systemMessage), 'systemMessage에 개행이 있다');
  assert.ok(payload.systemMessage.endsWith('| 테스트 케이스 추가해줘'), payload.systemMessage);
  assert.equal(got.stderr, '');
});

test('hook 모드는 어떤 실패에도 무출력 exit 0으로 끝난다', () => {
  for (const [label, input] of [
    ['존재하지 않는 transcript_path', JSON.stringify({ transcript_path: '/nonexistent' })],
    ['transcript_path 누락', '{}'],
    ['손상된 stdin', '{not json'],
    ['빈 stdin', ''],
    ['채택할 요청이 없는 파일', JSON.stringify({ transcript_path: fixture('empty.jsonl') })],
  ]) {
    const got = run([], input);
    assert.equal(got.status, 0, `${label}: exit 0이어야 한다`);
    assert.equal(got.stdout, '', `${label}: 출력이 없어야 한다`);
    assert.equal(got.stderr, '', `${label}: stderr에 쓰지 않는다`);
  }
});
