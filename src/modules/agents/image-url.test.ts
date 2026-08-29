import { describe, expect, it } from 'vitest';
import { safeImageUrl } from './agent.types.js';

/**
 * These URLs arrive from `agentURI`, which is written on chain by whoever registered the
 * agent, and end up in an `<img src>` in every visitor's browser. That makes this a trust
 * boundary, so the accept list is asserted rather than assumed.
 */

describe('safeImageUrl — accepts real agent artwork', () => {
  it.each([
    'https://www.iconaves.com/agent/1234.png',
    'https://evoevo.ai/images/agent.webp',
    'https://api.dicebear.com/7.x/identicon/svg?seed=abc',
    'https://r2-image-worker.pieverse-img.workers.dev/x.png',
  ])('accepts %s', (url) => {
    // All four are hosts observed serving artwork for indexed agents.
    expect(safeImageUrl(url)).toBe(url);
  });

  it('trims surrounding whitespace rather than rejecting the URL', () => {
    expect(safeImageUrl('  https://example.com/a.png  ')).toBe('https://example.com/a.png');
  });
});

describe('safeImageUrl — refuses anything that is not an https URL', () => {
  it('refuses javascript:', () => {
    /*
     * A browser will not execute this from an `img src` today. Depending on that is a bet
     * on browser behaviour rather than a defence, and the value costs nothing to reject.
     */
    expect(safeImageUrl('javascript:alert(1)')).toBeNull();
    expect(safeImageUrl('JavaScript:alert(1)')).toBeNull();
  });

  it('refuses data: and blob:', () => {
    // An inline payload of unbounded size the page cannot budget for.
    expect(safeImageUrl('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')).toBeNull();
    expect(safeImageUrl('blob:https://example.com/uuid')).toBeNull();
  });

  it('refuses plain http rather than silently upgrading it', () => {
    /*
     * Rewriting a URL we were given would make provenance ambiguous — the same rule the
     * registration-file loader applies to `agentURI` itself.
     */
    expect(safeImageUrl('http://example.com/a.png')).toBeNull();
  });

  it('refuses relative paths, which have no meaningful base here', () => {
    expect(safeImageUrl('/images/agent.png')).toBeNull();
    expect(safeImageUrl('agent.png')).toBeNull();
  });

  it('refuses absent, empty and non-string values', () => {
    expect(safeImageUrl(null)).toBeNull();
    expect(safeImageUrl(undefined)).toBeNull();
    expect(safeImageUrl('')).toBeNull();
    expect(safeImageUrl('   ')).toBeNull();
    expect(safeImageUrl(42)).toBeNull();
    expect(safeImageUrl({ url: 'https://example.com' })).toBeNull();
  });

  it('refuses an absurdly long value', () => {
    // Bounded so a hostile registration file cannot push megabytes into every response.
    expect(safeImageUrl(`https://example.com/${'a'.repeat(3000)}`)).toBeNull();
  });
});
