import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { retryUntilCancelled } from './retry';

describe('retryUntilCancelled', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns immediately if the first attempt already succeeds', async () => {
    const attempt = vi.fn().mockResolvedValue(true);
    await retryUntilCancelled(attempt, () => false, { initialDelayMs: 500, maxDelayMs: 20000 });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('stops as soon as an attempt succeeds, after however many failed first', async () => {
    const attempt = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const promise = retryUntilCancelled(attempt, () => false, { initialDelayMs: 500, maxDelayMs: 20000 });
    await vi.runAllTimersAsync();
    await promise;
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('stops once isCancelled() reports true, without a further attempt', async () => {
    let cancelled = false;
    const attempt = vi.fn().mockResolvedValue(false);
    const promise = retryUntilCancelled(attempt, () => cancelled, { initialDelayMs: 500, maxDelayMs: 20000 });
    await vi.advanceTimersByTimeAsync(500); // first retry fires, still not cancelled
    cancelled = true;
    await vi.runAllTimersAsync();
    await promise;
    const callsWhileCancelled = attempt.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(attempt.mock.calls.length).toBe(callsWhileCancelled); // no more attempts after cancellation
  });

  // The actual regression this exists to fix: the old fixed ~18s/5-attempt
  // schedule gave up long before a real (non-trivial) source's own
  // thumbnail-sprite generation could realistically finish — see
  // Player.tsx's own `loadThumbnailsTrackWithRetry` doc comment. Confirms
  // this keeps retrying well past that old window instead of giving up.
  it('keeps retrying well past the old ~18s/5-attempt budget, never giving up on its own', async () => {
    const attempt = vi.fn().mockResolvedValue(false);
    const promise = retryUntilCancelled(attempt, () => false, { initialDelayMs: 500, maxDelayMs: 20000 });
    // Old behavior gave up for good after 5 retries (~18s total). Advancing
    // 3 real minutes should produce far more than 6 total calls (1 initial +
    // 5 retries) if this genuinely never stops on its own.
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    expect(attempt.mock.calls.length).toBeGreaterThan(10);
    void promise; // still pending forever in this test — never resolves until cancelled
  });

  it('caps the backoff delay at maxDelayMs rather than growing unbounded', async () => {
    const callTimestamps: number[] = [];
    const attempt = vi.fn().mockImplementation(async () => {
      callTimestamps.push(Date.now());
      return false;
    });
    const promise = retryUntilCancelled(attempt, () => false, { initialDelayMs: 1000, maxDelayMs: 5000, backoffFactor: 2 });
    await vi.advanceTimersByTimeAsync(60000);
    void promise;

    const gaps = callTimestamps.slice(1).map((t, i) => t - callTimestamps[i]);
    // 1000, 2000, 4000, then capped at 5000 from then on.
    expect(gaps[0]).toBe(1000);
    expect(gaps[1]).toBe(2000);
    expect(gaps[2]).toBe(4000);
    expect(gaps.slice(3).every((g) => g === 5000)).toBe(true);
    expect(gaps.length).toBeGreaterThan(4); // enough samples for the cap assertion to mean something
  });
});
