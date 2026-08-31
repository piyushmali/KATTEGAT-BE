import { relations } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * KATTEGAT marketplace schema.
 *
 * Deliberately small. Four tables cover the whole bootstrap: the normalised
 * agent record, the categories KATTEGAT derives for it, the reputation snapshot
 * read from chain, and the ingestion cursor. Hiring, sessions, permissions and
 * comparisons are real product concepts but have no MVP behaviour yet, so they
 * are documented in docs/data-model.md rather than created empty here.
 */

/*
 * The category and protocol vocabularies live with the layers that own them —
 * modules/classification/taxonomy.ts derives the categories, and
 * integrations/erc8004/registration-file.ts derives the protocol tags. They are
 * deliberately not restated here: a schema module holding its own copy of a domain
 * enum is exactly how the two drift apart.
 *
 * Both columns are plain `text` rather than a Postgres enum, so adding a category
 * needs no migration — only a change to the taxonomy.
 */

export const agents = pgTable(
  'agents',
  {
    /**
     * `${chainId}:${agentId}` — the agent id is only unique per chain, and a
     * single opaque string keeps every route, cache key and foreign key simple.
     */
    id: text('id').primaryKey(),

    chainId: integer('chain_id').notNull(),
    /**
     * ERC-8004 agent id. On-chain type is uint256, but ids are minted from a
     * sequential counter so a signed 64-bit column is ample.
     * ponytail: ceiling is 2^53 once read back as a JS number; if agent ids ever
     * become non-sequential (e.g. hash-derived), switch to `numeric` + string mode.
     */
    agentId: bigint('agent_id', { mode: 'number' }).notNull(),

    ownerAddress: text('owner_address').notNull(),
    /** Resolved payment wallet from `getAgentWallet`, when the agent set one. */
    walletAddress: text('wallet_address'),
    /** `tokenURI` pointing at the off-chain registration file. */
    agentUri: text('agent_uri'),

    name: text('name').notNull(),
    description: text('description'),

    protocolTag: text('protocol_tag').notNull().default('unconfigured'),
    traitTags: text('trait_tags').array().notNull().default([]),
    /** Capability/skill names lifted out of the registration file. */
    capabilities: text('capabilities').array().notNull().default([]),

    /**
     * The registration file as fetched, unmodified. Keeping the raw document
     * means a mapper fix can be replayed without re-fetching every URI.
     */
    rawMetadata: jsonb('raw_metadata'),

    registeredAtBlock: bigint('registered_at_block', { mode: 'number' }),
    registeredAt: timestamp('registered_at', { withTimezone: true }),

    /** Which integration produced this row — see integrations/agent-source.ts. */
    source: text('source').notNull(),
    /** Null until the registration file resolves; drives the "partial data" UI. */
    metadataResolvedAt: timestamp('metadata_resolved_at', { withTimezone: true }),

    /*
     * How many times fetching this agent's registration file has failed.
     *
     * Exists because the backlog pass could otherwise never make progress. It used to
     * select unresolved agents by ascending id, and the low ids hold a wall of
     * permanently broken URIs (one serves an HTML page, another a Google Apps Script
     * redirect), so every pass re-attempted the same dead rows: 479 of 480 fetches
     * failed. Ordering by attempt count lets repeat failures sink to the back while
     * genuinely pending agents get reached.
     *
     * Counted rather than flagged, so a transient outage is still retried later instead of
     * being written off permanently on one bad night.
     */
    metadataAttempts: integer('metadata_attempts').notNull().default(0),
    metadataAttemptedAt: timestamp('metadata_attempted_at', { withTimezone: true }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }).notNull().defaultNow(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('agents_chain_agent_idx').on(table.chainId, table.agentId),
    index('agents_owner_idx').on(table.ownerAddress),
    index('agents_protocol_idx').on(table.protocolTag),
    index('agents_registered_at_idx').on(table.registeredAt),
    /*
     * Serves the backlog pass's exact select order. Partial on the unresolved rows
     * because that is the only slice it reads, which keeps it a fraction of the size of
     * a full index and means resolving an agent removes its entry rather than updating it.
     */
    index('agents_metadata_backlog_idx')
      .on(table.metadataAttempts, table.agentId.desc())
      .where(sql`${table.metadataResolvedAt} is null`),
  ],
);

/**
 * Classification output. A row per (agent, category) because an agent legitimately
 * spans categories — a vault agent can rebalance *and* chase yield — and each
 * assignment carries its own confidence and evidence.
 */
