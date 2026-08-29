import { describe, expect, it } from 'vitest';
import { decodeScore, explainMissingScore, isScoreRange } from './score.js';

/**
 * These exist because the bug they guard shipped: a genuine on-chain value of 100 was
 * decoded correctly and then rendered as "100.00 / 5". The arithmetic was never wrong —
 * the scale was invented. So the range is asserted here, at the only place that owns it.
 */

describe('decodeScore — real registry values', () => {
  it('decodes the observed BNB Chain reading for agent 56:1', () => {
    // getSummary returned value 100 with 0 decimals: a perfect score, not 100 out of 5.
    expect(decodeScore(100, 0)).toBe(100);
  });

  it('applies the fixed-point decimals', () => {
    expect(decodeScore(8750, 2)).toBe(87.5);
    expect(decodeScore(425, 1)).toBe(42.5);
  });

  it('accepts both ends of the scale', () => {
    expect(decodeScore(0, 0)).toBe(0);
    expect(decodeScore(100, 0)).toBe(100);
  });

  it('keeps a legitimate zero distinct from an absent score', () => {
    /*
     * A client genuinely rating an agent 0 is evidence, and must survive as 0 rather
     * than collapsing to null alongside "no feedback".
     */
    expect(decodeScore(0, 0)).toBe(0);
    expect(decodeScore(null, null)).toBeNull();
  });
});

describe('decodeScore — refuses values that are not scores', () => {
  it('excludes a value above the scale rather than clamping it', () => {
    /*
     * The registry field is generic; a client can post a latency or a cost. Clamping
     * 3200 to 100 would manufacture a perfect score out of a response-time measurement,
     * which is a fabricated claim.
     */
    expect(decodeScore(3200, 0)).toBeNull();
    expect(decodeScore(101, 0)).toBeNull();
  });

  it('excludes a negative value', () => {
    expect(decodeScore(-5, 0)).toBeNull();
  });

  it('returns null when either half of the pair is missing', () => {
    expect(decodeScore(100, null)).toBeNull();
    expect(decodeScore(null, 0)).toBeNull();
  });
});

describe('isScoreRange', () => {
  it('rejects non-finite values', () => {
    expect(isScoreRange(Number.NaN)).toBe(false);
    expect(isScoreRange(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('explainMissingScore', () => {
  it('explains an out-of-range value, naming the range', () => {
    const note = explainMissingScore(3200, 0);
    expect(note).toContain('3200');
    expect(note).toContain('0–100');
  });

  it('says nothing when the value is a valid score', () => {
    expect(explainMissingScore(100, 0)).toBeNull();
  });

  it('says nothing when there is no summary at all', () => {
    // Absence of feedback is a separate state with its own copy in the UI.
    expect(explainMissingScore(null, null)).toBeNull();
  });
});
