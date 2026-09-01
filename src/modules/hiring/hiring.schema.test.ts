import { describe, expect, it } from 'vitest';
import { recordSessionBodySchema, sponsorGasBodySchema } from './hiring.schema.js';

/**
 * What the hiring boundary accepts.
 *
 * These requests report authority that already exists on chain rather than asking for it, so
 * the backend cannot be tricked into granting anything. What it *can* be tricked into is
 * displaying a session that does not exist, complete with a spend cap and a revoke button, and
 * that is what the shape checks here and the Keystore verification in the service exist to
 * prevent between them.
 *
 * Shape validation alone is not the defence: a well-formed lie still has to pass
 * `hasAuthority`. These tests cover the half that is cheap to check.
 */

const valid = {
  wallet_address: '0xb69385da73e15AAB012ffa0407B3B63AF67AF3C1',
  public_key:
    '0x04d132a504654696f32799c4457ffbe395249bde212c660da29fca2a4bd5f581f75e46b2ec09acf3a726bf9d7ebf30dc04e30e3b51076cd2b7efccef8c58dc25af',
  spend_limit_wei: '10000000000000000',
  spend_period: 'day' as const,
  allowed_targets: ['0x10ED43C718714eb63d5aA57B78B54704E256024E'],
  expires_at_unix: Math.floor(Date.now() / 1000) + 3_600,
};

describe('recordSessionBodySchema', () => {
  it('accepts a report of a bounded grant', () => {
    const parsed = recordSessionBodySchema.parse(valid);
    expect(parsed.allowed_targets).toHaveLength(1);
    expect(parsed.spend_period).toBe('day');
  });

  it('refuses an empty allowlist', () => {
    /*
     * The most important rejection. An empty `calls` array means "any target" to the Altana
     * account contract, so recording one would describe a session as scoped when it holds
     * blanket access. Refused rather than defaulted, so nothing can produce it by omission.
     */
    expect(recordSessionBodySchema.safeParse({ ...valid, allowed_targets: [] }).success).toBe(
      false,
    );

    const missing: Record<string, unknown> = { ...valid };
    delete missing.allowed_targets;
    expect(recordSessionBodySchema.safeParse(missing).success).toBe(false);
  });

  it('refuses a target that is not an address', () => {
    for (const target of ['pancakeswap', '0x123', '10ED43C718714eb63d5aA57B78B54704E256024E']) {
      expect(
        recordSessionBodySchema.safeParse({ ...valid, allowed_targets: [target] }).success,
        `should refuse ${target}`,
      ).toBe(false);
    }
  });

  it('refuses a decimal or negative spend limit, because the field is wei', () => {
    // A float here is a rounding question about a limit on someone's money.
    for (const amount of ['0.01', '-1', '1e18', '']) {
      expect(
        recordSessionBodySchema.safeParse({ ...valid, spend_limit_wei: amount }).success,
        `should refuse ${amount}`,
      ).toBe(false);
    }
  });

  it('refuses a spend period the account contract does not know', () => {
    expect(
      recordSessionBodySchema.safeParse({ ...valid, spend_period: 'fortnight' }).success,
    ).toBe(false);
  });

  it('refuses a malformed session key', () => {
    expect(recordSessionBodySchema.safeParse({ ...valid, public_key: 'abc' }).success).toBe(false);
    expect(
      recordSessionBodySchema.safeParse({ ...valid, public_key: `0x${'a'.repeat(400)}` }).success,
    ).toBe(false);
  });

  it('treats the grant transaction as optional', () => {
    /*
     * The Altana relay can confirm a grant without surfacing a receipt, so requiring a hash
     * would reject genuine sessions. Absence is a real state, not a malformed request.
     */
    expect(recordSessionBodySchema.safeParse({ ...valid, granted_tx_hash: null }).success).toBe(
      true,
    );
    const withoutHash: Record<string, unknown> = { ...valid };
    delete withoutHash.granted_tx_hash;
    expect(recordSessionBodySchema.safeParse(withoutHash).success).toBe(true);
  });

  it('refuses a transaction hash that is the wrong length', () => {
    expect(
      recordSessionBodySchema.safeParse({ ...valid, granted_tx_hash: '0xdeadbeef' }).success,
    ).toBe(false);
  });
});

describe('sponsorGasBodySchema', () => {
  it('accepts a wallet address', () => {
    expect(sponsorGasBodySchema.parse({ wallet_address: valid.wallet_address }).wallet_address).toBe(
      valid.wallet_address,
    );
  });

  it('refuses anything that is not an address', () => {
    // This value decides where funds are sent, so it is the one field worth being strict on.
    for (const value of ['', '0x', 'me', valid.public_key]) {
      expect(
        sponsorGasBodySchema.safeParse({ wallet_address: value }).success,
        `should refuse ${value}`,
      ).toBe(false);
    }
  });
});
