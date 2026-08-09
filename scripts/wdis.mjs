// 진입점 — Stop hook 모드(인자 없음) / --list 모드 분기, 시간 포맷, 세션 파일 탐색 (TECH_SPEC §2·§5·§7)
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

/** --list 모드 출력 전문(개행 포함)을 만든다. */
export function runList(argv, { now = new Date(), env = process.env, cwd = process.cwd(), home } = {}) {
  const notes = [];
  const limit = parseLimit(argValue(argv, '--list'), notes);
  const sessionId = argValue(argv, '--session-id') || env.CLAUDE_CODE_SESSION_ID;
  const file = resolveTranscript(sessionDir(cwd, home ?? os.homedir()), sessionId);
  if (!file) return `${NO_SESSION}\n`;

  const rows = collectRecent(file, limit, { excludeSelf: true });
  if (rows.length === 0) return `${NO_REQUEST}\n`;
  // rows는 오름차순, [1]이 가장 최근이므로 뒤에서부터 번호를 매긴다
  const lines = rows.map((row, i) => `[${rows.length - i}] ${formatLine(row, now)}`);
  return [...notes, ...lines].join('\n') + '\n';
}

/** hook 모드 출력(없으면 빈 문자열). 예외는 삼키지 않고 호출자에게 올린다. */
export function runHook(stdin, now = new Date()) {
  const { transcript_path: transcriptPath } = JSON.parse(stdin);
  const [recent] = collectRecent(transcriptPath, 1);
  if (!recent) return '';
  return JSON.stringify({ systemMessage: `🗣 ${formatLine(recent, now)}` }) + '\n';
}

function main(argv) {
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
