import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The Master Orchestrator's running memory: one markdown file the orchestrator keeps
 * current through sh_read_memory / sh_write_memory, and the hand-off when it switches
 * harness (the old harness compacts into it; the new one starts from it).
 */
export const ORCHESTRATOR_DIR = path.join(os.homedir(), '.config', 'super-harness', 'orchestrator');
export const ORCHESTRATOR_MEMORY_PATH = path.join(ORCHESTRATOR_DIR, 'MEMORY.md');
const MAX_BYTES = 64 * 1024;

const TEMPLATE = `# Master Orchestrator memory

## What's going on
(nothing yet)

## Open threads and who owns them

## Decisions and preferences from lxe

## Next steps
`;

export function readOrchestratorMemory(): string {
  try {
    return fs.readFileSync(ORCHESTRATOR_MEMORY_PATH, 'utf8');
  } catch {
    return TEMPLATE;
  }
}

export function writeOrchestratorMemory(content: string): { ok: boolean; bytes: number; error?: string } {
  const text = content.endsWith('\n') ? content : `${content}\n`;
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_BYTES) {
    return { ok: false, bytes, error: `Memory is ${bytes} bytes; keep it under ${MAX_BYTES} (it is a summary, not a log).` };
  }
  fs.mkdirSync(ORCHESTRATOR_DIR, { recursive: true });
  const tmp = `${ORCHESTRATOR_MEMORY_PATH}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, ORCHESTRATOR_MEMORY_PATH);
  return { ok: true, bytes };
}
