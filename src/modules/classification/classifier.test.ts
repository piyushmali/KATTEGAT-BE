import { describe, expect, it } from 'vitest';
import { classifyAgent } from './classifier.js';
import { CATEGORY_RULES, CLASSIFIER_VERSION } from './taxonomy.js';

/**
 * The classifier is the one piece of KATTEGAT that invents information rather
 * than relaying it, so it carries the tests. Each case below is a behaviour that
 * would silently corrupt the marketplace if it regressed — a miscategorised
 * agent is worse than an uncategorised one, because the user cannot tell.
 */

const agent = (name: string, description: string | null, capabilities: string[] = []) => ({
  name,
  description,
  capabilities,
});

describe('classifyAgent', () => {
  it('assigns each of the four launch categories from a realistic description', () => {
    const cases = [
      {
        expected: 'rebalancing',
        input: agent(
          'Vault Balancer',
          'Monitors your portfolio against a target allocation and trades back to target weights when drift exceeds a threshold band.',
        ),
      },
      {
        expected: 'grid-trading',
        input: agent(
          'RangeRunner',
          'Runs a grid trading strategy, placing an order ladder across a configurable price grid.',
        ),
      },
      {
        expected: 'yield-optimization',
        input: agent(
          'Harvest Router',
          'Continuously seeks the highest APY across lending markets and will auto-compound rewards.',
        ),
      },
      {
        expected: 'health-factor-monitoring',
        input: agent(
          'Liquidation Sentinel',
          'Tracks the health factor of your borrow positions and repays debt before liquidation risk becomes critical.',
        ),
      },
    ];

    for (const { expected, input } of cases) {
      const [primary] = classifyAgent(input);
      expect(primary?.category, `${input.name} should be ${expected}`).toBe(expected);
      expect(primary?.isPrimary).toBe(true);
      expect(primary?.confidence).toBeGreaterThan(0);
    }
  });

  it('treats a declared capability as stronger evidence than a passing mention', () => {
    /*
     * Compares one signal against one signal. An earlier version of this test compared
     * aggregate confidence between two fixtures carrying different numbers of signals,
     * which stopped meaning anything once names began to score: "Portfolio helper" carries
     * real evidence in its name, so the prose fixture legitimately outscored the capability
     * one and the test failed for the right reason about the wrong thing.
     */
    const viaCapability = classifyAgent(agent('Helper', null, ['rebalance']));
    const viaKeyword = classifyAgent(agent('Helper', 'Mentions drift in passing.'));

    // A declared capability alone is enough to classify.
    expect(viaCapability[0]?.category).toBe('rebalancing');
    // A single keyword alone is not, and says so rather than guessing.
    expect(viaKeyword[0]?.category).toBe('uncategorized');
    expect(viaKeyword[0]?.signals).toEqual(['weak-signal:rebalancing']);
  });

  it('reads the agent’s own name as a deliberate claim', () => {
    /*
     * The v4 gap. `Grid_*.agent` registrations on Termix describe nothing beyond their
     * name, so a name-only match scoring 1 against a threshold of 2 filed all of them as
     * uncategorized. Grid-trading held 7 agents out of a possible 140 because of it.
     *
     * A name is chosen, not mentioned, so it scores at phrase strength and clears the
     * threshold on its own.
     */
    const [primary] = classifyAgent(agent('Grid_AlloyLambda.agent', 'on Termix Platform'));

    expect(primary?.category).toBe('grid-trading');
    expect(primary?.signals).toContain('name:grid');
  });

  it('still refuses a name that only looks like a category', () => {
    // `dgrid` is a brand carried by 4,692 model-evaluation agents. The boundary rule holds
    // for names exactly as it does for prose.
    const [primary] = classifyAgent(agent('dgrid-worker', 'Scores AI model outputs.'));

    expect(primary?.category).not.toBe('grid-trading');
  });

  it('recognises the BNB venues the launch categories are built on', () => {
    /*
     * 493 agents name PancakeSwap, Venus, Aave or Lista and matched nothing in v3, despite
     * Altana shipping one skill per venue. All three descriptions here are real registry
     * text, not invented.
     */
    const cases = [
      {
        expected: 'grid-trading',
        input: agent(
          'PCS Grid Verifier',
          'Geometric grid trading on BNB/USDT via PancakeSwap. Sells computed grid plans and live strategy status.',
        ),
      },
      {
        expected: 'rebalancing',
        input: agent(
          'CL Manager',
          'Automated management of concentrated liquidity positions, execution of DEX token swaps.',
        ),
      },
      {
        expected: 'health-factor-monitoring',
        input: agent('Venus Watch', 'Tracks your Venus protocol lending position against its liquidation threshold.'),
      },
    ];

    for (const { expected, input } of cases) {
      const [primary] = classifyAgent(input);
      expect(primary?.category, `${input.name} should be ${expected}`).toBe(expected);
    }
  });

  it('falls back to uncategorized instead of guessing', () => {
    const result = classifyAgent(
      agent('Weather Oracle', 'Publishes signed temperature readings to consumers.'),
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.category).toBe('uncategorized');
    expect(result[0]?.confidence).toBe(0);
    expect(result[0]?.signals).toContain('no-signal-match');
  });

  it('does not match a keyword inside an unrelated word', () => {
    // "gridlock" must not read as grid trading; "help" must not read as an LP.
    const result = classifyAgent(
      agent('Traffic Reporter', 'Reports gridlock and will help you plan a route.'),
    );

    expect(result[0]?.category).toBe('uncategorized');
  });

  it('applies counter-keywords to reject a superficial match', () => {
    const optimiser = classifyAgent(
      agent('Yield Hunter', 'Yield farming agent that will auto-compound your positions.'),
    );
    const dashboard = classifyAgent(
      agent('Yield Board', 'A read-only dashboard only for yield farming numbers. Informational only.'),
    );

    expect(optimiser[0]?.category).toBe('yield-optimization');
    // Same vocabulary, opposite intent — the counter-terms must pull it down.
    expect(dashboard[0]?.confidence ?? 1).toBeLessThan(optimiser[0]?.confidence ?? 0);
  });

  it('reports secondary categories for a genuinely multi-purpose agent', () => {
    const result = classifyAgent(
      agent(
        'Omni Manager',
        'Rebalances your portfolio to its target allocation and hunts the best yield with auto-compound vault strategies.',
        ['rebalance', 'yield'],
      ),
    );

    const categories = result.map((entry) => entry.category);
    expect(categories).toContain('rebalancing');
    expect(categories).toContain('yield-optimization');
    expect(result.filter((entry) => entry.isPrimary)).toHaveLength(1);
  });

  it('returns an explanation for every assignment', () => {
    const result = classifyAgent(
      agent('Grid Bot', 'Grid trading across a price grid.', ['grid-trading']),
    );

    for (const assignment of result) {
      expect(assignment.signals.length).toBeGreaterThan(0);
      /*
       * Asserted against the exported constant, not a literal. The intent is that every
       * assignment is stamped with the ruleset that produced it, so a row can be traced
       * later — pinning the string here only guaranteed a failing test on each bump,
       * which is a chore rather than a guard. The shape check keeps the value meaningful.
       */
      expect(assignment.classifierVersion).toBe(CLASSIFIER_VERSION);
      expect(assignment.classifierVersion).toMatch(/^rules-v\d+$/);
    }
  });

  it('is deterministic across repeated calls', () => {
    const input = agent('Harvest Router', 'Seeks the highest APY and will auto-compound.', ['vault']);
    expect(classifyAgent(input)).toStrictEqual(classifyAgent(input));
  });

  it('keeps confidence within 0..1 for an agent stuffed with every keyword', () => {
    const everything = CATEGORY_RULES.flatMap((rule) => [...rule.phrases, ...rule.keywords]).join(' ');
    for (const assignment of classifyAgent(agent('Kitchen Sink', everything))) {
      expect(assignment.confidence).toBeGreaterThanOrEqual(0);
      expect(assignment.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('handles empty and missing input without throwing', () => {
    const result = classifyAgent(agent('', null, []));
    expect(result[0]?.category).toBe('uncategorized');
  });

  /*
   * Regression: hierarchical OASF skill identifiers.
   *
   * Real agents on BNB Smart Chain publish capabilities as taxonomy paths. Six of
   * them (ids 15-20) were classified as grid-trading bots because the matcher used
   * `capability.includes('grid')` and the list below contains `energy/smart_grids`.
   * This is the actual capability list from those agents, trimmed.
   */
  const OASF_CAPABILITIES = [
    'advanced_reasoning_planning/strategic_planning',
    'agent_orchestration/agent_coordination',
    'agriculture/livestock_management',
    'energy/smart_grids',
    'finance_and_business/banking',
    'finance_and_business/finance',
    'government_and_public_sector/public_infrastructure',
    'marketing_and_advertising/market_research',
    'retail_and_ecommerce/inventory_management',
  ];

  it('does not read energy/smart_grids as a grid-trading capability', () => {
    const result = classifyAgent(agent('8004AI', '8004AI8004AI8004AI', OASF_CAPABILITIES));

    /*
     * The invariant is "not grid-trading", not "uncategorized".
     *
     * This originally asserted `uncategorized`, which was correct only while the
     * taxonomy had four DeFi categories. The list above also declares
     * `marketing_and_advertising/market_research` and
     * `agent_orchestration/agent_coordination`, so under the wider taxonomy this
     * agent legitimately reads as research + automation. That is a true statement
     * about its declared capabilities; `energy/smart_grids` meaning grid trading
     * was not.
     */
    expect(result.map((entry) => entry.category)).not.toContain('grid-trading');
  });

  it('does not read finance_and_business/finance as a DeFi category', () => {
    // "finance" and "banking" are domains, not one of the four strategies.
    const result = classifyAgent(agent('Bank Helper', 'General banking assistant.', [
      'finance_and_business/banking',
      'finance_and_business/finance',
    ]));

    expect(result[0]?.category).toBe('uncategorized');
  });

  it('still matches a capability expressed as a taxonomy path', () => {
    // The fix must not break legitimate hierarchical capabilities.
    const result = classifyAgent(
      agent('Range Bot', null, ['trading/grid-trading', 'defi/market-making']),
    );

    expect(result[0]?.category).toBe('grid-trading');
    expect(result[0]?.signals.some((signal) => signal.startsWith('capability:'))).toBe(true);
  });

  it('treats underscore and hyphen separators as equivalent', () => {
    const underscore = classifyAgent(agent('A', null, ['defi/grid_trading']));
    const hyphen = classifyAgent(agent('A', null, ['defi/grid-trading']));

    expect(underscore[0]?.category).toBe('grid-trading');
    expect(hyphen[0]?.category).toBe('grid-trading');
  });

  it('does not match a term that is only part of a longer word', () => {
    // "grids" must not satisfy "grid", or the smart_grids bug returns.
    expect(classifyAgent(agent('A', null, ['energy/grids']))[0]?.category).toBe('uncategorized');
    expect(classifyAgent(agent('A', null, ['x/yielding']))[0]?.category).toBe('uncategorized');
  });
});

/**
 * The two v3 rule changes, tested against the exact text that motivated them.
 *
 * Both descriptions below are copied verbatim from agents indexed on BNB Smart Chain,
 * because a rule tuned against invented text proves nothing about the corpus it has to
 * work on.
 */
describe('classifyAgent — v3 corpus findings', () => {
  const DEBOT = 'Trading agent from debot.ai — trade everything smarter on Debot.';
  const DGRID =
    "I'm agent001 from dgrid.ai!I'm currently helping my owner score/vote on AI models at dgrid.ai/arena to earn USDT.";

  it('classifies an agent that calls itself a trading agent', () => {
    /*
     * 2,285 indexed agents use this phrasing. They previously scored 1 on the bare
     * `trading` keyword against a threshold of 2, so the classifier reported
     * `weak-signal:trading-execution` — an accurate description of an over-strict rule,
     * not of an ambiguous agent.
     */
    const result = classifyAgent({ name: 'gemini', description: DEBOT, capabilities: [] });
    const primary = result.find((entry) => entry.isPrimary);

    expect(primary?.category).toBe('trading-execution');
    expect(primary?.signals.join(' ')).toContain('trading agent');
  });

  it('classifies the AI-model scoring cluster as model evaluation', () => {
    const result = classifyAgent({ name: 'agent001', description: DGRID, capabilities: [] });
    const primary = result.find((entry) => entry.isPrimary);

    expect(primary?.category).toBe('model-evaluation');
  });

  it('NEVER files the dgrid cluster under grid trading', () => {
    /*
     * The trap this whole change had to avoid. These descriptions contain the substring
     * "dgrid", and a `grid` term matched by substring rather than word boundary would
     * have filed 4,692 model-evaluation agents as Grid Trading — a confident, wrong,
     * and completely invisible answer.
     */
    const result = classifyAgent({ name: 'agent001', description: DGRID, capabilities: [] });
    expect(result.map((entry) => entry.category)).not.toContain('grid-trading');
  });

  it('still keeps genuine grid trading separate from the broad trading bucket', () => {
    // Guards the other direction: widening trading-execution must not swallow a strategy.
    const result = classifyAgent({
      name: 'Grid Bot',
      description: 'Places a ladder of staggered orders across a price range.',
      capabilities: ['grid-trading'],
    });

    expect(result.find((entry) => entry.isPrimary)?.category).toBe('grid-trading');
  });

  it('does not call a trading agent a model evaluator just for mentioning a model', () => {
    // The counter-keyword earning its place: almost every agent mentions a model.
    const result = classifyAgent({
      name: 'quant',
      description: 'Trading agent powered by a forecasting model.',
      capabilities: [],
    });

    expect(result.find((entry) => entry.isPrimary)?.category).toBe('trading-execution');
  });
});

describe('classifyAgent — model evaluation stays narrow', () => {
  it('does not claim a news aggregator that happens to declare a quality-evaluation skill', () => {
    /*
     * Regression from the v3 rollout. A bare `evaluation` capability term matched the
     * OASF skill `evaluation_and_monitoring/quality_evaluation` at capability weight and
     * outranked this agent's far stronger media signals, filing a Hacker-News-for-agents
     * as a model evaluator. Its real capabilities are reproduced verbatim.
     */
    const result = classifyAgent({
      name: 'ClawNews',
      description:
        'Hacker News for AI agents - built by agents, for agents. ClawNews is the premier news aggregation and community platform where autonomous agents share, discover, and engage with content.',
      capabilities: [
        'agent_orchestration/agent_coordination',
        'evaluation_and_monitoring/quality_evaluation',
        'media_and_entertainment/news',
        'natural_language_processing/information_retrieval_synthesis/summarization',
      ],
    });

    expect(result.find((entry) => entry.isPrimary)?.category).not.toBe('model-evaluation');
  });
});
