import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { z } from 'zod';

/**
 * Fetching and parsing ERC-8004 agent registration files.
 *
 * The document shape follows the structure required by the ERC-8004 spec
 * (`#registration-v1`): see ERC8004SPEC.md "Agent URI and Agent Registration
 * File". Everything here is treated as untrusted input, because `agentURI` is
 * set on-chain by whoever registered the agent.
 */

const MAX_BYTES = 512 * 1024;

/**
 * Per-file fetch budget.
 *
 * A registration file is a small JSON document, so a slow response almost always means
 * an unreachable host rather than a large payload — and an unreachable host costs the
 * full budget, multiplied by however many agents point at it. Measured across the
 * registry, 7,936 fetchable agents share just 23 hosts, so one dead domain is thousands
 * of timeouts, not one.
 *
 * 5s is well beyond what a healthy host needs while halving what a dead one costs.
 * Anything that misses it is recorded as unresolved, which is a state the UI already
 * shows honestly rather than an error.
 */
const TIMEOUT_MS = 5_000;

/**
 * Every field is optional on read even where the spec says MUST.
 *
 * Real registries contain agents whose URI resolves to a partial or malformed
 * document, and a marketplace that drops those agents shows an incomplete view
 * of the ecosystem. We parse what is there, mark the rest as unresolved, and let
 * the UI render a "metadata unavailable" state.
 */
/**
 * `.nullish()` throughout, not `.optional()`.
 *
 * This is calibration against real registry data, not defensiveness for its own
 * sake. Registration files in the wild serialise absent values as JSON `null`
 * (`"image": null`, `"avatarUrl": null`) rather than omitting the key. Zod's
 * `.optional()` accepts `undefined` but rejects `null`, so an `.optional()`
 * schema throws away otherwise perfectly good documents over a field nothing
 * here even reads — which it did, for 86% of agents on the first live run.
 */
const nullableText = (max: number) => z.string().max(max).nullish();

export const registrationServiceSchema = z.object({
  name: nullableText(200),
  endpoint: nullableText(2_000),
  version: nullableText(50),
  skills: z.array(nullableText(200)).max(200).nullish(),
  domains: z.array(nullableText(200)).max(200).nullish(),
});

export const registrationFileSchema = z.object({
  type: nullableText(300),
  name: nullableText(300),
  description: nullableText(20_000),
  image: nullableText(2_000),
  services: z.array(registrationServiceSchema).max(100).nullish(),
  x402Support: z.boolean().nullish(),
  active: z.boolean().nullish(),
  registrations: z
    .array(
      z.object({
        agentId: z.union([z.number(), z.string()]).nullish(),
        agentRegistry: nullableText(300),
      }),
    )
    .max(100)
    .nullish(),
  supportedTrust: z.array(nullableText(100)).max(50).nullish(),
  /**
   * Non-standard but widespread: registrars (TermiX among them) attach
   * free-form tags alongside the spec fields. They carry real classification
   * signal, so they are read here rather than discarded.
   */
  tags: z.array(nullableText(100)).max(100).nullish(),
});

export type RegistrationFile = z.infer<typeof registrationFileSchema>;
export type RegistrationService = z.infer<typeof registrationServiceSchema>;

/**
 * Exactly one protocol tag per agent, matching the ERC-8004 Explorer taxonomy.
 *
 * Single source of truth: this integration derives the tag (see
 * {@link deriveProtocolTag}), so it owns the vocabulary. The database column and
 * the wire enums both derive from this list.
 */
export const PROTOCOL_TAGS = ['a2a', 'mcp', 'http-api', 'custom', 'unconfigured'] as const;

export type ProtocolTag = (typeof PROTOCOL_TAGS)[number];

export interface ResolvedRegistration {
  file: RegistrationFile;
  protocolTag: ProtocolTag;
  traitTags: string[];
  capabilities: string[];
}

/* -------------------------------------------------------------------------- */
/* URI resolution                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Blocks the obvious SSRF targets: loopback, link-local (incl. cloud instance
 * metadata at 169.254.169.254), and RFC1918 / unique-local ranges.
 *
 * ponytail: this is a denylist on the resolved address, so it does not defend
 * against DNS rebinding between our lookup and undici's own connect. Closing
 * that needs a custom dispatcher pinned to the verified IP; acceptable here
 * because the fetch result is parsed as JSON and never executed or echoed.
 */
