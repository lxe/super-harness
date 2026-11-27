/**
 * Runs the app's decorative infinite CSS animations (working shimmer, gauge
 * aurora, unread throb, the working mark) on one shared 30 fps clock.
 *
 * In this Electron/Chromium build on a 120 Hz display, every running CSS
 * animation, even a compositor-only transform, wakes the main thread for a
 * style recalc on every frame; profiling showed ~25 such animations costing
 * about a third of a core while the app sat idle. Two changes fix that:
 *
 * 1. Each `sh-*` animation gets effect easing `steps(duration / 33.3ms)`. CSS
 *    keyframe easing (ease-in-out, cubic-bezier…) still shapes the motion;
 *    it is just sampled 30 times a second, so Blink only services the
 *    animation when its value changes instead of every frame.
 * 2. Start times are snapped to a shared 33.3 ms grid, so all animations
 *    change value on the same frames instead of filling every frame between
 *    them. Animations resumed after being paused offscreen drift off the
 *    grid, so a 1 s sweep re-snaps them.
 *
 * Measured on the idle app: 321 → 96 ms/s main-thread time, layouts
 * 122 → 31 per second. Keep new `sh-*` durations and delays at multiples of
 * 33.3 ms (e.g. 1.5s, 1.6s, 2.2s) so their steps land on the shared grid; the
 * few that don't (orb-spin 1.85s, mark-float delays) just step slightly off it.
 */

const FPS = 30;
const STEP_MS = 1000 / FPS;
const SWEEP_MS = 1000;

const handled = new WeakSet<Animation>();

function isAppAnimation(a: Animation): boolean {
  const name = (a as CSSAnimation).animationName;
  return typeof name === 'string' && name.startsWith('sh-');
}

function quantize(a: Animation): void {
  const effect = a.effect;
  if (!effect || !isAppAnimation(a)) return;
  const timing = effect.getTiming();
  const duration = Number(timing.duration);
  if (timing.iterations !== Infinity || !Number.isFinite(duration) || duration <= 0) return;

  if (!handled.has(a)) {
    handled.add(a);
    effect.updateTiming({ easing: `steps(${Math.max(1, Math.round(duration / STEP_MS))}, end)` });
  }
  if (a.playState === 'running' && typeof a.startTime === 'number') {
    const snapped = Math.round(a.startTime / STEP_MS) * STEP_MS;
    if (Math.abs(snapped - a.startTime) > 0.5) a.startTime = snapped;
  }
}

function sweep(): void {
  if (document.hidden) return;
  for (const a of document.getAnimations()) quantize(a);
}

let installed = false;

export function installAnimationClock(): void {
  if (installed || typeof document === 'undefined' || typeof document.getAnimations !== 'function') {
    return;
  }
  installed = true;
  document.addEventListener(
    'animationstart',
    (e) => {
      const target = e.target as Element | null;
      if (!target?.getAnimations) return;
      for (const a of target.getAnimations()) {
        if ((a as CSSAnimation).animationName === (e as AnimationEvent).animationName) {
          void a.ready.then(() => quantize(a)).catch(() => {});
        }
      }
    },
    { capture: true, passive: true }
  );
  window.setInterval(sweep, SWEEP_MS);
  sweep();
}
