/**
 * Decoding an ERC-8004 feedback summary into a score — or refusing to.
 *
 * THE SCALE IS 0–100, NOT 0–5.
 *
 * ERC-8004 requires a feedback score to be between 0 and 100. This was previously
 * decoded correctly and then *presented* on a 0–5 scale, so an agent with a genuine
 * perfect record rendered as "100.00 / 5" — a real number reported against a scale the
 * standard never defines. That is the one class of mistake this product cannot make, so
 * the rule now lives in one place with tests instead of being assumed at each call site.
 *
 * THE FIELD IS DELIBERATELY GENERIC.
 *
 * `getSummary` averages whatever clients posted, and the registry does not require it to
 * be a quality score: a client may record a response time, a cost, or any other numeric
 * signal. So a value outside 0–100 is not a poor rating — it is not a rating at all, and
 * showing it as one would invent a claim nobody made.
 *
 * Such values are therefore excluded rather than clamped. Clamping 3200ms to 100 would
 * manufacture a perfect score out of a latency measurement, which is worse than showing
 * nothing. Callers get `null` and still have `summaryValue`/`summaryDecimals` to show
 * what was actually recorded.
 */

/** Inclusive bounds ERC-8004 places on a feedback score. */
export const SCORE_MIN = 0;
export const SCORE_MAX = 100;

/** True when a decoded value is on the score scale and can be called a score. */
export function isScoreRange(value: number): boolean {
  return Number.isFinite(value) && value >= SCORE_MIN && value <= SCORE_MAX;
}

/**
 * Decodes the registry's fixed-point pair into a score, or `null` when the result is not
 * one.
 *
 * `null` covers three different situations that all mean "we cannot state a score":
 * there was no feedback, the pair was incomplete, or the value is not on the score
 * scale. Each is an absence of evidence, never a zero.
 */
export function decodeScore(value: number | null, decimals: number | null): number | null {
  if (value === null || decimals === null) return null;

  const decoded = value / 10 ** decimals;
  return isScoreRange(decoded) ? decoded : null;
}

/**
 * Why a summary that exists did not produce a score, for the `notes` the API returns
 * verbatim to the UI. Returns `null` when there is nothing to explain.
 *
 * Worth stating explicitly: an agent with feedback but no score looks identical to an
 * agent with none at all unless the difference is spelled out, and those are genuinely
 * different situations for someone deciding whether to trust it.
 */
export function explainMissingScore(
  value: number | null,
  decimals: number | null,
): string | null {
  if (value === null || decimals === null) return null;

  const decoded = value / 10 ** decimals;
  if (isScoreRange(decoded)) return null;

  return (
    `Recorded feedback averages ${String(decoded)}, which is outside the 0–100 range ` +
    'ERC-8004 defines for a score. The registry allows clients to post other numeric ' +
    'signals in this field, so this is reported as recorded rather than shown as a rating.'
  );
}
