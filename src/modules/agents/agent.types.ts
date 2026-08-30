import type { ProtocolTag } from '../../integrations/erc8004/registration-file.js';
import type { AgentCategory } from '../classification/taxonomy.js';

/**
 * KATTEGAT's internal agent model.
 *
 * Split along the boundaries in docs/architecture.md rather than collapsed into
 * one `Agent` object: identity comes from chain, the profile comes from an
 * off-chain document that may be missing, categories are derived by us, and
 * reputation is a point-in-time snapshot. Those four have different freshness,
 * different failure modes and different owners, so they stay separate.
 */

/**
 * Re-exported for convenience: these vocabularies are owned elsewhere —
 * `ProtocolTag` by the ERC-8004 integration that derives it, `AgentCategory` by
 * the classification taxonomy that defines it — and an agent merely carries them.
 */
export type { ProtocolTag, AgentCategory };

/** On-chain facts. Always present for an indexed agent. */
export interface AgentIdentity {
  /** `${chainId}:${agentId}` */
  id: string;
  chainId: number;
  agentId: number;
  ownerAddress: string;
  /** Declared payment wallet, null when the agent never set one. */
  walletAddress: string | null;
  agentUri: string | null;
  registeredAtBlock: number | null;
  registeredAt: Date | null;
}

/** Off-chain descriptive data. May be unresolved — see `metadataResolvedAt`. */
export interface AgentProfile {
  name: string;
  description: string | null;
  capabilities: string[];
  protocolTag: ProtocolTag;
  traitTags: string[];
  /**
   * The agent's own artwork, from the `image` field of its registration file.
   *
   * Published by 95.5% of agents with resolved metadata, and until now parsed and then
   * discarded. Null when absent or when the URL failed the safety check in
   * `safeImageUrl` — a URI set on chain by whoever registered the agent is untrusted
   * input, so it is validated rather than passed through.
   */
  imageUrl: string | null;
  /**
   * Where the agent can actually be reached, from the `services` array of its
   * registration file.
   *
   * Exposed because without it a profile is a name and two block-explorer links, which
   * tells a visitor nothing about whether the agent does anything. 16,445 agents publish
   * at least one endpoint, and those endpoints are the entire point of the record: the
   * registry entry exists so a client can find the A2A card or MCP server and call it.
   *
   * Empty array when the agent declared no services, which is a real and common state
   * (`protocolTag` is then `unconfigured`) and is shown as such rather than hidden.
   */
  endpoints: AgentEndpoint[];
  /**
   * Trust models the operator says it supports, e.g. `reputation`, `tee-attestation`.
   *
   * Passed through as published, including the long tail of non-standard values, because
   * normalising them would misrepresent what the operator actually wrote on chain.
   */
  trustModels: string[];
  /** Whether the agent accepts x402 pay-per-call. Null when it did not say. */
  x402Support: boolean | null;
  /**
   * The operator's own claim that the agent is running.
   *
   * A claim, not a measurement, and labelled that way in the UI. Null when unstated,
   * which stays distinct from a declared `false`.
   */
  declaredActive: boolean | null;
  /** Null when the registration file could not be fetched or parsed. */
  metadataResolvedAt: Date | null;
}

/** How an endpoint can be reached, used to group and label them in the UI. */
export const ENDPOINT_KINDS = ['a2a', 'mcp', 'web', 'wallet', 'social', 'other'] as const;

export type EndpointKind = (typeof ENDPOINT_KINDS)[number];

/** One entry from a registration file's `services` array, after validation. */
export interface AgentEndpoint {
  /** The operator's label, e.g. `A2A`. Null when they left it unset. */
  label: string | null;
  /**
   * The endpoint exactly as published.
   *
   * Always present, and always what gets displayed. Many endpoints are not URLs at all:
   * some are CAIP-10 references to another contract, some use `mcp://`. Showing the raw
   * value means a visitor sees what is really on chain instead of a blank where KATTEGAT
   * failed to make a link out of it.
   */
  value: string;
  /**
   * The same endpoint as a safe link target, or null.
   *
   * Separate from `value` because this is untrusted input going into an `href`, where
   * `javascript:` genuinely executes. Only absolute `https:` URLs qualify; everything
   * else renders as plain text.
   */
  url: string | null;
  kind: EndpointKind;
  version: string | null;
}

