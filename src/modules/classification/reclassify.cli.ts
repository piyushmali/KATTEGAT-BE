import { eq, sql } from 'drizzle-orm';
import { loadEnv } from '../../config/env.js';
import { createDatabase } from '../../infrastructure/database/client.js';
import { createLogger } from '../../infrastructure/logging/logger.js';
import { agentCategories, agents } from '../../infrastructure/database/schema.js';
import { classifyAgent } from './classifier.js';

/**
 * Re-runs classification over every indexed agent.
 *
 *   pnpm reclassify
 *
 * Needed whenever the taxonomy or the classifier changes. It reads name,
 * description and capabilities straight from the database and refetches nothing —
 * which is precisely why the ingestion pipeline persists `raw_metadata` and the
 * derived capability array in the first place. Reclassifying ~19k agents takes
 * seconds instead of the hours a re-ingest would spend on HTTP.
 *
 * Categories are replaced, not merged: the classifier is deterministic, so its
 * current output is the whole truth. Merging would strand assignments from an
 * older taxonomy version on the record forever.
 */

const BATCH = 500;

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env);
  const handle = createDatabase(env);

  try {
    const [countRow] = await handle.db.select({ value: sql<number>`count(*)::int` }).from(agents);
    const total = countRow?.value ?? 0;
    logger.info({ total }, 'reclassifying indexed agents');

    let processed = 0;
    let changed = 0;
    const distribution = new Map<string, number>();

    for (let offset = 0; offset < total; offset += BATCH) {
      const rows = await handle.db
        .select({
          id: agents.id,
          name: agents.name,
          description: agents.description,
          capabilities: agents.capabilities,
        })
        .from(agents)
        .orderBy(agents.id)
        .limit(BATCH)
        .offset(offset);

      if (rows.length === 0) break;

      await handle.db.transaction(async (tx) => {
        for (const row of rows) {
          const assignments = classifyAgent({
            name: row.name,
            description: row.description,
            capabilities: row.capabilities,
          });

          const primary = assignments.find((entry) => entry.isPrimary);
          if (primary) {
            distribution.set(primary.category, (distribution.get(primary.category) ?? 0) + 1);
          }

          const existing = await tx
            .select({ category: agentCategories.category })
            .from(agentCategories)
            .where(eq(agentCategories.agentId, row.id));

          const before = existing
            .map((entry) => entry.category)
            .sort()
            .join(',');
          const after = assignments
            .map((entry) => entry.category)
            .sort()
            .join(',');
          if (before !== after) changed += 1;

          await tx.delete(agentCategories).where(eq(agentCategories.agentId, row.id));
          await tx.insert(agentCategories).values(
            assignments.map((assignment) => ({
              agentId: row.id,
              category: assignment.category,
              confidence: assignment.confidence,
              isPrimary: assignment.isPrimary,
              signals: assignment.signals,
              classifierVersion: assignment.classifierVersion,
            })),
          );
        }
      });

      processed += rows.length;
      if (processed % 2_500 === 0 || processed === total) {
        logger.info({ processed, total }, 'reclassify progress');
      }
    }

    const summary = [...distribution.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([category, count]) => `${category}=${String(count)}`)
      .join(' ');

    process.stdout.write(
      `${JSON.stringify({ processed, changed, distribution: Object.fromEntries(distribution) }, null, 2)}\n`,
    );
    logger.info({ summary }, 'reclassify complete');
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `reclassify failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
