/**
 * Retries `attempt` on a capped-exponential backoff until it resolves
 * `true`, or `isCancelled()` reports the caller no longer cares — never
 * gives up on its own. Checking "is X ready yet" is typically cheap (a
 * quick read, not real work), so guessing a fixed give-up point just moves
 * the same "gave up right before it would've succeeded" failure mode to
 * whatever case runs longer than that guess — see Player.tsx's own
 * `loadThumbnailsTrackWithRetry`, which used to give up after a fixed ~18s
 * even though scrubbing-thumbnail generation for a real (non-trivial)
 * source can legitimately still be running well past that.
 */
export async function retryUntilCancelled(
  attempt: () => Promise<boolean>,
  isCancelled: () => boolean,
  { initialDelayMs, maxDelayMs, backoffFactor = 1.6 }: { initialDelayMs: number; maxDelayMs: number; backoffFactor?: number },
): Promise<void> {
  if (await attempt()) return;
  let delay = initialDelayMs;
  while (!isCancelled()) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (isCancelled()) return;
    if (await attempt()) return;
    delay = Math.min(delay * backoffFactor, maxDelayMs);
  }
}
