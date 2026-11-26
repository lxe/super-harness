import { useEffect, useRef, type RefObject } from 'react';

let visibilityInstalled = false;
let sharedObserver: IntersectionObserver | null = null;

/**
 * Installs a single global `visibilitychange` listener that adds `sh-window-hidden`
 * to `document.documentElement` whenever the Electron window / tab is hidden, pausing
 * all infinite CSS animations with zero React re-renders.
 */
export function installWindowVisibilityPause(): void {
  if (visibilityInstalled || typeof document === 'undefined') return;
  visibilityInstalled = true;
  const sync = () => {
    document.documentElement.classList.toggle('sh-window-hidden', Boolean(document.hidden));
  };
  sync();
  document.addEventListener('visibilitychange', sync, { passive: true });
}

function getSharedObserver(): IntersectionObserver | null {
  if (typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') {
    return null;
  }
  if (!sharedObserver) {
    sharedObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const el = entry.target as HTMLElement;
          if (entry.isIntersecting) {
            if (el.dataset.shOffscreen) delete el.dataset.shOffscreen;
          } else {
            el.dataset.shOffscreen = 'true';
          }
        }
      },
      { rootMargin: '40px 0px', threshold: 0 }
    );
  }
  return sharedObserver;
}

/**
 * Tracks whether a mounted animated container is inside the viewport via a shared
 * `IntersectionObserver` and toggles `data-sh-offscreen="true"` directly on the DOM node
 * (zero React state churn) so CSS pauses offscreen animations automatically.
 */
export function useAnimationVisibilityRef<T extends HTMLElement>(): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    installWindowVisibilityPause();
    const el = ref.current;
    const obs = getSharedObserver();
    if (!el || !obs) return;
    obs.observe(el);
    return () => {
      obs.unobserve(el);
      if (el.dataset.shOffscreen) delete el.dataset.shOffscreen;
    };
  }, []);
  return ref;
}
