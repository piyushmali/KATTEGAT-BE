/**
 * The category vocabulary, and the single source of truth for it.
 *
 * Declared here rather than in the database schema because a category is a domain
 * concept that happens to be persisted, not a persistence concept. Everything else
 * derives from this list: the Drizzle column, the Zod enums on the wire, the
 * classifier and the search intent parser. Adding a fifth category is a one-line
 * change here, and nothing can silently disagree about what the valid values are.
 */
export const AGENT_CATEGORIES = [
  /*
   * The four BNB Agent Studio launch categories. Declared first, and that order is
   * load-bearing: the classifier breaks a score tie toward the earlier rule, so a
   * grid-trading agent can never be absorbed by the broader `trading-execution`
   * bucket below.
   */
  'rebalancing',
  'grid-trading',
  'yield-optimization',
  'health-factor-monitoring',

  /*
   * Categories added after measuring what is actually registered on BNB Smart
   * Chain. Indexing ~19k agents showed the four DeFi categories match well under
   * 1% of them, while thousands of trading, research, automation, security, code
   * and content agents were being dumped into `uncategorized`.
   *
   * These are derived by exactly the same deterministic rules as the launch four —
   * no invented data, and every assignment still ships its signals. See
   * docs/decisions.md for the measurements behind each one.
   */
  'trading-execution',
  'research-analytics',
  'automation-operations',
  'security-verification',
  'code-smart-contracts',
  'content-media',

  /*
   * Added in v3 after measuring the uncategorized bucket rather than guessing at it.
   *
   * 2,317 indexed agents describe themselves as scoring or voting on AI model outputs
   * to earn a reward — the single largest coherent cluster in the whole registry, and
   * nothing in the taxonomy came close to it (`no-signal-match`, not a weak match). It
   * is evaluation work, not execution and not research, so forcing it into an existing
   * bucket would have been a worse answer than the `uncategorized` it was getting.
   */
  'model-evaluation',

  /** Indexed but not confidently placed. Deliberately visible, never hidden. */
  'uncategorized',
] as const;

export type AgentCategory = (typeof AGENT_CATEGORIES)[number];

/**
 * The marketplace taxonomy.
 *
 * ERC-8004 carries no category field — the registries describe *protocols*
 * (a2a, mcp, http-api) and *traits* (x402-paid, multichain), not what an agent
 * does for a user. Mapping registry data onto the four categories the
 * marketplace browses by is therefore work KATTEGAT has to do itself, and this
 * table is the whole definition of that mapping.
 *
 * All four categories are peers. Nothing here privileges one over another: they
 * share the same rule shape, the same weights and the same thresholds, so adding
 * a fifth category is a data change, not a code change.
 */

export interface CategoryRule {
  category: Exclude<AgentCategory, 'uncategorized'>;
  label: string;
  description: string;
  /**
   * Matched against declared capability/skill identifiers. Strongest evidence,
   * because a skill list is a deliberate machine-readable claim rather than
   * marketing prose.
   */
  capabilityTerms: string[];
  /** Multi-word phrases in the name or description. Strong evidence. */
  phrases: string[];
  /** Single terms. Weak on their own; meaningful in combination. */
  keywords: string[];
  /**
   * Terms that argue against the category despite a keyword hit — e.g. an agent
   * that merely *reports* yields is not a yield optimiser.
   */
  counterKeywords: string[];
}

