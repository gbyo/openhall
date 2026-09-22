import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DestinationFlowReconciler } from '@openhall/application';
import { startDestinationFlowWorker } from './reconciler-runner.js';

describe('destination flow worker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls the reconciler on the configured interval until stopped', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const reconciler = {
      runBatch: (): Promise<number> => {
        calls += 1;
        return Promise.resolve(0);
      },
    } as unknown as DestinationFlowReconciler;
    const worker = startDestinationFlowWorker(reconciler, 2000);
    try {
      await vi.advanceTimersByTimeAsync(6500);
      expect(calls).toBe(3);
      worker.stop();
      await vi.advanceTimersByTimeAsync(10000);
      expect(calls).toBe(3);
    } finally {
      worker.stop();
    }
  });

  it('keeps polling after a failed tick', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const seen: unknown[] = [];
    const reconciler = {
      runBatch: (): Promise<number> => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('boom'));
        return Promise.resolve(0);
      },
    } as unknown as DestinationFlowReconciler;
    const worker = startDestinationFlowWorker(reconciler, 1000, (error: unknown) => {
      seen.push(error);
    });
    try {
      await vi.advanceTimersByTimeAsync(2500);
      expect(calls).toBe(2);
      expect(seen).toHaveLength(1);
    } finally {
      worker.stop();
    }
  });
});
