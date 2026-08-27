/**
 * Live proof that the ERC-8004 integration works against BNB Smart Chain.
 *
 * Needs no database — only an RPC endpoint. Run it whenever the registry
 * addresses, RPC config or ABI subset change:
 *
 *   pnpm verify:chain
 *
 * It fails loudly (non-zero exit) rather than printing a reassuring summary, so
 * it is usable as a smoke check in CI.
 */

import { loadEnv } from '../src/config/env.js';
import { createLogger } from '../src/infrastructure/logging/logger.js';
import { createChainReader } from '../src/integrations/erc8004/chain-reader.js';
import { classifyAgent } from '../src/modules/classification/classifier.js';

function line(label: string, value: unknown): void {
  process.stdout.write(`  ${label.padEnd(24)} ${String(value)}\n`);
}

async function main(): Promise<void> {
  // DATABASE_URL is required by the shared env contract but unused here.
  process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:5432/unused';
  process.env.LOG_LEVEL ??= 'warn';

  const env = loadEnv();
  const logger = createLogger(env);
  const reader = createChainReader({ env, logger });

  process.stdout.write('\nERC-8004 / BNB Smart Chain reachability\n');
  const name = await reader.registryName();
  const head = await reader.latestBlock();
  line('identity registry', env.ERC8004_IDENTITY_REGISTRY);
  line('registry name()', name);
  line('chain head', head);

  if (name.length === 0) {
    throw new Error('registry name() returned empty — wrong address or wrong chain');
  }

  const preferred =
    env.ERC8004_DEPLOY_BLOCK > 0
      ? env.ERC8004_DEPLOY_BLOCK
      : head - env.ERC8004_MAX_LOOKBACK_BLOCKS;
  const { fromBlock, clamped } = await reader.resolveStartBlock(preferred);
  line('start block', `${String(fromBlock)}${clamped ? ' (clamped to log retention)' : ''}`);
  line('lookback', `${String(head - fromBlock)} blocks`);

  if (clamped) {
    process.stdout.write(
      '  note: this endpoint does not serve logs as far back as requested.\n' +
        '        Set an archive-capable BSC_RPC_URL to backfill further.\n',
    );
  }

  process.stdout.write('\nScanning Registered logs\n');
  const page = await reader.discover({ fromBlock, toBlock: head });
  line('blocks scanned', `${String(fromBlock)}..${String(page.cursor)}`);
  line('agents found', page.agents.length);
  line('metadata unresolved', page.unresolved.length);

  if (page.cursor < fromBlock) {
    throw new Error('scan made no progress');
  }

  if (page.agents.length > 0) {
    const resolved = page.agents.filter((a) => a.profile.metadataResolvedAt !== null).length;
    line('metadata resolved', `${String(resolved)}/${String(page.agents.length)}`);

    // Classifying the whole window is the honest check: one hand-picked agent
    // proves nothing about the taxonomy's coverage of real registry data.
    const distribution = new Map<string, number>();
    const protocols = new Map<string, number>();
    for (const candidate of page.agents) {
      const [primary] = classifyAgent({
        name: candidate.profile.name,
        description: candidate.profile.description,
        capabilities: candidate.profile.capabilities,
      });
      const key = primary?.category ?? 'uncategorized';
      distribution.set(key, (distribution.get(key) ?? 0) + 1);
      protocols.set(
        candidate.profile.protocolTag,
        (protocols.get(candidate.profile.protocolTag) ?? 0) + 1,
      );
    }

    process.stdout.write('\nPrimary category distribution across the window\n');
    for (const [category, count] of [...distribution].sort((a, b) => b[1] - a[1])) {
      line(category, count);
    }
    process.stdout.write('\nProtocol tag distribution\n');
    for (const [tag, count] of [...protocols].sort((a, b) => b[1] - a[1])) {
      line(tag, count);
    }
  }

  const [first] = page.agents;
  if (!first) {
    process.stdout.write(
      '\nNo agents registered in the scanned window. The chain read path works — logs\n' +
        'were fetched successfully — there were simply no Registered events in this\n' +
        'range. Use an archive-capable BSC_RPC_URL to reach the full history.\n\n',
    );
    return;
  }

  process.stdout.write('\nFirst agent found\n');
  line('id', first.identity.id);
  line('owner', first.identity.ownerAddress);
  line('agentURI', first.identity.agentUri ?? '(none)');
  line('name', first.profile.name);
  line('protocol tag', first.profile.protocolTag);
  line('trait tags', first.profile.traitTags.join(', ') || '(none)');
  line('capabilities', first.profile.capabilities.join(', ') || '(none)');
  line('metadata resolved', first.profile.metadataResolvedAt !== null);

  const classification = classifyAgent({
    name: first.profile.name,
    description: first.profile.description,
    capabilities: first.profile.capabilities,
  });
  process.stdout.write('\nClassification\n');
  for (const assignment of classification) {
    line(
      assignment.isPrimary ? `${assignment.category} (primary)` : assignment.category,
      `confidence=${assignment.confidence.toFixed(2)} signals=[${assignment.signals.join(', ')}]`,
    );
  }

  process.stdout.write('\nReputation (ReputationRegistry)\n');
  const reputation = await reader.reputation(first.identity.agentId);
  if (!reputation) {
    line('reputation', 'unavailable');
  } else {
    line('feedback count', reputation.feedbackCount);
    line('client count', reputation.clientCount);
    line('raw summary', `${String(reputation.summaryValue)} @ ${String(reputation.summaryDecimals)} dp`);
    line('decoded score', reputation.score ?? '(no feedback)');
  }

  process.stdout.write('\nOK — live chain read, metadata resolution and classification all ran.\n\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`\nFAILED: ${error instanceof Error ? error.message : String(error)}\n\n`);
  process.exitCode = 1;
});
