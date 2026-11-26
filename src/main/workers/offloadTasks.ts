import { loadClaudeTranscript } from '../adapters/claudeAdapter';

/**
 * Pure, CPU-heavy functions that may run on a worker thread instead of the
 * Electron main thread (which is also Chromium's browser UI thread, so any
 * long synchronous task there freezes the window). Each task must depend only
 * on its arguments and the filesystem, and return structured-cloneable data.
 */
export const offloadTasks = {
  // Wrapped so the binding is read at call time: claudeAdapter imports the pool, which
  // imports this module, so an eager reference could see the cycle half-initialized.
  loadClaudeTranscript: (...a: Parameters<typeof loadClaudeTranscript>) => loadClaudeTranscript(...a),
};

export type OffloadTaskName = keyof typeof offloadTasks;
