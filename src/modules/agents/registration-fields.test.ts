import { describe, expect, it } from 'vitest';
import { safeImageUrl, toAgentEndpoints, toDeclaredBoolean, toTrustModels } from './agent.types.js';

/**
 * Everything asserted here is parsed out of an agent's registration file, which is
 * fetched from a URL written on chain by whoever registered the agent. All of it is
 * untrusted input that ends up rendered in a visitor's browser.
 */

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
/**
 * `services` entries reach an `href`, where `javascript:` genuinely executes, so the
 * linkable/displayable split is asserted rather than assumed.
 *
 * The fixtures are shapes observed in the live registry, not invented ones: the `{agentId}`
 * template, the CAIP-10 contract reference and the empty `{}` service all come from real
 * registration files.
 */

describe('toAgentEndpoints', () => {
  it('keeps the published value and offers a link for https endpoints', () => {
    const [endpoint] = toAgentEndpoints([
      {
        name: 'A2A',
        endpoint: 'https://bnb-lp.nip.io/.well-known/agent-card.json',
        version: '0.3.0',
      },
    ]);

    expect(endpoint).toEqual({
      label: 'A2A',
      value: 'https://bnb-lp.nip.io/.well-known/agent-card.json',
      url: 'https://bnb-lp.nip.io/.well-known/agent-card.json',
      kind: 'a2a',
      version: '0.3.0',
    });
  });

  it('displays a non-URL endpoint but refuses to link it', () => {
    // A CAIP-10 reference to another registry contract. Real, and not a URL.
    const [endpoint] = toAgentEndpoints([
      { name: 'bap578', endpoint: 'eip155:56:0x15b15DF2fFFF6653C21C11b93fB8A7718CE854Ce/10711' },
    ]);

    expect(endpoint?.value).toBe('eip155:56:0x15b15DF2fFFF6653C21C11b93fB8A7718CE854Ce/10711');
    expect(endpoint?.url).toBeNull();
    expect(endpoint?.kind).toBe('other');
  });

  it('never produces a link for a javascript: endpoint', () => {
    const [endpoint] = toAgentEndpoints([{ name: 'web', endpoint: 'javascript:alert(1)' }]);

    // Still shown, because hiding it would hide what the operator actually published.
    expect(endpoint?.value).toBe('javascript:alert(1)');
    expect(endpoint?.url).toBeNull();
  });

  it('refuses to link plain http rather than upgrading it', () => {
    const [endpoint] = toAgentEndpoints([{ name: 'web', endpoint: 'http://example.com' }]);

    expect(endpoint?.url).toBeNull();
    // Still recognisably a web endpoint, so it groups with the others.
    expect(endpoint?.kind).toBe('web');
  });

  it('classifies by label and by endpoint shape', () => {
    const kinds = toAgentEndpoints([
      { name: 'MCP', endpoint: 'https://example.com/mcp' },
      { name: 'unnamed', endpoint: 'https://example.com/v1/mcp/' },
      { name: 'agentWallet', endpoint: 'https://example.com/w' },
      { name: 'telegram', endpoint: 'https://t.me/example' },
      { name: 'web', endpoint: 'https://example.com' },
      // Unlabelled A2A card, recognised from the well-known path alone.
      { endpoint: 'https://example.com/.well-known/agent-card.json' },
    ]).map((endpoint) => endpoint.kind);

    expect(kinds).toEqual(['mcp', 'mcp', 'wallet', 'social', 'web', 'a2a']);
  });

  it('drops entries with nothing to show', () => {
    // `services: [{}]` appears verbatim in the registry. An empty row communicates nothing.
    expect(toAgentEndpoints([{}, { name: 'web' }, { endpoint: '   ' }])).toEqual([]);
  });

  it('returns an empty list for absent or non-array input', () => {
    expect(toAgentEndpoints(undefined)).toEqual([]);
    expect(toAgentEndpoints(null)).toEqual([]);
    expect(toAgentEndpoints('https://example.com')).toEqual([]);
  });

  it('bounds a hostile registration file', () => {
    const long = Array.from({ length: 300 }, () => ({ endpoint: 'https://example.com' }));
    expect(toAgentEndpoints(long)).toHaveLength(100);

    expect(toAgentEndpoints([{ endpoint: `https://e.com/${'a'.repeat(3000)}` }])).toEqual([]);
  });
});

describe('toTrustModels', () => {
  it("keeps the operator's own wording, including non-standard values", () => {
    /*
     * `termix-platform` is not in the spec, and normalising or dropping it would
     * misrepresent what 256 agents actually declared.
     */
    expect(toTrustModels(['reputation', 'termix-platform', 'tee-attestation'])).toEqual([
      'reputation',
      'termix-platform',
      'tee-attestation',
    ]);
  });

  it('drops blanks and non-strings, and de-duplicates', () => {
    expect(toTrustModels(['reputation', '  ', null, 7, 'reputation'])).toEqual(['reputation']);
  });
});

describe('toDeclaredBoolean', () => {
  it('keeps a declared false distinct from an unstated value', () => {
    // An operator saying "not running" is information. A missing field is not.
    expect(toDeclaredBoolean(false)).toBe(false);
    expect(toDeclaredBoolean(undefined)).toBeNull();
  });

  it('does not coerce truthy strings or numbers', () => {
    expect(toDeclaredBoolean('true')).toBeNull();
    expect(toDeclaredBoolean(1)).toBeNull();
  });
});