function isBlockedAddress(address: string): boolean {
  const family = isIP(address);

  if (family === 4) {
    const parts = address.split('.').map(Number);
    const [a = 0, b = 0] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  if (family === 6) {
    const normalized = address.toLowerCase();
    if (normalized === '::1' || normalized === '::') return true;
    // fc00::/7 unique-local, fe80::/10 link-local.
    if (/^f[cd]/.test(normalized) || /^fe[89ab]/.test(normalized)) return true;
    // IPv4-mapped (::ffff:10.0.0.1) — re-check the embedded address.
    const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
    if (mapped?.[1]) return isBlockedAddress(mapped[1]);
    return false;
  }

  return false;
}

async function assertPublicHost(hostname: string): Promise<void> {
  const bare = hostname.replace(/^\[|\]$/g, '');

  if (isIP(bare)) {
    if (isBlockedAddress(bare)) {
      throw new Error(`refusing to fetch from non-public address ${bare}`);
    }
    return;
  }

  if (bare === 'localhost' || bare.endsWith('.localhost') || bare.endsWith('.internal')) {
    throw new Error(`refusing to fetch from non-public host ${bare}`);
  }

  const records = await lookup(bare, { all: true, verbatim: true });
  if (records.length === 0) {
    throw new Error(`could not resolve ${bare}`);
  }
  for (const record of records) {
    if (isBlockedAddress(record.address)) {
      throw new Error(`refusing to fetch ${bare}: resolves to non-public address`);
    }
  }
}

/** Turns an `agentURI` into an HTTPS URL, or returns inline JSON for data URIs. */
export function resolveAgentUri(
  agentUri: string,
  ipfsGateway: string,
): { kind: 'url'; url: string } | { kind: 'inline'; json: string } {
  const uri = agentUri.trim();

  if (uri.startsWith('ipfs://')) {
    const path = uri.slice('ipfs://'.length).replace(/^ipfs\//, '');
    if (path.length === 0) throw new Error('empty ipfs:// path');
    return { kind: 'url', url: `${ipfsGateway.replace(/\/$/, '')}/${path}` };
  }

  if (uri.startsWith('data:')) {
    const comma = uri.indexOf(',');
    if (comma === -1) throw new Error('malformed data: URI');
    const header = uri.slice(5, comma);
    const payload = uri.slice(comma + 1);
    if (header.includes(';base64')) {
      if (payload.length > MAX_BYTES * 2) throw new Error('data: URI too large');
      return { kind: 'inline', json: Buffer.from(payload, 'base64').toString('utf8') };
    }
    return { kind: 'inline', json: decodeURIComponent(payload) };
  }

  if (uri.startsWith('https://')) {
    return { kind: 'url', url: uri };
  }

  // Plain http:// is rejected rather than upgraded: silently rewriting a URI we
  // were given would make provenance ambiguous.
  throw new Error(`unsupported agentURI scheme: ${uri.slice(0, 12)}`);
}

/**
 * Whether resolving this URI requires a network request.
 *
 * The split matters for throughput. 82% of the registry publishes its registration file
 * inline as a `data:` URI, which costs a base64 decode and nothing else; the rest points
 * at an HTTPS or IPFS URL owned by someone else. Discovery can afford the first kind and
 * cannot afford to wait on the second, so ingestion needs to tell them apart before it
 * commits to fetching anything.
 *
 * An unparseable or unsupported URI counts as not needing a fetch: there is nothing to
 * retrieve, and it will be recorded as unresolved either way.
 */
export function needsNetworkFetch(agentUri: string | null, ipfsGateway: string): boolean {
  if (agentUri === null) return false;

  try {
    return resolveAgentUri(agentUri, ipfsGateway).kind === 'url';
  } catch {
    return false;
  }
}

async function fetchText(url: string): Promise<string> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') {
    throw new Error(`refusing non-https fetch: ${parsed.protocol}`);
  }
  await assertPublicHost(parsed.hostname);

  const response = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: 'application/json, text/plain;q=0.8, */*;q=0.1' },
    redirect: 'error',
  });

  if (!response.ok) {
    throw new Error(`registration file fetch failed with ${String(response.status)}`);
  }

  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_BYTES) {
    throw new Error(`registration file too large (${String(declared)} bytes)`);
  }

  // Content-Length is a hint, not a guarantee — enforce the cap while streaming.
  const body = response.body;
  if (!body) return '';

  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        throw new Error('registration file exceeded size limit');
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return Buffer.concat(chunks).toString('utf8');
}