const SOCIAL_LABELS = new Set(['twitter', 'x', 'telegram', 'discord', 'email', 'github']);

/**
 * Classifies a single endpoint.
 *
 * Per-endpoint, unlike `deriveProtocolTag`, which collapses the whole agent to one tag by
 * precedence. Both are needed: the tag answers "what kind of agent is this" for filtering,
 * this answers "what is this particular link" so a list of five endpoints does not render
 * as five identical rows.
 */
function endpointKind(label: string, value: string): EndpointKind {
  if (label === 'a2a' || label === 'a2acard' || value.includes('agent-card.json')) return 'a2a';
  if (label === 'mcp' || value.startsWith('mcp://') || /\/mcp\/?$/.test(value)) return 'mcp';
  if (label.includes('wallet')) return 'wallet';
  if (SOCIAL_LABELS.has(label)) return 'social';
  if (value.startsWith('https://') || value.startsWith('http://')) return 'web';
  return 'other';
}

/** The on-chain facts an endpoint template can be filled in from. */
export interface EndpointContext {
  agentId: number;
  walletAddress: string | null;
}

/**
 * Placeholders that appear in published endpoints, and where their value comes from.
 *
 * Registrars publish one template per platform rather than a URL per agent, so the
 * document says `/a2a/agents/{agentId}/card` and expects the client to substitute. 21,780
 * endpoints carry `{agentId}` and one carries `{wallet}`, which is a third of every
 * endpoint in the registry, and every one of them 404s if linked verbatim.
 *
 * Substituting is resolution, not invention: the value comes from the agent's own on-chain
 * record, and the result is verifiable. Filling `{agentId}` on agent 310018 returns HTTP
 * 200 with a card whose `agentTokenId` is `310018` and whose name matches the registry.
 */
const ENDPOINT_PLACEHOLDERS: Record<string, (context: EndpointContext) => string | null> = {
  '{agentId}': (context) => String(context.agentId),
  '{wallet}': (context) => context.walletAddress,
};

/**
 * Normalises the `services` array into endpoints worth rendering.
 *
 * Entries with no endpoint are dropped: `services: [{}]` appears in real registration
 * files (agent 219 among them), and an empty row communicates nothing. The agent still
 * shows as having no reachable endpoint, which is accurate.
 */
export function toAgentEndpoints(value: unknown, context: EndpointContext): AgentEndpoint[] {
  if (!Array.isArray(value)) return [];

  const endpoints: AgentEndpoint[] = [];

  for (const entry of value.slice(0, 100)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const service = entry as { name?: unknown; endpoint?: unknown; version?: unknown };

    const raw = typeof service.endpoint === 'string' ? service.endpoint.trim() : '';
    if (raw.length === 0 || raw.length > 2_000) continue;

    const label = typeof service.name === 'string' ? service.name.trim() || null : null;

    endpoints.push({
      label,
      value: raw,
      url: safeLinkUrl(fillTemplate(raw, context)),
      kind: endpointKind((label ?? '').toLowerCase(), raw.toLowerCase()),
      version: typeof service.version === 'string' ? service.version.trim() || null : null,
    });
  }

  return endpoints;
}

/** Substitutes every placeholder this agent has a value for. */
function fillTemplate(endpoint: string, context: EndpointContext): string {
  if (!endpoint.includes('{')) return endpoint;

  let filled = endpoint;
  for (const [placeholder, resolve] of Object.entries(ENDPOINT_PLACEHOLDERS)) {
    const replacement = resolve(context);
    if (replacement !== null) filled = filled.split(placeholder).join(replacement);
  }

  return filled;
}

