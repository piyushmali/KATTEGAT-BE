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
  'rebalancing',
  'grid-trading',
  'yield-optimization',
  'health-factor-monitoring',
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

export const CLASSIFIER_VERSION = 'rules-v1';
