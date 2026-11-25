import fs from 'node:fs';

export interface TailLinesResult {
  lines: string[];
  fileSize: number;
  mtimeMs: number;
  startOffset: number;
  truncated: boolean;
}

/**
 * Reads up to `maxBytes` from the tail of a UTF-8 JSONL file without loading
 * multi-hundred-MB transcripts into memory (preventing V8 ERR_STRING_TOO_LONG
 * crashes and ~900ms main-thread stalls).
 *
 * When truncated (startOffset > 0), scans forward in the raw byte buffer to
 * the first 0x0A ('\n') byte before decoding UTF-8 so neither JSON lines nor
 * multi-byte UTF-8 codepoints are ever split across chunk boundaries.
 */
export function readJsonlTailLines(
  filePath: string,
  maxBytes: number
): TailLinesResult | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(filePath);
  } catch {
    return null;
  }

  const fileSize = st.size;
  const mtimeMs = st.mtimeMs;
  if (fileSize === 0) {
    return { lines: [], fileSize: 0, mtimeMs, startOffset: 0, truncated: false };
  }

  const readLen = Math.min(fileSize, Math.max(1024, maxBytes));
  const rawOffset = fileSize - readLen;
  const truncated = rawOffset > 0;

  const buf = Buffer.allocUnsafe(readLen);
  const fd = fs.openSync(filePath, 'r');
  let bytesRead = 0;
  try {
    while (bytesRead < readLen) {
      const n = fs.readSync(fd, buf, bytesRead, readLen - bytesRead, rawOffset + bytesRead);
      if (n <= 0) break;
      bytesRead += n;
    }
  } finally {
    fs.closeSync(fd);
  }

  const view = bytesRead < readLen ? buf.subarray(0, bytesRead) : buf;
  let sliceStart = 0;
  let effectiveStartOffset = rawOffset;

  if (truncated) {
    // 0x0a ('\n') never appears as a UTF-8 continuation byte, so starting
    // immediately after the first newline guarantees both a complete JSONL
    // line and a valid UTF-8 codepoint boundary.
    const firstNewline = view.indexOf(0x0a);
    if (firstNewline === -1) {
      return { lines: [], fileSize, mtimeMs, startOffset: fileSize, truncated: true };
    }
    sliceStart = firstNewline + 1;
    effectiveStartOffset = rawOffset + sliceStart;
  }

  const text = view.subarray(sliceStart).toString('utf8');
  const lines = text.split('\n');
  return {
    lines,
    fileSize,
    mtimeMs,
    startOffset: effectiveStartOffset,
    truncated,
  };
}

export interface ProgressiveTailOptions {
  initialBytes?: number;
  maxBytes?: number;
  growthFactor?: number;
}

export interface ProgressiveTailOutcome<T> {
  parsed: T;
  fileSize: number;
  mtimeMs: number;
  startOffset: number;
  truncated: boolean;
  bytesRead: number;
}

const DEFAULT_INITIAL_BYTES = 512 * 1024; // 512 KB
const DEFAULT_MAX_BYTES = 48 * 1024 * 1024; // 48 MB (safe under V8 string limits)
const DEFAULT_GROWTH_FACTOR = 4;

/**
 * Reads progressively larger tail windows of a JSONL file until `isEnough`
 * returns true, the beginning of the file is reached, or `maxBytes` is hit.
 */
export function readProgressiveJsonlTail<T>(
  filePath: string,
  parse: (lines: string[], meta: { truncated: boolean; fileSize: number; mtimeMs: number }) => T,
  isEnough: (parsed: T) => boolean,
  opts?: ProgressiveTailOptions
): ProgressiveTailOutcome<T> | null {
  const initialBytes = Math.max(4096, opts?.initialBytes ?? DEFAULT_INITIAL_BYTES);
  const maxBytes = Math.max(initialBytes, opts?.maxBytes ?? DEFAULT_MAX_BYTES);
  const growth = Math.max(2, opts?.growthFactor ?? DEFAULT_GROWTH_FACTOR);

  let windowBytes = initialBytes;
  while (true) {
    const chunk = readJsonlTailLines(filePath, windowBytes);
    if (!chunk) return null;

    const parsed = parse(chunk.lines, {
      truncated: chunk.truncated,
      fileSize: chunk.fileSize,
      mtimeMs: chunk.mtimeMs,
    });

    if (!chunk.truncated || isEnough(parsed) || windowBytes >= maxBytes) {
      return {
        parsed,
        fileSize: chunk.fileSize,
        mtimeMs: chunk.mtimeMs,
        startOffset: chunk.startOffset,
        truncated: chunk.truncated,
        bytesRead: chunk.fileSize - chunk.startOffset,
      };
    }

    windowBytes = Math.min(maxBytes, Math.round(windowBytes * growth));
  }
}