/* -------------------------------------------------------------------------- */
/* Derivation                                                                 */
/* -------------------------------------------------------------------------- */

const serviceName = (service: RegistrationService): string => (service.name ?? '').toLowerCase();
const serviceEndpoint = (service: RegistrationService): string =>
  (service.endpoint ?? '').toLowerCase();

/**
 * Derives the single protocol tag, following the precedence the ERC-8004
 * Explorer documents: A2A wins over MCP, MCP over a plain HTTP endpoint,
 * anything else with services is custom, and no services is unconfigured.
 */
export function deriveProtocolTag(file: RegistrationFile): ProtocolTag {
  const services = file.services ?? [];
  if (services.length === 0) return 'unconfigured';

  if (services.some((s) => serviceName(s) === 'a2a')) return 'a2a';

  const looksLikeMcp = services.some((s) => {
    const name = serviceName(s);
    const endpoint = serviceEndpoint(s);
    return name === 'mcp' || endpoint.startsWith('mcp://') || /\/mcp\/?$/.test(endpoint);
  });
  if (looksLikeMcp) return 'mcp';

  const hasHttp = services.some((s) => /^https?:\/\//.test(serviceEndpoint(s)));
  if (hasHttp) return 'http-api';

  return 'custom';
}

/** Orthogonal trait tags. Activity-derived traits are added by the caller. */
export function deriveTraitTags(file: RegistrationFile): string[] {
  const tags = new Set<string>();

  if (file.x402Support === true) tags.add('x402-paid');
  if ((file.registrations ?? []).length > 1) tags.add('multichain');
  if (file.active === true) tags.add('declared-active');

  const trust = (file.supportedTrust ?? [])
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.toLowerCase());
  if (trust.includes('tee-attestation')) tags.add('tee-attested');
  if (trust.includes('reputation')) tags.add('reputation-trust');
  if (trust.includes('crypto-economic')) tags.add('crypto-economic-trust');

  return [...tags].sort();
}

/** Flattens the skills, domains and tags advertised across every declared service. */
export function deriveCapabilities(file: RegistrationFile): string[] {
  const capabilities = new Set<string>();

  const add = (value: string | null | undefined): void => {
    const trimmed = value?.trim();
    if (trimmed) capabilities.add(trimmed);
  };

  for (const service of file.services ?? []) {
    for (const skill of service.skills ?? []) add(skill);
    for (const domain of service.domains ?? []) add(domain);
  }
  for (const tag of file.tags ?? []) add(tag);

  return [...capabilities].sort();
}

export function interpretRegistrationFile(file: RegistrationFile): ResolvedRegistration {
  return {
    file,
    protocolTag: deriveProtocolTag(file),
    traitTags: deriveTraitTags(file),
    capabilities: deriveCapabilities(file),
  };
}

/**
 * Fetches and interprets a registration file.
 *
 * Throws on network, size, scheme and JSON failures — the caller decides
 * whether that degrades one agent or fails a whole sync.
 */
export async function loadRegistrationFile(
  agentUri: string,
  ipfsGateway: string,
): Promise<ResolvedRegistration> {
  const resolved = resolveAgentUri(agentUri, ipfsGateway);
  const raw = resolved.kind === 'inline' ? resolved.json : await fetchText(resolved.url);

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    throw new Error('registration file is not valid JSON');
  }

  const result = registrationFileSchema.safeParse(parsedJson);
  if (!result.success) {
    // Naming the offending field matters: the 86%-unresolved bug on the first
    // live run was a single `"image": null`, and a bare count would have hidden it.
    const summary = result.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`registration file failed validation (${summary})`);
  }

  return interpretRegistrationFile(result.data);
}
