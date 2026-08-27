import { describe, expect, it } from 'vitest';
import { classifyAgent } from './classifier.js';
import { CATEGORY_RULES } from './taxonomy.js';

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

  it('treats a declared capability as stronger evidence than prose', () => {
    const viaCapability = classifyAgent(agent('Unnamed strategy', null, ['rebalance']));
    const viaKeyword = classifyAgent(agent('Portfolio helper', 'Adjusts allocation.'));

    expect(viaCapability[0]?.category).toBe('rebalancing');
    expect(viaCapability[0]?.confidence).toBeGreaterThan(viaKeyword[0]?.confidence ?? 1);
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
      expect(assignment.classifierVersion).toBe('rules-v1');
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

    expect(result[0]?.category).toBe('uncategorized');
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
