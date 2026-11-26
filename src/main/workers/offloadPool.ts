import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { offloadTasks, type OffloadTaskName } from './offloadTasks';

type TaskFn<K extends OffloadTaskName> = (typeof offloadTasks)[K];

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  run: () => Promise<unknown>;
}

interface Slot {
  worker: Worker;
  inFlight: Map<number, Pending>;
}

/**
 * Small worker_threads pool that runs `offloadTasks` off the Electron main
 * thread. Results are identical to calling the task inline; if the worker
 * script is missing (tests run from .ts sources) or a worker dies, calls fall
 * back to running inline so behavior never depends on the pool.
 */
export class OffloadPool {
  private slots: Slot[] = [];
  private nextId = 1;
  private rr = 0;
  private disabled = false;
  private readonly workerPath: string;

  constructor(
    private readonly size = 2,
    workerPath = path.join(__dirname, 'offloadWorker.js')
  ) {
    this.workerPath = workerPath;
    if (!fs.existsSync(this.workerPath)) this.disabled = true;
  }

  run<K extends OffloadTaskName>(task: K, ...args: Parameters<TaskFn<K>>): ReturnType<TaskFn<K>> {
    const inline = () => (offloadTasks[task] as (...a: unknown[]) => unknown)(...args) as Promise<unknown>;
    const slot = this.disabled ? null : this.pickSlot();
    if (!slot) return inline() as ReturnType<TaskFn<K>>;
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      slot.inFlight.set(id, { resolve, reject, run: inline });
      try {
        slot.worker.postMessage({ id, task, args });
      } catch {
        slot.inFlight.delete(id);
        inline().then(resolve, reject);
      }
    }) as unknown as ReturnType<TaskFn<K>>;
  }

  private pickSlot(): Slot | null {
    try {
      while (this.slots.length < this.size) this.slots.push(this.spawn());
    } catch {
      this.disabled = true;
      return null;
    }
    // Least-loaded slot, round-robin among ties.
    let best: Slot | null = null;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[(this.rr + i) % this.slots.length];
      if (!best || s.inFlight.size < best.inFlight.size) best = s;
    }
    this.rr = (this.rr + 1) % this.slots.length;
    return best;
  }

  private spawn(): Slot {
    const worker = new Worker(this.workerPath);
    worker.unref();
    const slot: Slot = { worker, inFlight: new Map() };
    worker.on('message', (msg: { id: number; ok: boolean; result?: unknown; error?: { message: string; stack?: string } }) => {
      const p = slot.inFlight.get(msg.id);
      if (!p) return;
      slot.inFlight.delete(msg.id);
      if (msg.ok) {
        p.resolve(msg.result);
      } else {
        const err = new Error(msg.error?.message);
        if (msg.error?.stack) err.stack = msg.error.stack;
        p.reject(err);
      }
    });
    const fail = () => {
      this.slots = this.slots.filter((s) => s !== slot);
      // Re-run anything the dead worker was holding inline, so no call is lost.
      for (const p of slot.inFlight.values()) p.run().then(p.resolve, p.reject);
      slot.inFlight.clear();
    };
    worker.on('error', fail);
    worker.on('exit', fail);
    return slot;
  }

  close(): void {
    this.disabled = true;
    for (const s of this.slots) void s.worker.terminate();
    this.slots = [];
  }
}

export const offloadPool = new OffloadPool();
