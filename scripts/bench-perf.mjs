#!/usr/bin/env node
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { HarnessRegistry } = require('../dist/main/main/adapters/registry');
const { ConfigStore } = require('../dist/main/main/store/configStore');
const { closeSqlitePool } = require('../dist/main/main/utils/sqlite');

async function main() {
  const store = new ConfigStore();
  const reg = new HarnessRegistry(store);

  const d1Start = performance.now();
  const { sessions } = await reg.discover();
  const d1Ms = performance.now() - d1Start;

  const d2Start = performance.now();
  await reg.discover();
  const d2Ms = performance.now() - d2Start;

  console.log(`\ndiscover() cold: ${d1Ms.toFixed(1)} ms | warm: ${d2Ms.toFixed(1)} ms (${sessions.length} sessions)`);

  const nonMaster = sessions.filter((s) => s.harness !== 'master');
  const cold = [];
  let errors = 0;

  const coldAllStart = performance.now();
  for (const s of nonMaster) {
    const t0 = performance.now();
    try {
      const res = await reg.getTranscript(s.id, 40);
      cold.push({
        harness: s.harness,
        ms: performance.now() - t0,
        msgs: res.messages.length,
        total: res.totalCount,
        title: s.title.slice(0, 42),
      });
    } catch (err) {
      errors++;
      console.error(`  ERROR loading ${s.id}: ${err.message}`);
    }
  }
  const coldAllMs = performance.now() - coldAllStart;
  cold.sort((a, b) => b.ms - a.ms);

  const p50 = cold[Math.floor(cold.length * 0.5)]?.ms ?? 0;
  const p95 = cold[Math.floor(cold.length * 0.05)]?.ms ?? 0;

  console.log(
    `\nCold load (limit=40, ${nonMaster.length} sessions): total=${coldAllMs.toFixed(1)} ms | p50=${p50.toFixed(1)} ms | p95=${p95.toFixed(1)} ms | max=${(cold[0]?.ms ?? 0).toFixed(1)} ms | errors=${errors}`
  );
  console.log('Top 8 slowest (cold):');
  for (const x of cold.slice(0, 8)) {
    console.log(
      `  ${x.ms.toFixed(1).padStart(7)} ms | [${x.harness.padEnd(14)}] ${String(x.msgs).padStart(2)}/${String(x.total).padStart(4)} | ${x.title}`
    );
  }

  const warmTargets = nonMaster.slice(-50);
  const wStart = performance.now();
  for (const s of warmTargets) {
    await reg.getTranscript(s.id, 40);
  }
  const wMs = performance.now() - wStart;
  console.log(
    `\nWarm switch (${warmTargets.length} cached sessions): ${wMs.toFixed(2)} ms total (${(wMs / Math.max(warmTargets.length, 1)).toFixed(3)} ms/switch)`
  );
  console.log('Cache stats:', reg.getTranscriptCacheStats());
  closeSqlitePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
