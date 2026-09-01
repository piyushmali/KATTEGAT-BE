/**
 * The slice of the AgenticCommerce kernel KATTEGAT reads.
 *
 * Hand-declared rather than imported, which needs justifying because the Altana SDK already
 * speaks to these contracts. It exports `getErc8183Job`, but that reads one job per call
 * through a client it builds itself, and indexing means reading tens of thousands. Batching
 * them through `multicall` needs the ABI as a value, and the SDK keeps its copy private.
 *
 * So this is the read half only: two view functions, no writes. The write path deliberately
 * does not use this file, it goes through the SDK's `buildHireCalls`, so the encoding of
 * anything that moves money stays the SDK's business rather than ours to keep in sync.
 */

/** Job tuple as `getJob` returns it. Field order is the kernel's, not ours to reorder. */
const jobTuple = {
  type: 'tuple',
  components: [
    { name: 'id', type: 'uint256' },
    { name: 'client', type: 'address' },
    { name: 'provider', type: 'address' },
    { name: 'evaluator', type: 'address' },
    { name: 'description', type: 'string' },
    { name: 'budget', type: 'uint256' },
    { name: 'expiredAt', type: 'uint256' },
    { name: 'status', type: 'uint8' },
    { name: 'hook', type: 'address' },
    { name: 'submittedAt', type: 'uint256' },
    { name: 'deliverable', type: 'bytes32' },
  ],
} as const;

export const commerceAbi = [
  {
    type: 'function',
    name: 'getJob',
    stateMutability: 'view',
    inputs: [{ name: 'jobId', type: 'uint256' }],
    outputs: [jobTuple],
  },
  {
    /** Highest minted job id. Ids are 1-indexed, so this is also the count. */
    type: 'function',
    name: 'jobCounter',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const;

export const policyAbi = [
  {
    /**
     * Seconds a submitted job waits before `settle` may release the escrow.
     *
     * Read rather than assumed because it differs by deployment: 7 days on mainnet, and on
     * testnet 15 minutes for the policy actually in use against 24 hours for the one the SDK
     * pins. Hardcoding any of them would misreport when a client's money actually moves.
     */
    type: 'function',
    name: 'disputeWindow',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint64' }],
  },
] as const;

export const routerAbi = [
  {
    /**
     * Whether the EvaluatorRouter will bind this policy to a job.
     *
     * Load-bearing for hiring, not a detail. Every job the SDK builds names the router as both
     * evaluator and hook, and the kernel refuses to fund a job whose hook is the router until a
     * policy is bound to it (`PolicyNotSet`). The router in turn refuses to bind a policy that
     * is not whitelisted. So a stale policy address does not degrade a hire, it stops it.
     *
     * Measured: the address in `ERC8183_ADDRESSES[56].policy` is whitelisted on mainnet and the
     * one in `[97].policy` is not whitelisted on testnet, where the router is a proxy that
     * appears to have been upgraded past it.
     */
    type: 'function',
    name: 'policyWhitelist',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
] as const;