export const CATEGORY_RULES: readonly CategoryRule[] = [
  {
    category: 'rebalancing',
    label: 'Rebalancing',
    description:
      'Monitors a portfolio against a target allocation and trades it back into line when weights drift.',
    capabilityTerms: [
      'rebalance',
      'rebalancing',
      'portfolio-rebalance',
      'portfolio_rebalance',
      'allocation',
      'asset-allocation',
      'index-rebalance',
    ],
    phrases: [
      'rebalanc',
      'target allocation',
      'asset allocation',
      'portfolio allocation',
      'portfolio weight',
      'drift threshold',
      'allocation drift',
      'target weight',
      'threshold band',
    ],
    keywords: ['rebalance', 'reallocate', 'allocation', 'portfolio', 'drift', 'weighting'],
    counterKeywords: [],
  },
  {
    category: 'grid-trading',
    label: 'Grid Trading',
    description:
      'Places a ladder of staggered orders across a price range and works the range as the market oscillates.',
    /*
     * Deliberately no bare `grid`. The OASF skill taxonomy real agents publish
     * includes `energy/smart_grids`, which has nothing to do with trading — a
     * one-word `grid` term matched six unrelated agents before this was tightened.
     */
    capabilityTerms: [
      'grid-trading',
      'grid_trading',
      'grid-bot',
      'grid-strategy',
      'range-trading',
      'market-making',
    ],
    phrases: [
      'grid trading',
      'grid bot',
      'grid strategy',
      'grid level',
      'grid order',
      'price grid',
      'range trading',
      'range-bound',
      'order ladder',
      'ladder of orders',
    ],
    keywords: ['grid', 'ladder', 'spread', 'market-making', 'oscillat'],
    counterKeywords: ['power grid', 'energy grid', 'grid computing'],
  },
  {
    category: 'yield-optimization',
    label: 'Yield Optimization',
    description:
      'Finds and rotates capital toward the strongest risk-adjusted yield, compounding rewards along the way.',
    capabilityTerms: [
      'yield',
      'yield-optimization',
      'yield_optimization',
      'yield-farming',
      'autocompound',
      'auto-compound',
      'vault',
      'staking',
      'liquidity-provision',
    ],
    phrases: [
      'yield optimi',
      'yield farm',
      'yield aggregat',
      'yield strateg',
      'best yield',
      'highest apy',
      'auto-compound',
      'auto compound',
      'compound reward',
      'vault strateg',
      'liquidity mining',
      'risk-adjusted yield',
    ],
    keywords: ['yield', 'apy', 'apr', 'farming', 'compounding', 'staking', 'vault', 'lp'],
    // A dashboard that merely surfaces APYs is discovery, not optimisation.
    counterKeywords: ['read-only', 'dashboard only', 'informational only'],
  },
  {
    category: 'health-factor-monitoring',
    label: 'Health Factor Monitoring',
    description:
      'Watches leveraged lending positions and acts or warns before liquidation risk becomes critical.',
    capabilityTerms: [
      'health-factor',
      'health_factor',
      'healthfactor',
      'liquidation-protection',
      'collateral',
      'ltv',
      'loan-to-value',
      'deleverage',
      'debt-management',
    ],
    phrases: [
      'health factor',
      'liquidation risk',
      'liquidation protection',
      'avoid liquidation',
      'prevent liquidation',
      'collateral ratio',
      'collateralization ratio',
      'loan-to-value',
      'loan to value',
      'margin call',
      'top up collateral',
      'repay debt',
      'deleverag',
    ],
    keywords: ['liquidation', 'collateral', 'borrow', 'lending', 'ltv', 'debt', 'leverage'],
    counterKeywords: [],
  },

  /* ------------------------------------------------------------------------ *
   * Ecosystem categories.
   *
   * Everything below was added because the registry demanded it, not to fill out
   * a grid. These rules are deliberately broader than the four above, so they sit
   * later in the list and lose every score tie to a more specific DeFi match.
   * ------------------------------------------------------------------------ */

  {
    category: 'trading-execution',
    label: 'Trading & Execution',
    description:
      'Analyses markets and executes trades. The broad trading bucket — agents running a specific strategy are classified under that strategy instead.',
    capabilityTerms: [
      'trading',
      'trade-execution',
      'order-execution',
      'market-analysis',
      'technical-analysis',
      'arbitrage',
      'perpetuals',
      'derivatives',
    ],
    phrases: [
      /*
       * Self-description, and the most common one in the registry: 2,285 indexed
       * agents call themselves a "trading agent" and were landing in
       * `uncategorized` anyway. They scored 1 on the bare `trading` keyword against
       * a threshold of 2 — the classifier recorded `weak-signal:trading-execution`,
       * which was an accurate report of a rule that was too strict rather than of a
       * genuinely ambiguous agent. An agent stating its own function outright is
       * phrase-strength evidence.
       */
      'trading agent',
      'trade execution',
      'execute trades',
      'trading strateg',
      'trading signal',
      'market analysis',
      'technical analysis',
      'price action',
      'entry and exit',
      'arbitrage opportunit',
      'multi-chain trading',
      'automated trading',
    ],
    keywords: ['trading', 'trader', 'arbitrage', 'perp', 'swap', 'execution'],
    // A newsletter about trading is not a trading agent.
    counterKeywords: ['newsletter', 'educational only', 'course'],
  },

  {
    category: 'model-evaluation',
    label: 'Model Evaluation',
    description:
      'Scores, ranks or votes on AI model outputs. Evaluation and benchmarking work — judging what a model produced rather than trading, researching or building.',
    /*
     * Every term names a model or the act of judging one. A bare `evaluation` sat here
     * briefly and had to go: it matched the OASF skill
     * `evaluation_and_monitoring/quality_evaluation` at capability weight, which
     * outranked a news aggregator's much stronger media signals and filed ClawNews —
     * summarisation, search, `media_and_entertainment/news` — as a model evaluator.
     *
     * Exactly three agents in the whole index declare an evaluation-shaped capability, so
     * the generic term bought almost nothing and cost a confident wrong answer. Same
     * lesson as the `grid` term: breadth in a classifier is not coverage, it is noise
     * that happens to score.
     */
    capabilityTerms: [
      'model-evaluation',
      'model-benchmarking',
      'quality-evaluation',
      'annotation',
      'data-labeling',
      'data-labelling',
      'preference-ranking',
      'rlhf',
    ],
    /*
     * `score/vote` and `/arena` are the literal shapes the largest cluster uses. They
     * read oddly for a taxonomy, and that is the point: these are matched because the
     * corpus contains them, not because they sound like a category should.
     */
    phrases: [
      'score/vote',
      'vote on ai model',
      'score ai model',
      'model arena',
      'evaluate model',
      'model benchmark',
      'human feedback',
      'preference data',
      'rank model',
    ],
    // No bare `evaluation` here either, for the reason above.
    keywords: ['benchmark', 'annotate', 'rlhf', 'arena'],
    /*
     * An agent that *is* a model, or that trades on model output, is not doing
     * evaluation work. Without these, "powered by a model" would pull in a large part
     * of the registry, since almost every agent mentions a model somewhere.
     */
    counterKeywords: ['trading agent', 'powered by', 'llm-powered'],
  },

  {
    category: 'research-analytics',
    label: 'Research & Analytics',
    description:
      'Gathers, analyses and explains data — protocol research, on-chain analytics and structured insight rather than execution.',
    capabilityTerms: [
      'research',
      'analytics',
      'data-analysis',
      'market-research',
      'due-diligence',
      'reporting',
      'data-science',
    ],
    phrases: [
      'data analysis',
      'market research',
      'protocol research',
      'on-chain analytics',
      'structured data analysis',
      'actionable insight',
      'due diligence',
      'research agent',
      'analytics agent',
    ],
    keywords: ['research', 'analytics', 'insight', 'dataset', 'intelligence'],
    counterKeywords: [],
  },

  {
    category: 'automation-operations',
    label: 'Automation & Ops',
    description:
      'Runs workflows, orchestrates other agents and keeps operational processes moving without a human in the loop.',
    capabilityTerms: [
      'automation',
      'orchestration',
      'workflow',
      'agent-coordination',
      'devops',
      'scheduling',
      'monitoring',
      'alerting',
    ],
    phrases: [
      'workflow automation',
      'automation & ops',
      'automation and ops',
      'task automation',
      'agent orchestration',
      'multi agent',
      'multi-agent',
      'operational process',
      'ops agent',
      'uptime monitoring',
    ],
    keywords: ['automation', 'orchestrat', 'workflow', 'scheduler', 'pipeline'],
    counterKeywords: [],
  },

  {
    category: 'security-verification',
    label: 'Security & Verification',
    description:
      'Audits contracts, verifies claims and looks for vulnerabilities — the agents other agents get checked by.',
    capabilityTerms: [
      'security',
      'audit',
      'verification',
      'vulnerability-detection',
      'threat-detection',
      'formal-verification',
      'penetration-testing',
    ],
    phrases: [
      'security review',
      'smart contract security',
      'security audit',
      'vulnerability detection',
      'bug detection',
      'threat detection',
      'formal verification',
      'gas optimization',
      'exploit detection',
    ],
    keywords: ['security', 'audit', 'vulnerabilit', 'exploit', 'attack', 'verification'],
    counterKeywords: [],
  },

  {
    category: 'code-smart-contracts',
    label: 'Code & Smart Contracts',
    description:
      'Writes, reviews and debugs software — including Solidity and the tooling around deploying it.',
    capabilityTerms: [
      'coding',
      'code-generation',
      'code-review',
      'smart-contracts',
      'solidity',
      'debugging',
      'text-to-code',
      'software-engineering',
    ],
    phrases: [
      'smart contract',
      'code review',
      'code generation',
      'write code',
      'debugging',
      'memory leak',
      'root cause',
      'software engineering',
      'developer tool',
    ],
    keywords: ['solidity', 'coding', 'developer', 'debug', 'compile', 'refactor'],
    counterKeywords: [],
  },

  {
    category: 'content-media',
    label: 'Content & Media',
    description:
      'Produces writing, social posts and other media — the creative end of the agent ecosystem.',
    capabilityTerms: [
      'content-generation',
      'writing',
      'copywriting',
      'social-media',
      'translation',
      'summarization',
      'publishing',
    ],
    phrases: [
      'content creation',
      'content generation',
      'writing & content',
      'writing and content',
      'social media',
      'copywrit',
      'blog post',
      'summariz',
    ],
    keywords: ['content', 'writing', 'copywriter', 'translation', 'influencer'],
    counterKeywords: [],
  },
];

