// 진입점 — Stop hook 모드(인자 없음) / --expand 모드 / --list 모드 분기, 시간 포맷, 세션 파일 탐색 (TECH_SPEC §2·§5·§7)
// jsonl 스캔·필터는 parser.mjs 담당이다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { MAX_LIMIT, collectRecent } from './parser.mjs';

const NO_SESSION = '요청 기록을 찾지 못했습니다 (세션 파일 없음)';
const NO_REQUEST = '표시할 요청이 없습니다';
const UNREADABLE = '요청 기록을 읽지 못했습니다';
// 세션 id는 경로로 쓰인다 — 치환되지 않은 ${CLAUDE_SESSION_ID}와 경로 이탈을 함께 걸러낸다
const SESSION_ID = /^[A-Za-z0-9_-]+$/;
// UserPromptExpansion에서 우리 커맨드로 인정하는 이름 (앞의 `/`는 떼고 비교한다)
const EXPAND_NAMES = new Set(['wdis', 'what-did-i-say:wdis']);

const pad = (n) => String(n).padStart(2, '0');

/** 경과 밀리초를 상대시간 표기로 (TECH_SPEC §5) */
export function relativeTime(elapsedMs) {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 60) return '방금';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}시간 전`;
  return `${Math.floor(seconds / 86400)}일 전`;
}

const sameLocalDay = (a, b) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** `14:32 (12분 전) | 텍스트` — 오늘이 아니면 `MM-DD HH:MM` 접두 */
export function formatLine({ timestamp, text }, now = new Date()) {
  const at = new Date(timestamp);
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const stamp = sameLocalDay(at, now) ? clock : `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${clock}`;
  return `${stamp} (${relativeTime(now - at)}) | ${text}`;
}

/** cwd → ~/.claude/projects/<슬러그> (TECH_SPEC §2.3) */
export function sessionDir(cwd, home = os.homedir()) {
  return path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

/** session id 우선, 없으면 mtime 최신 jsonl. 찾지 못하면 null. */
export function resolveTranscript(dir, sessionId) {
  if (sessionId && SESSION_ID.test(sessionId)) {
    const file = path.join(dir, `${sessionId}.jsonl`);
    return fs.existsSync(file) ? file : null;
  }
  if (!fs.existsSync(dir)) return null;
  const latest = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => path.join(dir, name))
    .reduce((best, file) => {
      const mtime = fs.statSync(file).mtimeMs;
      return !best || mtime > best.mtime ? { file, mtime } : best;
    }, null);
  return latest ? latest.file : null;
}

/** `--list N` 의 N 보정. 보정 사유가 있으면 notes에 안내 한 줄을 남긴다. */
export function parseLimit(raw, notes = []) {
  const value = String(raw ?? '').trim();
  if (value === '') return 1; // 인자 생략 = 기본 1건, 안내 불필요
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    notes.push(`요청 건수 "${value}" 를 읽지 못해 1건만 표시합니다`);
    return 1;
  }
  if (parsed > MAX_LIMIT) {
    notes.push(`요청 건수가 상한을 넘어 ${MAX_LIMIT}건으로 보정했습니다`);
    return MAX_LIMIT;
  }
  return Math.floor(parsed);
}

function argValue(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

/** 목록 본문(개행 포함)을 만든다. 조회 실패는 안내 한 줄로 대신한다. */
function renderList(file, limit, notes, now) {
  if (!file) return `${NO_SESSION}\n`;
  const rows = collectRecent(file, limit, { excludeSelf: true });
  if (rows.length === 0) return `${NO_REQUEST}\n`;
  // rows는 오름차순, [1]이 가장 최근이므로 뒤에서부터 번호를 매긴다
  const lines = rows.map((row, i) => `[${rows.length - i}] ${formatLine(row, now)}`);
  return [...notes, ...lines].join('\n') + '\n';
}

/** --list 모드 출력 전문(개행 포함)을 만든다. */
export function runList(argv, { now = new Date(), env = process.env, cwd = process.cwd(), home } = {}) {
  const notes = [];
  const limit = parseLimit(argValue(argv, '--list'), notes);
  const sessionId = argValue(argv, '--session-id') || env.CLAUDE_CODE_SESSION_ID;
  return renderList(resolveTranscript(sessionDir(cwd, home ?? os.homedir()), sessionId), limit, notes, now);
}

/**
 * UserPromptExpansion payload가 우리 커맨드면 인자 문자열, 아니면 null.
 * command_name이 있으면 그것만으로 판정한다 — prompt prefix 매칭으로 타 커맨드를 삼키지 않기 위해서다.
 */
export function expandArgs({ command_name: name, command_args: args, prompt }) {
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  // prompt는 인자만(`3`)일 수도, 슬래시를 포함(`/wdis 3`)일 수도 있다
  const fromPrompt = () => text.replace(/^\/\S+\s*/, '');
  if (typeof name === 'string' && name.trim() !== '') {
    if (!EXPAND_NAMES.has(name.trim().replace(/^\//, ''))) return null;
    return typeof args === 'string' ? args.trim() : fromPrompt();
  }
  const head = text.split(/\s+/)[0];
  if (!head.startsWith('/') || !EXPAND_NAMES.has(head.slice(1))) return null;
  return fromPrompt();
}

/** --expand 모드의 reason 문자열. 우리 커맨드가 아니면 null(= 무출력으로 통과시킨다). */
export function runExpand(stdin, { now = new Date(), env = process.env, home } = {}) {
  const input = JSON.parse(stdin) ?? {};
  const args = expandArgs(input);
  if (args === null) return null;
  try {
    const notes = [];
    const limit = parseLimit(args.split(/\s+/)[0], notes);
    const { transcript_path: given, session_id: sessionId, cwd } = input;
    const file =
      typeof given === 'string' && fs.existsSync(given)
        ? given
        : resolveTranscript(
            sessionDir(typeof cwd === 'string' && cwd ? cwd : process.cwd(), home ?? os.homedir()),
            sessionId || env.CLAUDE_CODE_SESSION_ID,
          );
    return renderList(file, limit, notes, now).trimEnd();
  } catch {
    // 라우팅은 끝났으므로 침묵하지 않는다 — 커맨드를 삼키면 사용자에게 아무 반응이 없다
    return UNREADABLE;
  }
}

/** hook 모드 출력(없으면 빈 문자열). 예외는 삼키지 않고 호출자에게 올린다. */
export function runHook(stdin, now = new Date()) {
  const { transcript_path: transcriptPath } = JSON.parse(stdin);
  const [recent] = collectRecent(transcriptPath, 1);
  if (!recent) return '';
  return JSON.stringify({ systemMessage: `🗣 ${formatLine(recent, now)}` }) + '\n';
}

function main(argv) {
  if (argv.includes('--expand')) {
    try {
      const reason = runExpand(fs.readFileSync(0, 'utf8'));
      // null = 우리 커맨드가 아니다. 무출력으로 통과시켜야 타 플러그인 커맨드가 막히지 않는다.
      if (reason !== null) process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
    } catch {
      /* 라우팅 이전 실패(stdin 손상 등) — 남의 커맨드일 수 있으므로 무출력 */
    }
    return;
  }
  if (!argv.includes('--list')) {
    // §7 — 예외를 삼키는 지점은 여기 한 곳뿐이다. 무엇이 실패하든 무출력 exit 0.
    try {
      // hook 실행 시 stdin은 항상 파이프된다. stdin 없이 단독 실행하면 여기서 블록될 수 있다.
      process.stdout.write(runHook(fs.readFileSync(0, 'utf8')));
    } catch {
      /* 턴 완료를 방해하지 않는다 */
    }
    return;
  }
  try {
    process.stdout.write(runList(argv));
  } catch {
    try {
      process.stdout.write(`${UNREADABLE}\n`);
    } catch {
      /* stdout이 이미 죽었어도(EPIPE) exit 0 계약을 지킨다 */
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
