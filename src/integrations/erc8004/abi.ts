/**
 * Minimal ERC-8004 ABI subset, transcribed from the canonical Hardhat artifacts
 * at github.com/erc-8004/erc-8004-contracts (abis/).
 *
 * Only the members KATTEGAT actually reads are included — a narrow ABI keeps
 * viem's inferred types readable and makes it obvious what this integration
 * touches. Write methods are intentionally absent: the backend never signs.
 */

export const identityRegistryAbi = [
  {
    type: 'event',
    name: 'Registered',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'agentURI', type: 'string', indexed: false },
      { name: 'owner', type: 'address', indexed: true },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'URIUpdated',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'newURI', type: 'string', indexed: false },
      { name: 'updatedBy', type: 'address', indexed: true },
    ],
    anonymous: false,
  },
  {
    type: 'function',
    name: 'tokenURI',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    // Returns the agent's declared payment wallet, or the zero address when the
    // agent never set one. Relevant to any future spend-cap / session work.
    type: 'function',
    name: 'getAgentWallet',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'name',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
] as const;

export const reputationRegistryAbi = [
  {
    type: 'function',
    name: 'getClients',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address[]' }],
  },
  {
    /**
     * Averages every non-revoked feedback entry from `clientAddresses`.
     *
     * Two behaviours matter to callers:
     *  1. It REVERTS when `clientAddresses` is empty ("clientAddresses required"),
     *     so `getClients` must be called first.
     *  2. The result is fixed-point: the real score is
     *     `summaryValue / 10 ** summaryValueDecimals`.
     */
    type: 'function',
    name: 'getSummary',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddresses', type: 'address[]' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
    ],
    outputs: [
      { name: 'count', type: 'uint64' },
      { name: 'summaryValue', type: 'int128' },
      { name: 'summaryValueDecimals', type: 'uint8' },
    ],
  },
] as const;
