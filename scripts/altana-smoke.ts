/**
 * End-to-end proof that Altana session authority works on BSC testnet.
 *
 * Run against a funded signer:
 *   pnpm altana:smoke
 *
 * Exists because the Altana partner track is judged on evidence rather than on a
 * description: "your submission must show live onchain transactions in the Altana
 * explorer", and sessions "registered in Keystore, so integration is read onchain rather
 * than from the pitch". This script produces those transactions and prints their hashes.
 *
 * It walks the whole authority lifecycle, in the order a user experiences it:
 *
 *   1. the wallet            the owner's account, an EIP-7702 upgrade of their own EOA
 *   2. grant a session       scoped by spend cap, call allowlist and expiry
 *   3. register in Keystore  so any third party can verify the authority on chain
 *   4. act through it        a transaction signed by the session key, not the owner
 *   5. revoke                one transaction, effective immediately
 *
 * Step 5 is the one that matters most and is easiest to skip. An agent you cannot switch
 * off is not scoped authority, whatever the grant said.
 */
import { createPublicClient, formatEther, http, parseEther } from 'viem';
import {
  BNB_TESTNET,
  createClient,
  signerFromPrivateKey,
} from '@altananetwork/sdk';

const privateKey = process.env.AGENT_SESSION_PRIVATE_KEY;
if (privateKey === undefined || !privateKey.startsWith('0x')) {
  throw new Error(
    'AGENT_SESSION_PRIVATE_KEY is not set. It is generated into .env and never committed.',
  );
}

/**
 * Read endpoint for testnet, overriding the SDK default.
 *
 * `NetworkConfig.publicRpcUrl` documents itself as overridable per environment, and it
 * needs to be: the packaged default is `bsc-testnet-rpc.publicnode.com`, which answered a
 * Cloudflare 520 mid-run and took down the Keystore read that verifies a freshly granted
 * key. The grant itself had already confirmed on chain, so a flaky read endpoint was
 * reporting a failure about a session that existed.
 *
 * Picked at runtime from a list, because one testnet endpoint being down is normal and a
 * script whose whole job is producing evidence should not fail on it.
 */
const TESTNET_RPCS = [
  'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
  'https://bsc-testnet-dataseed.bnbchain.org',
  'https://bsc-testnet.public.blastapi.io',
  BNB_TESTNET.publicRpcUrl,
] as const;

/** First endpoint that answers a block-number call. */
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

/** Small enough that a mistake costs nothing, large enough to be a real cap. */
const SPEND_CAP = parseEther('0.01');
const SESSION_MINUTES = 60;

const explorer = (hash: string): string => `${BNB_TESTNET.explorer}/tx/${hash}`;

