// jsonl 역방향 스캔 + 사용자 요청 필터 + 텍스트 정규화 (TECH_SPEC §4)
// 시간 표시·이모지·터미널 출력은 이 모듈의 관심사가 아니다.
import fs from 'node:fs';

export const MAX_LIMIT = 10; // /wdis N 상한
export const MAX_SCAN_BYTES = 10 * 1024 * 1024; // 총 스캔 바이트 상한 (10MiB)

const MAX_CODE_POINTS = 80;
const NEWLINE = 0x0a;
// 커맨드 토큰이 정확히 일치할 때만 자기 제외 — /wdis-help 는 대상이 아니다
const SELF_COMMAND = /^\/(?:wdis|what-did-i-say:wdis)(?:\s|$)/;
// 시스템·타 에이전트가 주입한 user 턴 — isMeta 마커가 없어 텍스트 패턴으로만 걸러진다 (실측)
const INJECTED_TURN = /<teammate-message|<task-notification>|<cross-session-message/;

/** 원문 텍스트를 표시용 한 줄로 정규화한다. 제외 대상이면 빈 문자열. */
export function normalizeText(raw) {
  if (typeof raw !== 'string' || raw === '') return '';
  if (INJECTED_TURN.test(raw)) return '';

  let text = raw;
  const name = text.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (name) {
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
    const command = name[1].trim();
    text = `${command.startsWith('/') ? '' : '/'}${command} ${args ? args[1].trim() : ''}`;
  } else if (/<local-command-stdout>|<local-command-caveat>/.test(text)) {
    return '';
  } else {
    text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  }

  // ANSI escape 등 제어문자가 systemMessage로 살아나가 터미널을 오염시키지 않게 지운다
  text = text.replace(/[\x00-\x1f\x7f]/g, ' ');
  text = text.replace(/\s+/g, ' ').trim();

  const points = Array.from(text);
  return points.length > MAX_CODE_POINTS
    ? points.slice(0, MAX_CODE_POINTS - 1).join('') + '…'
    : text;
}

/** jsonl 한 줄에서 사용자 요청을 뽑는다. 채택 조건(§4.2)에 어긋나면 null. */
export function extractRequest(line) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (!entry || entry.type !== 'user') return null;
  if (entry.isSidechain === true || entry.isMeta === true) return null;

  const { timestamp } = entry;
  if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) return null;

  const content = entry.message?.content;
  let raw;
  if (typeof content === 'string') {
    raw = content;
  } else if (Array.isArray(content)) {
    if (content.some((item) => item?.type === 'tool_result')) return null;
    raw = content.filter((item) => item?.type === 'text').map((item) => item.text ?? '').join('\n');
  } else {
    return null;
  }

  const text = normalizeText(raw);
  return text ? { timestamp, text } : null;
}

/**
 * 파일 끝에서부터 청크 단위로 거슬러 올라가며 최근 요청을 모은다.
 * limit 도달 / 파일 시작 / maxBytes 도달 중 먼저 오는 조건에서 멈추고, 시간 오름차순으로 돌려준다.
 */
export function collectRecent(filePath, limit, { chunkSize = 65536, maxBytes = MAX_SCAN_BYTES, excludeSelf = false } = {}) {
  const max = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(limit)) || 1));
  const found = [];
  const fd = fs.openSync(filePath, 'r');
  try {
    let pos = fs.fstatSync(fd).size;
    let scanned = 0;
    // 아직 라인으로 완성되지 않은 조각들(파일 순서). 결합·디코딩은 개행을 찾은 시점에만 해
    // 매 반복 전체 복사(O(n²))를 피하고 멀티바이트 경계도 지킨다. 개행(0x0a)은 UTF-8
    // 연속 바이트로 나올 수 없어 조각 단위 탐색이 안전하다.
    let pendingParts = [];

    while (pos > 0 && found.length < max && scanned < maxBytes) {
      const size = Math.min(chunkSize, pos, maxBytes - scanned);
      const chunk = Buffer.alloc(size);
      pos -= size;
      fs.readSync(fd, chunk, 0, size, pos);
      scanned += size;

      const newline = chunk.indexOf(NEWLINE);
      if (newline < 0) {
        pendingParts.unshift(chunk); // 라인 하나가 청크보다 길다 — 더 읽는다
        continue;
      }
      const complete = Buffer.concat([chunk.subarray(newline + 1), ...pendingParts]);
      takeLines(complete.toString('utf8'), found, max, excludeSelf);
      pendingParts = [chunk.subarray(0, newline)];
    }
    // 파일 시작까지 읽었을 때만 남은 조각이 완전한 라인이다
    if (pos === 0 && found.length < max) {
      takeLines(Buffer.concat(pendingParts).toString('utf8'), found, max, excludeSelf);
    }
  } finally {
    fs.closeSync(fd);
  }
  return found.reverse();
}

function takeLines(text, found, max, excludeSelf) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0 && found.length < max; i -= 1) {
    const request = extractRequest(lines[i]);
    if (!request) continue;
    if (excludeSelf && SELF_COMMAND.test(request.text)) continue;
    found.push(request);
  }
}
