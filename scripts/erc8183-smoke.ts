/**
 * Proves the ERC-8183 hire path on BSC testnet, end to end, against the live kernel.
 *
 * The companion to `altana-smoke.ts`. That one proves scoped authority exists; this one proves
 * the authority can actually commission work through the escrow rail that BNB Agent Studio runs
 * on: create a job, bind the dispute policy, fund the escrow, and read the funded job back.
 *
 * WHY THE BUDGET IS ZERO
 *
 * The escrow token is $U, whose `mint` is `Ownable`, so it cannot be obtained on testnet by
 * anyone who is not its deployer. That would make the paid path unprovable, except the protocol
 * has a zero-budget job as a first-class case: the BNBAgent SDK documents that `setBudget(id, 0)`
 * then `fund(id, 0)` moves no tokens and skips the ERC-20 approve entirely.
 *
 * So every contract call, every state transition and the whole session-signed batch is real and
 * on chain here. The only thing a funded job adds is a non-zero number inside the same `fund`
 * call. That is an honest limit of a testnet run rather than a mock: nothing below is simulated.
 *
 * Run with `pnpm erc8183:smoke`. Needs AGENT_SESSION_PRIVATE_KEY funded with testnet BNB.
 */
import { createPublicClient, formatEther, http, parseEther } from 'viem';
import {
  BNB_TESTNET,
  buildHireCalls,
  createClient,
  erc8183Addresses,
  getErc8183Job,
  hireErc8183Agent,
  signerFromPrivateKey,
  type Session,
} from '@altananetwork/sdk';

/*
 * Either key works, because both are local testnet keys and this script only needs one that
 * holds enough tBNB to pay for a batch. `AGENT_SESSION_PRIVATE_KEY` is preferred so a run can be
 * pointed at a throwaway key without touching the sponsor's, but the sponsor key is what a fresh
 * checkout already has funded, so falling back to it saves generating a second one.
 */
const privateKey =
  process.env.AGENT_SESSION_PRIVATE_KEY ?? process.env.AGENT_GAS_SPONSOR_PRIVATE_KEY;
if (privateKey === undefined || !privateKey.startsWith('0x')) {
  throw new Error(
    'Set AGENT_SESSION_PRIVATE_KEY or AGENT_GAS_SPONSOR_PRIVATE_KEY in .env. Neither is committed.',
  );
}

const TESTNET_RPCS = [
  'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
  'https://bsc-testnet-dataseed.bnbchain.org',
  'https://bsc-testnet.public.blastapi.io',
  BNB_TESTNET.publicRpcUrl,
] as const;

async function pickRpc(): Promise<string> {
  for (const url of TESTNET_RPCS) {
    try {
      const probe = createPublicClient({ chain: BNB_TESTNET.chain, transport: http(url) });
      await probe.getBlockNumber();
      return url;
    } catch {
      process.stdout.write(`   (rpc unavailable, trying next: ${url})\n`);
    }
  }
  throw new Error('no BSC testnet RPC endpoint answered');
}

/**
 * Who the job names as provider.
 *
 * Overridable with ERC8183_PROVIDER so a run can name an indexed agent's own wallet address and
 * the result can then be recorded through `POST /agents/:id/jobs`, which checks exactly that the
 * provider is the agent it is being recorded against.
 *
 * The default is a provider that already exists on testnet, so a bare run still names something
 * real rather than an address nobody controls.
 */
const PROVIDER = (process.env.ERC8183_PROVIDER ??
  '0x1614f31E3DC2FC334C4C9742DE233265591f7674') as `0x${string}`;

const SESSION_MINUTES = 30;

/** Covers the relay's fee for one batch many times over, while still being a real ceiling. */
const SPEND_CAP = parseEther('0.01');

const explorer = (hash: string): string => `${BNB_TESTNET.explorer}/tx/${hash}`;

const TASK =
  'KATTEGAT live proof: report whether an ERC-8183 job can be commissioned from a scoped session key.';

/**
 * A policy the router will actually accept, which is not always the one the SDK ships.
 *
 * The kernel refuses to fund a job whose hook is the router unless a policy is bound to it
 * (`PolicyNotSet`, 0x32d53d69), and the router refuses to bind one that is not whitelisted
 * (0xc94463e3). So a stale policy address is not a soft failure, it stops a hire outright.
 *
 * Measured: `ERC8183_ADDRESSES[56].policy` is whitelisted on mainnet, and
 * `ERC8183_ADDRESSES[97].policy` is not whitelisted on testnet. The testnet router is a proxy and
 * appears to have been upgraded past the address the SDK pins.
 *
 * Checked against the chain rather than assumed either way, so this keeps working when the SDK
 * catches up, and the fallback is a policy observed in use by a real funded job rather than a
 * guess.
 */
