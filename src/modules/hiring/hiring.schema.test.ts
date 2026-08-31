import { describe, expect, it } from 'vitest';
import { grantSessionBodySchema } from './hiring.schema.js';

/**
 * The grant request is a trust boundary in the strongest sense on this API: what it accepts
 * becomes authority over money, enforced on chain, for as long as the expiry says.
 *
 * So the rejections are the tests. Each case below is a request that would have granted more
 * than the caller meant to, and validation is cheaper than a transaction.
 */

const valid = {
  spend_limit_wei: '10000000000000000',
  spend_period: 'day' as const,
  duration_minutes: 60,
  allowed_targets: ['0x10ED43C718714eb63d5aA57B78B54704E256024E'],
};

describe('grantSessionBodySchema', () => {
  it('accepts a bounded grant', () => {
    const parsed = grantSessionBodySchema.parse(valid);
    expect(parsed.spend_limit_wei).toBe('10000000000000000');
    expect(parsed.allowed_targets).toHaveLength(1);
  });

  it('refuses an empty allowlist', () => {
    /*
     * The single most important rejection here. An empty `calls` array reads as "any target"
     * to the Altana account contract, which is exactly the blanket access this product says it
     * never offers. Refused at the boundary rather than defaulted, so no caller can grant it by
     * leaving the field off.
     */
    expect(grantSessionBodySchema.safeParse({ ...valid, allowed_targets: [] }).success).toBe(false);
    const missing: Record<string, unknown> = { ...valid };
    delete missing.allowed_targets;
    expect(grantSessionBodySchema.safeParse(missing).success).toBe(false);
  });

  it('refuses a spend ceiling of zero', () => {
    // Not an error the chain would catch, and a session that can spend nothing is not a hire.
    expect(grantSessionBodySchema.safeParse({ ...valid, spend_limit_wei: '0' }).success).toBe(false);
  });

  it('refuses a decimal or negative amount, because the field is wei', () => {
    /*
     * A float in this field is a rounding question about someone's money. The UI converts once
     * and sends an integer; anything else is a client bug worth surfacing loudly.
     */
    for (const amount of ['0.01', '-1', '1e18', '1_000', '']) {
      expect(
        grantSessionBodySchema.safeParse({ ...valid, spend_limit_wei: amount }).success,
        `should refuse ${amount}`,
      ).toBe(false);
    }
  });

  it('refuses an unbounded duration', () => {
    // "Indefinite" is not a session. A week is the ceiling; zero is not a grant.
    expect(grantSessionBodySchema.safeParse({ ...valid, duration_minutes: 0 }).success).toBe(false);
    expect(
      grantSessionBodySchema.safeParse({ ...valid, duration_minutes: 10_081 }).success,
    ).toBe(false);
    expect(
      grantSessionBodySchema.safeParse({ ...valid, duration_minutes: 10_080 }).success,
    ).toBe(true);
  });

  it('refuses a target that is not an address', () => {
    for (const target of ['pancakeswap', '0x123', '10ED43C718714eb63d5aA57B78B54704E256024E']) {
      expect(
        grantSessionBodySchema.safeParse({ ...valid, allowed_targets: [target] }).success,
        `should refuse ${target}`,
      ).toBe(false);
    }
  });

  it('refuses a spend period the account contract does not know', () => {
    expect(
      grantSessionBodySchema.safeParse({ ...valid, spend_period: 'fortnight' }).success,
    ).toBe(false);
  });
});
