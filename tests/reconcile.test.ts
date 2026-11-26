import { describe, expect, it } from 'vitest';
import { reconcileById, reuseIfEqual } from '../src/renderer/utils/reconcile';

describe('reconcileById', () => {
  const a = { id: 'a', v: 1, tags: ['x'] };
  const b = { id: 'b', v: 2, tags: [] as string[] };

  it('returns the previous array when every item is value-identical', () => {
    const prev = [a, b];
    const next = [{ ...a, tags: ['x'] }, { ...b }];
    expect(reconcileById(prev, next)).toBe(prev);
  });

  it('keeps identity for unchanged items and takes changed ones', () => {
    const prev = [a, b];
    const changedB = { ...b, v: 3 };
    const out = reconcileById(prev, [{ ...a, tags: ['x'] }, changedB]);
    expect(out).not.toBe(prev);
    expect(out[0]).toBe(a);
    expect(out[1]).toBe(changedB);
    expect(out).toEqual([a, changedB]);
  });

  it('reports reordering, insertion and removal as a change', () => {
    const prev = [a, b];
    const reordered = reconcileById(prev, [{ ...b }, { ...a, tags: ['x'] }]);
    expect(reordered).not.toBe(prev);
    expect(reordered[0]).toBe(b);
    expect(reordered[1]).toBe(a);
    const c = { id: 'c', v: 0, tags: [] };
    expect(reconcileById(prev, [{ ...a, tags: ['x'] }, { ...b }, c])).toEqual([a, b, c]);
    expect(reconcileById(prev, [{ ...a, tags: ['x'] }])).toEqual([a]);
    expect(reconcileById(prev, [{ ...a, tags: ['x'] }])[0]).toBe(a);
  });

  it('passes the first list through untouched', () => {
    const next = [a];
    expect(reconcileById([], next)).toBe(next);
  });
});

describe('reuseIfEqual', () => {
  it('keeps the previous value when equal', () => {
    const prev = [{ id: 'h', ok: true }];
    expect(reuseIfEqual(prev, [{ id: 'h', ok: true }])).toBe(prev);
    const changed = [{ id: 'h', ok: false }];
    expect(reuseIfEqual(prev, changed)).toBe(changed);
  });
});
