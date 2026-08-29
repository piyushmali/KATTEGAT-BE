import { describe, expect, it } from 'vitest';
import { backfillHasMore } from './sync.js';

/**
 * The registry walk is ~300k ids and takes hours, so the condition that ends it has to
 * be right for a reason that is easy to miss: getting it wrong does not crash, it
 * reports success early.
 */
describe('backfillHasMore', () => {
  it('continues while ids remain', () => {
    expect(backfillHasMore({ remaining: 228_069 })).toBe(true);
    expect(backfillHasMore({ remaining: 1 })).toBe(true);
  });

  it('stops only when nothing remains', () => {
    expect(backfillHasMore({ remaining: 0 })).toBe(false);
  });

  it('does not end the walk just because a pass found no agents', () => {
    /*
     * The regression this exists for. The loop used to stop on `discovered === 0` as
     * well, so a stretch of unminted ids — a gap, which the registry genuinely has —
     * would have ended a walk with 228,000 ids left and logged it as complete.
     *
     * `remaining` is the only input, so a barren pass cannot influence the decision.
     */
    expect(backfillHasMore({ remaining: 228_069 })).toBe(true);
  });

  it('treats a negative remaining as finished rather than looping forever', () => {
    // Defensive: the cursor overshooting a shrinking `highest` must not spin.
    expect(backfillHasMore({ remaining: -5 })).toBe(false);
  });
});
