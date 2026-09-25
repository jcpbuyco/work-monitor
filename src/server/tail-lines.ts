import { openSync, fstatSync, readSync, closeSync } from "node:fs";

/** Read whatever NEW complete lines have landed in a growing file since
 *  `offset`, without ever re-reading bytes already consumed. Shared by every
 *  transcript tailer (Claude's own `usage.ts`, Codex's rollout tailer in
 *  `harness/codex-usage.ts`) so the byte-offset bookkeeping - short-circuiting
 *  before a read when nothing changed, handling a shrunk/rotated file, and
 *  never returning a partially-written final line - lives in exactly one
 *  place. Returns the new offset (just past the last newline) and the
 *  complete lines found; a caller persists the offset. */
export function readNewLines(path: string, offset: number): { offset: number; lines: string[] } {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return { offset, lines: [] }; // missing / unreadable
  }
  try {
    const size = fstatSync(fd).size;
    // Short-circuit BEFORE reading: some of these files reach several MB and
    // are polled every few seconds, so this is the difference between idle
    // and tens of MB a minute.
    let pos = offset;
    if (pos < 0 || pos > size) pos = 0; // shrank / rotated -> re-read
    if (size === pos) return { offset: pos, lines: [] };

    const buf = Buffer.allocUnsafe(size - pos);
    // readSync may legally return a SHORT count, and the tail of an allocUnsafe
    // buffer is uninitialized memory -- never look past what was actually read.
    const got = readSync(fd, buf, 0, buf.length, pos);
    if (got <= 0) return { offset: pos, lines: [] };
    const chunk = buf.subarray(0, got);
    // Find the last newline BYTE: 0x0A never occurs inside a multi-byte UTF-8
    // sequence, so this is exact without decoding first.
    const nl = chunk.lastIndexOf(0x0a);
    if (nl < 0) return { offset: pos, lines: [] }; // no complete new line

    const lines = chunk
      .subarray(0, nl + 1)
      .toString("utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    return { offset: pos + nl + 1, lines };
  } finally {
    closeSync(fd);
  }
}
