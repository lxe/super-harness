import { parentPort } from 'node:worker_threads';
import { offloadTasks, type OffloadTaskName } from './offloadTasks';

interface OffloadRequest {
  id: number;
  task: OffloadTaskName;
  args: unknown[];
}

parentPort?.on('message', async (req: OffloadRequest) => {
  try {
    const fn = offloadTasks[req.task] as (...a: unknown[]) => unknown;
    const result = await fn(...req.args);
    parentPort?.postMessage({ id: req.id, ok: true, result });
  } catch (err) {
    parentPort?.postMessage({
      id: req.id,
      ok: false,
      error: err instanceof Error ? { message: err.message, stack: err.stack } : { message: String(err) },
    });
  }
});