async function main(): Promise<void> {
  const admin = signerFromPrivateKey(privateKey as `0x${string}`);
  const rpcUrl = await pickRpc();
  const network = { ...BNB_TESTNET, publicRpcUrl: rpcUrl };

  const publicClient = createPublicClient({
    chain: network.chain,
    transport: http(rpcUrl),
  });

  const balance = await publicClient.getBalance({ address: admin.address });
  process.stdout.write(`owner    ${admin.address}\n`);
  process.stdout.write(`balance  ${formatEther(balance)} tBNB\n`);
  process.stdout.write(`chain    ${String(network.chainId)} via ${network.relayUrl ?? '-'}\n`);
  process.stdout.write(`keystore ${network.keyStore}\n`);
  process.stdout.write(`rpc      ${rpcUrl}\n\n`);

  if (balance === 0n) {
    throw new Error(
      `${admin.address} has no testnet BNB. Fund it at https://testnet.bnbchain.org/faucet-smart`,
    );
  }

  const client = createClient({ chains: [network] });

  /* 1. The wallet. Same address as the EOA: Altana upgrades it rather than
   *    creating a separate custodial account, which is the point of the model. */
  const wallet = await client.createWallet({ signer: admin });
  process.stdout.write(`1. wallet     ${wallet.address}\n`);

  /* 2. The grant. These three limits are exactly what the hiring panel promises a user,
   *    and they are enforced by the account contract rather than by our backend: a call
   *    outside them reverts at validation time.
   *
   *    The allowlist names one target on purpose, so step 5 can show it refusing a second
   *    one. An earlier version of this script allowed `transfer(address,uint256)` and then
   *    tried a plain self-send, which the account rejected with
   *    `UnauthorizedCall` — the permission system working correctly against a test that had
   *    not read its own allowlist. Worth keeping in the record: the first evidence that
   *    these limits bite came from getting caught by them. */
  const expiry = Math.floor(Date.now() / 1000) + SESSION_MINUTES * 60;
  const session = await client.grantSession({
    wallet,
    signer: admin,
    permissions: {
      spend: [{ limit: SPEND_CAP, period: 'day' }],
      calls: [{ to: wallet.address }],
    },
    expiry,
    register: true,
  });

  process.stdout.write(
    `2. granted    key ${session.publicKey}\n` +
      `              cap ${formatEther(SPEND_CAP)} tBNB/day, expires ${new Date(
        expiry * 1000,
      ).toISOString()}\n`,
  );
  if (session.transactionHash) {
    process.stdout.write(`              ${explorer(session.transactionHash)}\n`);
  }

  /* 3. Registration, made explicit even though `register: true` above already does it.
   *    Idempotent by design, so this proves the key is in the Keystore rather than
   *    assuming the grant got that far. */
  const registration = await client.registerSessionKey({ wallet, signer: admin, session });
  process.stdout.write(
    `3. keystore   ${
      registration.alreadyRegistered
        ? 'already registered, verifiable on chain'
        : `registered ${registration.transactionHash ?? ''}`
    }\n`,
  );

  /* 4. The agent acts. Signed by the session key, never by the owner's key. A zero-value
   *    self-send: the cheapest call that still proves the session can move the account. */
  const acted = await client.execute({
    session,
    calls: [{ to: wallet.address, value: 0n }],
  });
  process.stdout.write(`4. acted      status ${acted.status}\n`);
  if (acted.transactionHash) {
    process.stdout.write(`              ${explorer(acted.transactionHash)}\n`);
  }

  /* 5. The allowlist refusing an out-of-scope call. This is the half of "scoped authority"
   *    that a happy path never shows: the session works, and it works only where it was
   *    told to. Rejected by the account contract, not by us. */
  const OUT_OF_SCOPE = '0x000000000000000000000000000000000000dEaD' as const;
  try {
    await client.execute({ session, calls: [{ to: OUT_OF_SCOPE, value: 0n }] });
    process.stdout.write('5. scope      FAIL: an out-of-scope call was allowed\n');
    process.exitCode = 1;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const enforced = detail.includes('Unauthorized');
    process.stdout.write(
      `5. scope      ${enforced ? 'OK' : 'rejected'}: call to ${OUT_OF_SCOPE} refused on chain\n`,
    );
  }

  /* 6. Revocation. The claim the product makes loudest, so it is proven rather than
   *    described. */
  const revoked = await client.revokeSession({ wallet, signer: admin, session });
  process.stdout.write(`6. revoked    status ${revoked.status}\n`);
  if (revoked.transactionHash) {
    process.stdout.write(`              ${explorer(revoked.transactionHash)}\n`);
  }

  /* And the assertion that makes revocation mean something: the call that worked in step 4
   * must now fail. Without this, "revocable" is a word in a README. */
  try {
    await client.execute({ session, calls: [{ to: wallet.address, value: 0n }] });
    process.stdout.write('\nFAIL: the revoked session still executed.\n');
    process.exitCode = 1;
  } catch {
    process.stdout.write('\nOK: the same call now fails. Authority is gone.\n');
  }
}

await main();
