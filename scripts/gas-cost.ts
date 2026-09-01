/**
 * What the hire lifecycle actually costs in gas.
 *
 * Written because "who pays gas" is a business question that deserves a measurement rather
 * than an estimate. Reads the receipts of the transactions the smoke test and the hiring API
 * already produced on BSC testnet, and prices the same gas at mainnet rates.
 */
import { createPublicClient, formatEther, formatGwei, http, type Hex } from 'viem';
import { bsc, bscTestnet } from 'viem/chains';

/** Real transactions from the grant / act / revoke lifecycle. */
const LIFECYCLE: { label: string; hash: Hex }[] = [
  { label: 'grant session', hash: '0xdba6930fcf213569490699779d7d811324208ecac0419cfb6254c4c29de11617' },
  { label: 'act via session', hash: '0xa9ce4d4b9a2b569b31d2a3660cc458baec25078ce1739756f33751d96a044343' },
  { label: 'revoke session', hash: '0x27a855c77889ef6f16836892fdbf53b4ba8f0df724145bdc69acfc8a4c51574f' },
  { label: 'grant (via API)', hash: '0x9230a9eca1d44f46b271f8ec082f14aa528945c9bba8645f25a502c31b1a3bbb' },
  { label: 'revoke (via API)', hash: '0xe86f6bd552adafb52b635f7a58239d74e6ef1729abd153faaf8a755687578ede' },
];

const testnet = createPublicClient({
  chain: bscTestnet,
  transport: http('https://data-seed-prebsc-1-s1.bnbchain.org:8545'),
});
const mainnet = createPublicClient({ chain: bsc, transport: http('https://bsc-dataseed.bnbchain.org') });

async function main(): Promise<void> {
  const mainnetGasPrice = await mainnet.getGasPrice();
  process.stdout.write(`BSC mainnet gas price: ${formatGwei(mainnetGasPrice)} gwei\n\n`);

  let totalGas = 0n;
  let lifecycleGas = 0n;

  for (const entry of LIFECYCLE) {
    try {
      const receipt = await testnet.getTransactionReceipt({ hash: entry.hash });
      const spentTestnet = receipt.gasUsed * receipt.effectiveGasPrice;
      totalGas += receipt.gasUsed;
      // The first three are one complete lifecycle.
      if (LIFECYCLE.indexOf(entry) < 3) lifecycleGas += receipt.gasUsed;

      process.stdout.write(
        `${entry.label.padEnd(18)} gas ${receipt.gasUsed.toString().padStart(8)}  ` +
          `testnet ${formatEther(spentTestnet)} tBNB  ` +
          `at mainnet rate ${formatEther(receipt.gasUsed * mainnetGasPrice)} BNB\n`,
      );
    } catch {
      process.stdout.write(`${entry.label.padEnd(18)} receipt unavailable\n`);
    }
  }

  const atMainnet = lifecycleGas * mainnetGasPrice;
  process.stdout.write(
    `\none full lifecycle (grant + act + revoke): ${lifecycleGas.toString()} gas\n` +
      `  at current mainnet gas price: ${formatEther(atMainnet)} BNB\n`,
  );

  /*
   * Priced in dollars at a few BNB levels rather than fetching a live quote, so the number
   * stays readable if the price moves and so nothing here depends on a price oracle.
   */
  for (const bnbUsd of [400, 600, 900]) {
    const usd = Number(formatEther(atMainnet)) * bnbUsd;
    process.stdout.write(`  at BNB $${String(bnbUsd)}: $${usd.toFixed(4)} per hire\n`);
  }

  process.stdout.write(`\ntotal gas across all ${String(LIFECYCLE.length)} measured txs: ${totalGas.toString()}\n`);
}

await main();
