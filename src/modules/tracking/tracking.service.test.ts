import { describe, expect, it } from 'vitest';
import { resolveNetwork } from '../../integrations/altana/network.js';
import type { TrackedSessionRow, TrackingRepository } from './tracking.repository.js';
import { createTrackingService } from './tracking.service.js';

/**
 * Quest verification, which is the one endpoint whose wrong answer costs a user a reward.
 *
 * Two failure modes worth pinning. Reporting `complete: true` for a wallet that did not finish
 * would be a false claim to the campaign; reporting `false` for one that did would quietly deny
 * someone a prize. The second is the likelier of the two, because it is what an over-narrow
 * category match or a case-sensitive address lookup produces.
 */

const HOUR = 60 * 60 * 1000;

function session(over: Partial<TrackedSessionRow> = {}): TrackedSessionRow {
  return {
    publicKey: '0x04aa',
    agentId: '56:1',
    agentName: 'Agent One',
    walletAddress: '0x3e5F6aE430a157C2b6644CD758e2C53CD42Ef0Fc',
    spendLimitWei: '10000000000000000',
    spendPeriod: 'day',
    allowedCalls: ['0xD99D1c33F9fC3444f8101754aBC46c52416550D1'],
    grantedAt: new Date('2026-09-20T10:00:00Z'),
    grantedTxHash: '0xabc',
    expiresAt: new Date(Date.now() + HOUR),
    revokedAt: null,
    revokedTxHash: null,
    ...over,
  };
}

function repo(over: Partial<TrackingRepository> = {}): TrackingRepository {
  return {
    hiresByWallet: () => Promise.resolve([]),
    agentsByOwner: () => Promise.resolve([]),
    jobsByClient: () => Promise.resolve([]),
    categoriesFor: () => Promise.resolve(new Map()),
    lastIndexedAt: () => Promise.resolve(null),
    ...over,
  };
}

function service(over: Partial<TrackingRepository> = {}) {
  return createTrackingService({
    repository: repo(over),
    network: resolveNetwork('bnb-testnet'),
    registryChainId: 56,
    identityRegistry: '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432',
  });
}

const categoriesFor = (map: Record<string, string[]>) => () =>
  Promise.resolve(
    new Map(
      Object.entries(map).map(([agentId, list]) => [
        agentId,
        list.map((category, index) => ({ category, isPrimary: index === 0 })),
      ]),
    ),
  );

describe('trackingService.forWallet', () => {
  it('reports an untouched wallet as incomplete with every category missing', async () => {
    const result = await service().forWallet('0xdead');

    expect(result.data.quest.complete).toBe(false);
    expect(result.data.quest.categories_hired).toEqual([]);
    expect(result.data.quest.categories_missing).toHaveLength(4);
    expect(result.data.hires).toEqual([]);
  });

  it('requires all four categories AND a listed agent', async () => {
    const four = ['yield-optimization', 'grid-trading', 'rebalancing', 'health-factor-monitoring'];
    const hires = four.map((_, i) => session({ publicKey: `0x0${i}`, agentId: `56:${i}` }));
    const map = Object.fromEntries(four.map((category, i) => [`56:${i}`, [category]]));

    // All four hired, nothing listed: not complete.
    const hiredOnly = await service({
      hiresByWallet: () => Promise.resolve(hires),
      categoriesFor: categoriesFor(map),
    }).forWallet('0xabc');

    expect(hiredOnly.data.quest.hired_all_four).toBe(true);
    expect(hiredOnly.data.quest.listed_an_agent).toBe(false);
    expect(hiredOnly.data.quest.complete).toBe(false);

    // Both conditions: complete.
    const both = await service({
      hiresByWallet: () => Promise.resolve(hires),
      categoriesFor: categoriesFor(map),
      agentsByOwner: () =>
        Promise.resolve([{ agentId: '56:99', name: 'Mine', registeredAt: null }]),
    }).forWallet('0xabc');

    expect(both.data.quest.complete).toBe(true);
    expect(both.data.quest.agents_listed_count).toBe(1);
  });

  it('credits every category an agent carries, not only its primary', async () => {
    /*
     * A single agent classified as both yield and rebalancing genuinely does both. Counting only
     * the primary label would deny a wallet credit for a category it demonstrably hired in,
     * because which label ranks first is our classifier's decision and not the user's.
     */
    const result = await service({
      hiresByWallet: () => Promise.resolve([session({ agentId: '56:7' })]),
      categoriesFor: categoriesFor({ '56:7': ['yield-optimization', 'rebalancing'] }),
    }).forWallet('0xabc');

    expect(result.data.quest.categories_hired).toEqual(['yield-optimization', 'rebalancing']);
    expect(result.data.hires[0]?.primary_category).toBe('yield-optimization');
  });

  it('still credits a hire that was revoked or has expired', async () => {
    /*
     * The quest asks whether the wallet hired. Revocation is a feature this product actively
     * encourages, so withdrawing credit for using it would punish the safest behaviour.
     */
    const revoked = session({
      publicKey: '0x01',
      agentId: '56:1',
      revokedAt: new Date('2026-09-21T10:00:00Z'),
      revokedTxHash: '0xdef',
    });
    const expired = session({
      publicKey: '0x02',
      agentId: '56:2',
      expiresAt: new Date('2026-09-20T11:00:00Z'),
    });

    const result = await service({
      hiresByWallet: () => Promise.resolve([revoked, expired]),
      categoriesFor: categoriesFor({ '56:1': ['grid-trading'], '56:2': ['rebalancing'] }),
    }).forWallet('0xabc');

    expect(result.data.quest.categories_hired).toEqual(['grid-trading', 'rebalancing']);
    expect(result.data.hires.map((h) => h.status)).toEqual(['revoked', 'expired']);
  });

  it('ignores an uncategorized assignment rather than counting it as a category', async () => {
    const result = await service({
      hiresByWallet: () => Promise.resolve([session({ agentId: '56:5' })]),
      categoriesFor: categoriesFor({ '56:5': ['uncategorized'] }),
    }).forWallet('0xabc');

    expect(result.data.quest.categories_hired).toEqual([]);
    expect(result.data.hires[0]?.primary_category).toBeNull();
    expect(result.data.hires[0]?.categories).toEqual([]);
  });

  it('carries the grant transaction so a verifier need not trust us', async () => {
    const result = await service({
      hiresByWallet: () => Promise.resolve([session({ grantedTxHash: '0xfeed' })]),
    }).forWallet('0xabc');

    expect(result.data.hires[0]?.granted_tx_hash).toBe('0xfeed');
    expect(result.meta.keystore_address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('separates the hiring chain from the registry chain', async () => {
    // A verifier reading one number for both would check the wrong explorer.
    const result = await service().forWallet('0xabc');

    expect(result.meta.hiring_chain_id).toBe(97);
    expect(result.meta.registry_chain_id).toBe(56);
  });

  it('names the kernel job status rather than leaking its index', async () => {
    const result = await service({
      jobsByClient: () =>
        Promise.resolve([
          {
            id: '97:3',
            chainId: 97,
            jobId: 3,
            providerAddress: '0xprov',
            status: 1,
            budgetRaw: '0',
            lastSyncedAt: null,
          },
        ]),
    }).forWallet('0xabc');

    expect(result.data.escrow_jobs[0]?.status).toBe('FUNDED');
  });
});