async function resolvePolicy(
  publicClient: ReturnType<typeof createPublicClient>,
  addresses: ReturnType<typeof erc8183Addresses>,
): Promise<{ address: `0x${string}`; whitelisted: boolean; windowSeconds: number }> {
  const whitelistAbi = [
    {
      name: 'policyWhitelist',
      type: 'function',
      stateMutability: 'view',
      inputs: [{ type: 'address' }],
      outputs: [{ type: 'bool' }],
    },
  ] as const;
  const windowAbi = [
    { name: 'disputeWindow', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  ] as const;

  /**
   * Observed bound to testnet job 500 and whitelisted as of this writing, with a 15 minute
   * dispute window rather than the SDK policy's 24 hours.
   */
  const OBSERVED_TESTNET_POLICY = '0xd6a4217588F6B1F5657a92A3e94E6422aD771cEA' as const;

  for (const candidate of [addresses.policy, OBSERVED_TESTNET_POLICY]) {
    const whitelisted = await publicClient.readContract({
      address: addresses.router,
      abi: whitelistAbi,
      functionName: 'policyWhitelist',
      args: [candidate],
    });
    if (!whitelisted) continue;

    const window = await publicClient.readContract({
      address: candidate,
      abi: windowAbi,
      functionName: 'disputeWindow',
    });
    return { address: candidate, whitelisted: true, windowSeconds: Number(window) };
  }

  return { address: addresses.policy, whitelisted: false, windowSeconds: 0 };
}

/**
 * The hire batch, built against a policy this chain accepts.
 *
 * Used when the SDK's pinned policy is not whitelisted, which makes `hireErc8183Agent` unusable
 * because it resolves addresses internally. Every call is still encoded by the SDK's own
 * `buildHireCalls`; the only change is which policy address goes into `registerJob`.
 */
async function hireWithResolvedPolicy({
  client,
  session,
  addresses,
  publicClient,
  windowSeconds,
}: {
  client: ReturnType<typeof createClient>;
  session: Session;
  addresses: ReturnType<typeof erc8183Addresses>;
  publicClient: ReturnType<typeof createPublicClient>;
  windowSeconds: number;
}): Promise<{ jobId: bigint; budget: bigint; expiredAt: bigint; transactionHash?: string }> {
  const counter = await publicClient.readContract({
    address: addresses.commerce,
    abi: [
      { name: 'jobCounter', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
    ],
    functionName: 'jobCounter',
  });

  const jobId = counter + 1n;
  // Must clear the dispute window, or the job could never be submitted against in time.
  const expiredAt = BigInt(Math.floor(Date.now() / 1000)) + BigInt(windowSeconds) + 1800n;

  const calls = buildHireCalls({
    addresses,
    jobId,
    provider: PROVIDER,
    description: TASK,
    budget: 0n,
    expiredAt,
  });

  const result = await client.execute({ session, calls });

  return {
    jobId,
    budget: 0n,
    expiredAt,
    ...(result.transactionHash === undefined ? {} : { transactionHash: result.transactionHash }),
  };
}

async function main(): Promise<void> {
  const rpcUrl = await pickRpc();
  const network = { ...BNB_TESTNET, publicRpcUrl: rpcUrl };
  const addresses = erc8183Addresses(network.chainId);

  const admin = signerFromPrivateKey(privateKey as `0x${string}`);
  const publicClient = createPublicClient({ chain: network.chain, transport: http(rpcUrl) });
  const balance = await publicClient.getBalance({ address: admin.address });

  process.stdout.write('ERC-8183 hire, live on BSC testnet\n\n');
  process.stdout.write(`admin    ${admin.address} (${formatEther(balance)} tBNB)\n`);
  process.stdout.write(`commerce ${addresses.commerce}\n`);
  process.stdout.write(`token    ${addresses.paymentToken}\n`);
  process.stdout.write(`rpc      ${rpcUrl}\n\n`);

  if (balance === 0n) {
    throw new Error(`${admin.address} has no testnet BNB. Fund it at https://testnet.bnbchain.org/faucet-smart`);
  }

  const client = createClient({ chains: [network] });

  const wallet = await client.createWallet({ signer: admin });
  process.stdout.write(`1. wallet     ${wallet.address}\n`);

  /*
   * The session's allowlist is the whole point of doing this through a session rather than the
   * admin key. Three targets, because a hire touches three contracts: the kernel that holds the
   * escrow, the router that binds the policy, and the payment token it approves. Naming them
   * explicitly means this key can commission work and do nothing else.
   */
  const expiry = Math.floor(Date.now() / 1000) + SESSION_MINUTES * 60;
  const session = await client.grantSession({
    wallet,
    signer: admin,
    permissions: {
      /*
       * A native allowance is required even though a hire moves no native token and this job's
       * budget is zero.
       *
       * Learned the hard way: granting `limit: 0n` produced `ExceededSpendLimit(address)`
       * (0x9054c912) from the relay before any call ran. The relay fronts gas and accounts for
       * its fee against the session's native spend limit, so a session with a zero allowance can
       * be perfectly scoped and still unable to do anything.
       *
       * It matters beyond this script: the hiring UI has to ask for a native allowance that
       * covers relay fees, not just for permission to call the escrow contracts.
       */
      spend: [{ limit: SPEND_CAP, period: 'day' }],
      calls: [
        { to: addresses.commerce },
        { to: addresses.router },
        { to: addresses.paymentToken },
      ],
    },
    expiry,
    register: true,
  });

  process.stdout.write(
    `2. session    key ${session.publicKey.slice(0, 26)}…\n` +
      `              scoped to commerce, router and token only\n`,
  );
  if (session.transactionHash) {
    process.stdout.write(`              ${explorer(session.transactionHash)}\n`);
  }

  /*
   * Whether this deployment will accept the policy the SDK is built around.
   *
   * Checked rather than assumed, because it differs by chain and it decides whether the full
   * batch can run. Measured: the policy in `ERC8183_ADDRESSES` is whitelisted on mainnet (56)
   * and is NOT whitelisted on testnet (97), so `registerJob` reverts there with 0xc94463e3.
   *
   * Live testnet jobs agree that this is the deployment's state and not our mistake: job 855
   * has `jobPolicy` set to the zero address, so it was funded and delivered without ever
   * binding a policy.
   */
  const policy = await resolvePolicy(publicClient, addresses);

  process.stdout.write(
    `3. policy     ${policy.address}\n` +
      `              whitelisted ${String(policy.whitelisted)}, dispute window ${policy.windowSeconds}s` +
      `${policy.address === addresses.policy ? '' : ' (SDK default is not whitelisted here)'}\n`,
  );

  if (!policy.whitelisted) {
    process.stdout.write(
      '\nFAIL: no whitelisted policy found on this chain, so registerJob cannot bind one and\n' +
        'the kernel refuses to fund a job whose hook is the router (PolicyNotSet).\n',
    );
    process.exitCode = 1;
    return;
  }

  /*
   * The hire. Five calls batched into one atomic relay intent, signed by the session key:
   * createJob, registerJob, setBudget, approve, fund. If any of them reverts, none of them
   * happened, so a half-created job is not a state this can produce.
   *
   * On a chain whose router accepts the policy this is `hireErc8183Agent` unchanged. Where it
   * does not, the same SDK-built calls are used with the one router call dropped: every call
   * that touches a job or a token is still encoded by the SDK rather than by hand here, because
   * hand-encoding anything that moves money to work around a deployment issue is how a
   * workaround becomes a loss.
   */
  const hired =
    policy.address === addresses.policy
      ? await hireErc8183Agent(
          session,
          { provider: PROVIDER, task: TASK, budget: 0n, deadlineSeconds: 1800 },
          { network },
        )
      : await hireWithResolvedPolicy({
          client,
          session,
          addresses: { ...addresses, policy: policy.address },
          publicClient,
          windowSeconds: policy.windowSeconds,
        });

  process.stdout.write(
    `4. hired      job ${hired.jobId} for ${hired.budget} raw $U\n` +
      `              expires ${new Date(Number(hired.expiredAt) * 1000).toISOString()}\n`,
  );
  if (hired.transactionHash) {
    process.stdout.write(`              ${explorer(hired.transactionHash)}\n`);
  }

  /*
   * Read back from the kernel rather than trusting the relay's answer. This is the same call the
   * backend indexer makes, so a pass here also confirms the indexer would see this job.
   */
  const job = await getErc8183Job(network, hired.jobId);

  process.stdout.write(
    `5. on chain   status ${job.statusName}\n` +
      `              client   ${job.client}\n` +
      `              provider ${job.provider}\n` +
      `              budget   ${job.budget} raw\n`,
  );

  const clientMatches = job.client.toLowerCase() === wallet.address.toLowerCase();
  const providerMatches = job.provider.toLowerCase() === PROVIDER.toLowerCase();

  if (job.statusName !== 'FUNDED' || !clientMatches || !providerMatches) {
    process.stdout.write(
      `\nFAIL: expected a FUNDED job from ${wallet.address} to ${PROVIDER}, got ` +
        `${job.statusName} from ${job.client} to ${job.provider}.\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    '\nPASS: a session key scoped to three contracts commissioned an escrowed job on the\n' +
      'live ERC-8183 kernel, and the kernel agrees who the client and provider are.\n' +
      `Verify: ${BNB_TESTNET.explorer}/address/${addresses.commerce}\n`,
  );
}

await main();
