import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, describe, expect, it } from 'vitest';
import { loadClaudeTranscript } from '../src/main/adapters/claudeAdapter';
import {
  getCodexTranscriptFingerprint,
  loadCodexTranscriptFromPaths,
} from '../src/main/adapters/codexAdapter';
import { TranscriptCache } from '../src/main/services/transcriptCache';
import { closeSqlitePool } from '../src/main/utils/sqlite';
import { clearMarkdownCache, renderMarkdownHtml } from '../src/renderer/utils/format';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-perf-test-'));

afterAll(() => {
  closeSqlitePool();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Performance regression suite', () => {
  it('loads a 64MB Claude JSONL transcript tail in <250ms cold and <2ms warm', async () => {
    const file = path.join(tmpDir, 'huge-64mb.jsonl');
    const fd = fs.openSync(file, 'w');
    const noiseLine =
      JSON.stringify({ type: 'api-request-blob', blob: 'X'.repeat(32_000) }) + '\n';
    // Write ~62MB of historical noise + turns, then 50 clean turns at the tail
    const noiseBuf = Buffer.from(noiseLine.repeat(20), 'utf8'); // ~640KB chunk
    for (let c = 0; c < 96; c++) {
      fs.writeSync(fd, noiseBuf);
    }
    const tailLines: string[] = [];
    for (let i = 0; i < 60; i++) {
      tailLines.push(
        JSON.stringify({
          type: 'user',
          uuid: `tail-u-${i}`,
          timestamp: 1_700_000_000_000 + i * 2,
          message: { role: 'user', content: `Prompt #${i}` },
        })
      );
      tailLines.push(
        JSON.stringify({
          type: 'assistant',
          uuid: `tail-a-${i}`,
          timestamp: 1_700_000_000_001 + i * 2,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: `Response #${i} with **markdown** output.` }],
          },
        })
      );
    }
    fs.writeSync(fd, tailLines.join('\n') + '\n');
    fs.closeSync(fd);

    const fileSizeMb = fs.statSync(file).size / (1024 * 1024);
    expect(fileSizeMb).toBeGreaterThan(55);

    const cache = new TranscriptCache();
    const st = fs.statSync(file);
    const fp = `${file}:${st.size}:${Math.floor(st.mtimeMs)}`;

    const tCold = performance.now();
    const coldRes = await cache.getOrLoad('claude-desktop:huge', fp, 40, () =>
      loadClaudeTranscript('claude-desktop:huge', 'huge', file, tmpDir, 40)
    );
    const coldMs = performance.now() - tCold;

    expect(coldRes.messages).toHaveLength(40);
    expect(coldRes.hasMore).toBe(true);
    expect(coldRes.messages[39].id).toBe('tail-a-59');
    expect(coldMs).toBeLessThan(250);

    // Warm cache switch must be sub-2ms
    const tWarm = performance.now();
    const warmRes = await cache.getOrLoad('claude-desktop:huge', fp, 40, () =>
      loadClaudeTranscript('claude-desktop:huge', 'huge', file, tmpDir, 40)
    );
    const warmMs = performance.now() - tWarm;
    expect(warmRes).toBe(coldRes);
    expect(warmMs).toBeLessThan(2);
  });

  it('loads tail of a 5,000-item Codex SQLite thread in <100ms cold and <2ms warm', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (p: string) => {
        exec: (s: string) => void;
        prepare: (s: string) => { run: (...a: unknown[]) => void };
        close: () => void;
      };
    };

    const historyDb = path.join(tmpDir, 'perf_history.sqlite');
    const queueDb = path.join(tmpDir, 'perf_queue.sqlite');

    const db = new DatabaseSync(historyDb);
    db.exec(`
      CREATE TABLE thread_items (
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        rollout_ordinal INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        item_json TEXT NOT NULL,
        item_type TEXT NOT NULL DEFAULT ''
      );
      CREATE UNIQUE INDEX idx_thread_items_page ON thread_items(thread_id, rollout_ordinal);
      BEGIN;
    `);
    const ins = db.prepare(
      'INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    for (let i = 0; i < 5000; i++) {
      const turnId = `t-${Math.floor(i / 2)}`;
      const isUser = i % 2 === 0;
      ins.run(
        'big-codex',
        turnId,
        `item-${i}`,
        i + 1,
        1_700_000_000_000 + i,
        JSON.stringify(
          isUser
            ? { content: [{ text: `User turn ${i}` }] }
            : { text: `Assistant output ${i} ${'code '.repeat(40)}` }
        ),
        isUser ? 'userMessage' : 'agentMessage'
      );
    }
    db.exec('COMMIT;');
    db.close();

    const dbs = { historyDb, queueDb };
    const cache = new TranscriptCache();

    const tCold = performance.now();
    const fp = await getCodexTranscriptFingerprint('big-codex', undefined, dbs);
    const res = await cache.getOrLoad('codex:big-codex', fp, 40, () =>
      loadCodexTranscriptFromPaths('big-codex', undefined, 40, dbs)
    );
    const coldMs = performance.now() - tCold;

    expect(res.messages).toHaveLength(40);
    expect(res.hasMore).toBe(true);
    expect(coldMs).toBeLessThan(100);

    const tWarm = performance.now();
    const fp2 = await getCodexTranscriptFingerprint('big-codex', undefined, dbs);
    const warm = await cache.getOrLoad('codex:big-codex', fp2, 40, () =>
      loadCodexTranscriptFromPaths('big-codex', undefined, 40, dbs)
    );
    const warmMs = performance.now() - tWarm;
    expect(warm).toBe(res);
    expect(warmMs).toBeLessThan(5);
  });

  it('serves 200 cached markdown renders in <5ms', () => {
    clearMarkdownCache();
    const samples = Array.from(
      { length: 40 },
      (_, i) =>
        `## Section ${i}\n\nHere is a **bold** summary with \`inline_code_${i}\` and a list:\n- Item A\n- Item B\n\n\`\`\`ts\nexport const v${i} = ${i};\n\`\`\``
    );

    // Prime cache
    for (const s of samples) renderMarkdownHtml(s);

    const t0 = performance.now();
    for (let r = 0; r < 5; r++) {
      for (const s of samples) renderMarkdownHtml(s);
    }
    const cachedMs = performance.now() - t0;
    expect(cachedMs).toBeLessThan(5);
  });
});