/** Weight per evidence class. Capability claims outrank prose. */
export const SIGNAL_WEIGHTS = {
  capability: 3,
  phrase: 2,
  keyword: 1,
  counter: -3,
} as const;

/**
 * Score at which confidence saturates to 1.0. Reaching it takes more than a
 * single lucky keyword — roughly one capability plus one phrase.
 */
export const CONFIDENCE_SATURATION = 5;

/** Minimum score before a category is assigned at all. */
export const PRIMARY_THRESHOLD = 2;

/** Minimum score for a secondary category. */
export const SECONDARY_THRESHOLD = 2;

/**
 * Stored on every assignment so a row's category can be traced to the ruleset that
 * produced it.
 *
 * v2 widened the taxonomy from the four BNB Agent Studio categories to ten, after
 * indexing ~19k agents showed the original four matched under 1% of the registry.
 * Bumped rather than left alone because a `rules-v1` row and a `rules-v2` row are
 * genuinely different claims.
 *
 * v3 addressed the uncategorized bucket by measuring it instead of guessing. Two
 * findings, both from counting the corpus:
 *
 *   - 2,285 agents call themselves a "trading agent" and were failing on a threshold,
 *     not on ambiguity. The classifier had been honestly logging
 *     `weak-signal:trading-execution` for every one of them.
 *   - 2,317 agents score or vote on AI model outputs, matched nothing at all, and
 *     needed a category rather than a looser rule.
 *
 * Also the near miss worth recording: the largest cluster's descriptions contain the
 * string "dgrid", and a careless `grid` term would have filed 4,692 model-evaluation
 * agents under Grid Trading. The word-boundary rule in the classifier is what stopped
 * that, and it is why terms are matched on boundaries rather than by substring.
 */
export const CLASSIFIER_VERSION = 'rules-v3';