export const agentCategories = pgTable(
  'agent_categories',
  {
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    category: text('category').notNull(),
    /** 0..1. Surfaced in the UI; never presented as a precise measurement. */
    confidence: real('confidence').notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    /**
     * Human-readable reasons the classifier matched, e.g.
     * `['capability:rebalance', 'keyword:drift threshold']`. This is what makes
     * the "Why this agent?" panel truthful rather than a black box.
     */
    signals: text('signals').array().notNull().default([]),
    classifierVersion: text('classifier_version').notNull(),
    classifiedAt: timestamp('classified_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.category] }),
    index('agent_categories_category_idx').on(table.category, table.confidence),
    index('agent_categories_primary_idx').on(table.isPrimary, table.category),
  ],
);

/**
 * Reputation snapshot read from the ERC-8004 ReputationRegistry.
 *
 * KATTEGAT does not invent a score. `getSummary` returns the average of all
 * non-revoked client feedback as a fixed-point integer plus its decimal
 * exponent, and both halves are stored verbatim so the value can be rendered
 * exactly. Deriving a single float here would bake in a rounding decision the
 * API consumer cannot undo.
 */
export const agentReputation = pgTable('agent_reputation', {
  agentId: text('agent_id')
    .primaryKey()
    .references(() => agents.id, { onDelete: 'cascade' }),

  /** Count of non-revoked feedback entries included in the summary. */
  feedbackCount: integer('feedback_count').notNull().default(0),
  /** Distinct clients that have ever left feedback — the anti-sybil signal. */
  clientCount: integer('client_count').notNull().default(0),

  /** Raw fixed-point average; real value is `summaryValue / 10^summaryDecimals`. */
  summaryValue: bigint('summary_value', { mode: 'number' }),
  summaryDecimals: integer('summary_decimals'),

  source: text('source').notNull(),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Ingestion cursor, one row per (chain, registry).
 *
 * Required rather than optional: the identity registry is not ERC721Enumerable,
 * so the only way to discover agents is replaying `Registered` logs, and that
 * needs a durable "how far did I get" marker to stay incremental.
 */
export const syncState = pgTable('sync_state', {
  /** e.g. `56:identity`. */
  id: text('id').primaryKey(),
  lastBlock: bigint('last_block', { mode: 'number' }).notNull().default(0),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  /** Retained so /health can report a degraded integration instead of hiding it. */
  lastError: text('last_error'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
});

/**
 * Authority granted to an agent through an Altana session key.
 *
 * The record of a hire. Every row corresponds to a real on-chain grant: the limits below
 * are enforced by the Altana account contract, not by this table, and the session key is
 * registered in the public Keystore so anyone can verify the authority without asking us.
 * This is the local index of that, so the marketplace can show a user what they granted and
 * offer to take it back.
 *
 * Nothing here is the source of truth. If this table and the Keystore disagree, the chain is
 * right. It exists because reading every session back from chain to render one page would be
 * slow, not because the chain needs our help remembering.
 */
export const agentSessions = pgTable(
  'agent_sessions',
  {
    /**
     * The session key's public key, which is how revocation identifies it on chain.
     *
     * The primary key, because the chain already treats it as the identifier and inventing
     * a second one would leave two ways to name the same authority.
     */
    publicKey: text('public_key').primaryKey(),

    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),

    /** The account the session can act on. */
    walletAddress: text('wallet_address').notNull(),

    /**
     * Spend ceiling in wei, stored as text.
     *
     * Wei exceeds what a JS number holds exactly, and this value is only ever displayed or
     * compared for equality, never summed. `numeric` would order correctly but invite the
     * float conversion the text avoids.
     */
    spendLimitWei: text('spend_limit_wei').notNull(),
    /** Rolling window the ceiling applies over: minute, hour, day, week, month, year. */
    spendPeriod: text('spend_period').notNull(),

    /**
     * Call allowlist as granted, one row per permitted target or signature.
     *
     * Empty means the grant named no call restriction, which the SDK treats as "any target".
     * Recorded as empty rather than as a wildcard string, so the UI can say plainly that no
     * call restriction was set instead of implying one that reads as permissive.
     */
    allowedCalls: text('allowed_calls').array().notNull().default([]),

    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

    /** The grant transaction, when the relay surfaced a receipt for it. */
    grantedTxHash: text('granted_tx_hash'),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),

    /** Set when the owner revoked. Null while the session is still live. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedTxHash: text('revoked_tx_hash'),

    /**
     * Which chain, and therefore how much this means.
     *
     * 97 is BSC testnet, which is what the sandbox grants on. Stored so a mainnet session can
     * never be rendered with the same weight as a testnet one by accident.
     */
    chainId: integer('chain_id').notNull(),
  },
  (table) => [
    index('agent_sessions_agent_idx').on(table.agentId, table.grantedAt),
    /* Serves the "what is still live" query, which is the only one the UI runs hot. */
    index('agent_sessions_live_idx').on(table.expiresAt).where(sql`${table.revokedAt} is null`),
  ],
);

export const agentsRelations = relations(agents, ({ many, one }) => ({
  categories: many(agentCategories),
  reputation: one(agentReputation, {
    fields: [agents.id],
    references: [agentReputation.agentId],
  }),
}));

export const agentCategoriesRelations = relations(agentCategories, ({ one }) => ({
  agent: one(agents, { fields: [agentCategories.agentId], references: [agents.id] }),
}));

export const agentReputationRelations = relations(agentReputation, ({ one }) => ({
  agent: one(agents, { fields: [agentReputation.agentId], references: [agents.id] }),
}));

export type AgentRow = typeof agents.$inferSelect;
export type NewAgentRow = typeof agents.$inferInsert;
export type AgentCategoryRow = typeof agentCategories.$inferSelect;
export type AgentReputationRow = typeof agentReputation.$inferSelect;
export type SyncStateRow = typeof syncState.$inferSelect;
export type AgentSessionRow = typeof agentSessions.$inferSelect;
export type NewAgentSessionRow = typeof agentSessions.$inferInsert;
