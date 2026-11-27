import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * A function whose identity never changes but always calls the latest `fn`.
 * Use it for callbacks passed to memoized children (message views, rows), so
 * a parent re-render with fresh closures doesn't re-render every child.
 * Only call the result from event handlers or effects, not during render.
 */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}