/**
 * Passes through absolute `https:` URLs, rejects everything else. See `safeImageUrl`.
 *
 * Also rejects anything still holding a placeholder. An unfilled `{...}` means either a
 * name we do not recognise or one this agent has no value for, and a link built from it
 * leads nowhere. Better to render the template as plain text and let the visitor see that
 * the operator published a template.
 */
function safeLinkUrl(value: string): string | null {
  if (value.includes('{') || value.includes('}')) return null;

  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Treats a blank string as an absent value.
 *
 * Exists because `??` does not. A registration file that sets `"name": ""` or
 * `"description": "   "` passed straight through every `?? fallback` in the codebase, so
 * 321 agents rendered an empty `<h1>` and 529 an empty description paragraph. Absent and
 * blank mean the same thing to a reader and must reach the UI the same way.
 */
export function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? null : trimmed;
}

/**
 * The name to show for an agent, falling back to its id.
 *
 * One helper because three paths build this: discovery, the metadata backlog, and reading a
 * row back out. They disagreed, which is how blank names reached the page.
 */
export function agentDisplayName(name: string | null | undefined, agentId: number): string {
  return blankToNull(name) ?? `Agent #${String(agentId)}`;
}

/** Reads `supportedTrust`, keeping the operator's own wording. */
export function toTrustModels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const models = new Set<string>();
  for (const entry of value.slice(0, 50)) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed.length > 0 && trimmed.length <= 100) models.add(trimmed);
  }

  return [...models];
}

/** Narrows an unknown JSON value to a boolean, leaving anything else as unstated. */
export function toDeclaredBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/**
 * Accepts an agent-supplied image URL, or rejects it.
 *
 * `agentURI` and everything reachable through it is written on chain by whoever
 * registered the agent, so this is untrusted input rendered in every visitor's browser.
 * Only absolute `https:` URLs are allowed:
 *
 *  - `javascript:` and `vbscript:` never reach an `src`, even though a browser would not
 *    execute them there today. Relying on that is a bet, not a defence.
 *  - `data:` is refused because a data URI in an `<img>` is a payload of unbounded size
 *    the page has no way to budget for.
 *  - plain `http:` is refused rather than upgraded, because silently rewriting a URL we
 *    were given makes provenance ambiguous — the same rule the registration-file loader
 *    already applies to `agentURI` itself.
 */
export function safeImageUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 2_000) return null;

  try {
    return new URL(trimmed).protocol === 'https:' ? trimmed : null;
  } catch {
    // Not a parseable absolute URL. A relative path has no meaningful base here.
    return null;
  }
}

/** One classification result with the evidence that produced it. */
export interface AgentCategoryAssignment {
  category: AgentCategory;
  /** 0..1 heuristic confidence. Not a probability. */
  confidence: number;
  isPrimary: boolean;
  /** Why this matched, e.g. `capability:rebalance`. Rendered in the UI. */
  signals: string[];
  classifierVersion: string;
}

/**
 * Reputation as reported by the ERC-8004 ReputationRegistry.
 *
 * `summaryValue` / `summaryDecimals` are kept as the registry returned them.
 * `score` is the decoded convenience value; it is null when there is no
 * feedback, which is different from a score of zero and must stay
 * distinguishable in the UI.
 */
export interface AgentReputation {
  feedbackCount: number;
  clientCount: number;
  summaryValue: number | null;
  summaryDecimals: number | null;
  score: number | null;
  source: string;
  computedAt: Date;
}

/** What the API returns for a list row. */
export interface AgentSummary {
  identity: AgentIdentity;
  profile: AgentProfile;
  categories: AgentCategoryAssignment[];
  reputation: AgentReputation | null;
}

/** Decodes the registry's fixed-point pair into a real number. */
export function decodeSummaryValue(value: number | null, decimals: number | null): number | null {
  if (value === null || decimals === null) return null;
  return value / 10 ** decimals;
}
