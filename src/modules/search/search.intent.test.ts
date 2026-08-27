import { describe, expect, it } from 'vitest';
import { parseSearchIntent } from './search.intent.js';

/**
 * The intent parser turns user prose into a query that runs against real data, so
 * a regression here silently returns the wrong agents rather than failing. Each
 * case is a behaviour a user would notice.
 */

describe('parseSearchIntent', () => {
  it('extracts a category from a plain request', () => {
    expect(parseSearchIntent('grid trading bot').category).toBe('grid-trading');
    expect(parseSearchIntent('rebalance my portfolio').category).toBe('rebalancing');
    expect(parseSearchIntent('best apy for my stables').category).toBe('yield-optimization');
    expect(parseSearchIntent('stop me getting liquidated').category).toBe(
      'health-factor-monitoring',
    );
  });

  it('reads the example query from the brief end to end', () => {
    const intent = parseSearchIntent(
      'Find me a conservative yield agent for stablecoins with a long track record.',
    );

    expect(intent.category).toBe('yield-optimization');
    // "conservative" and "track record" are honoured as a preference for evidence,
    // not invented into a risk score KATTEGAT does not have.
    expect(intent.sort).toBe('feedback');
    expect(intent.resolvedOnly).toBe(true);
    expect(intent.text).toContain('stablecoins');
    expect(intent.explanation.length).toBeGreaterThan(1);
  });

  it('removes consumed signals from the free-text query', () => {
    const intent = parseSearchIntent(
      'Find me a conservative yield agent for stablecoins with a long track record.',
    );

    /*
     * The whole point of consuming a signal is that it stops being free text.
     * Leaving "conservative" or "track record" in the LIKE clause made this exact
     * query return zero agents, because no agent description contains them.
     */
    expect(intent.text).not.toContain('conservative');
    expect(intent.text).not.toContain('track');
    expect(intent.text).not.toContain('record');
    expect(intent.text).not.toContain('yield');
  });

  it('does not leak a matched protocol or trait into the free text', () => {
    const intent = parseSearchIntent('mcp agent that takes x402 payments');

    expect(intent.protocol).toBe('mcp');
    expect(intent.text ?? '').not.toContain('mcp');
    expect(intent.text ?? '').not.toContain('x402');
  });

  it('detects protocol and trait constraints', () => {
    const intent = parseSearchIntent('mcp agent that takes x402 payments across multiple chains');

    expect(intent.protocol).toBe('mcp');
    expect(intent.traits).toContain('x402-paid');
    expect(intent.traits).toContain('multichain');
  });

  it('maps ranking intent without inventing a category', () => {
    const newest = parseSearchIntent('newest agents');
    expect(newest.sort).toBe('registered_at');
    expect(newest.category).toBeNull();

    const popular = parseSearchIntent('most reviewed agents');
    expect(popular.sort).toBe('feedback');
  });

  it('strips filler words from the residual text', () => {
    const intent = parseSearchIntent('please find me the best agent for arbitrum');

    expect(intent.text).toContain('arbitrum');
    // Words that carry no filtering value must not reach the SQL LIKE.
    for (const noise of ['please', 'find', 'best', 'agent', 'the', 'for']) {
      expect(intent.text).not.toContain(noise);
    }
  });

  it('always explains itself, even when nothing is recognised', () => {
    const intent = parseSearchIntent('zzzz');

    expect(intent.category).toBeNull();
    expect(intent.explanation.length).toBeGreaterThan(0);
    // Falls back to matching the raw text rather than returning everything.
    expect(intent.text).toBe('zzzz');
  });

  it('is deterministic', () => {
    const query = 'conservative yield agent for stablecoins';
    expect(parseSearchIntent(query)).toStrictEqual(parseSearchIntent(query));
  });

  it('does not crash on punctuation-only or empty input', () => {
    expect(() => parseSearchIntent('???')).not.toThrow();
    expect(() => parseSearchIntent('   ')).not.toThrow();
  });

  it('prefers the strongest category when a query touches two', () => {
    // "health factor" is a phrase (weight 3); "yield" is a lone keyword (weight 1).
    const intent = parseSearchIntent('health factor monitor that also chases yield');
    expect(intent.category).toBe('health-factor-monitoring');
  });
});
