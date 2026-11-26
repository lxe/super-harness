/**
 * Structural sharing for lists that arrive fresh over IPC on every discovery tick.
 * Items that are value-identical to the previous list keep their previous object
 * identity, and when nothing changed at all the previous array itself is returned,
 * so memoized consumers (and React state setters) can skip work entirely.
 */
const jsonCache = new WeakMap<object, string>();
const jsonOf = (v: object): string => {
  let j = jsonCache.get(v);
  if (j === undefined) {
    j = JSON.stringify(v);
    jsonCache.set(v, j);
  }
  return j;
};

export function reconcileById<T extends { id: string }>(prev: T[], next: T[]): T[] {
  if (prev.length === 0) return next;
  const prevById = new Map<string, T>();
  for (const item of prev) prevById.set(item.id, item);
  let allSame = prev.length === next.length;
  const out = next.map((item, i) => {
    const old = prevById.get(item.id);
    if (!old) {
      allSame = false;
      return item;
    }
    // Previous items are cached by identity, so each tick only serializes what is new.
    if (jsonOf(old) === jsonOf(item)) {
      if (prev[i] !== old) allSame = false;
      return old;
    }
    allSame = false;
    return item;
  });
  return allSame ? prev : out;
}

/** Returns `prev` when `next` is value-identical, else `next`. */
export function reuseIfEqual<T>(prev: T, next: T): T {
  if (prev === next) return prev;
  return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
}
