import type { AgentCategory } from '../agents/agent.types.js';
import { CATEGORY_RULES } from '../classification/taxonomy.js';

/**
 * Turns a natural-language marketplace query into structured filters.
 *
 * Deterministic, and deliberately so. §22 of the brief is explicit that a model
 * call should not stand in for a filter a rule can decide, and the practical
 * argument is stronger: the same query must return the same results every time,
 * with no per-search latency or cost. An optional model pass handles only the
 * queries these rules cannot place (see search.service.ts).
 *
 * The category vocabulary is read from modules/classification/taxonomy.ts rather
 * than restated here — one vocabulary decides both "what is this agent?" and
 * "what is this user asking for?", so the two can never drift apart.
 */

export interface SearchIntent {
  /** Residual free text after structured signals are removed. */
  text: string | null;
  category: AgentCategory | null;
  protocol: string | null;
  traits: string[];
  /** Only agents with a resolved registration file. */
  resolvedOnly: boolean;
  sort: 'registered_at' | 'reputation' | 'name' | 'feedback';
  direction: 'asc' | 'desc';
  /** Human-readable account of what was understood, shown in the UI. */
  explanation: string[];
}

const PROTOCOL_PATTERNS: { protocol: string; patterns: RegExp[] }[] = [
  { protocol: 'a2a', patterns: [/\ba2a\b/, /\bagent[- ]to[- ]agent\b/] },
  { protocol: 'mcp', patterns: [/\bmcp\b/, /\bmodel context protocol\b/] },
  { protocol: 'http-api', patterns: [/\bhttp[- ]?api\b/, /\brest api\b/] },
];

const TRAIT_PATTERNS: { trait: string; patterns: RegExp[] }[] = [
  { trait: 'x402-paid', patterns: [/\bx402\b/, /\bpaid\b/, /\bpay[- ]per[- ]call\b/] },
  {
    trait: 'multichain',
    // "multichain", "multi-chain", "multiple chains", "cross chain", "several chains".
    patterns: [/\bmulti(ple)?[- ]?chains?\b/, /\bcross[- ]?chains?\b/, /\bseveral chains\b/],
  },
  { trait: 'tee-attested', patterns: [/\btee\b/, /\battested\b/, /\benclave\b/] },
  { trait: 'declared-active', patterns: [/\bactive\b/, /\blive\b/] },
];

/**
 * Phrases that express a preference about track record rather than a category.
 *
 * These map onto sorting and a "must have resolved metadata" constraint. They
 * deliberately do NOT invent a risk score — KATTEGAT has no risk metric, so
 * "conservative" is honoured as "prefer agents with an actual track record",
 * which is something the data can support.
 */
const TRACK_RECORD_PATTERNS = [
  /\bconservative\b/,
  /\bsafe(r|st)?\b/,
  /\blow[- ]risk\b/,
  /\bproven\b/,
  /\bestablished\b/,
  /\btrack record\b/,
  /\btrusted\b/,
  /\breputable\b/,
];

const NEWEST_PATTERNS = [/\bnew(est)?\b/, /\brecent(ly)?\b/, /\blatest\b/];
const BUSIEST_PATTERNS = [/\bmost (reviewed|used|popular)\b/, /\bbusiest\b/, /\bpopular\b/];

/** Words carrying no filtering value; dropped from the residual text. */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'the', 'for', 'with', 'me', 'my', 'find', 'show', 'get', 'i', 'want',
  'need', 'looking', 'look', 'agent', 'agents', 'that', 'which', 'can', 'please', 'some',
  'any', 'to', 'of', 'on', 'in', 'is', 'are', 'best', 'good', 'top',
]);

/**
 * Returns the matched substring, not just whether it matched.
 *
 * The caller needs the literal text so it can be removed from the residual
 * free-text query. Leaving a consumed signal in place makes the SQL search for
 * words no agent description contains — "conservative yield agent with a track
 * record" then returns nothing instead of the yield agents it asked for.
 */
function firstMatch(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return null;
}

/**
 * Crude suffix stripper so a taxonomy term matches the inflections users type.
 *
 * The taxonomy stores the noun form an agent would advertise ("liquidation",
 * "rebalance"), while people search in whatever form fits the sentence
 * ("liquidated", "rebalancing"). Reducing both to a common root closes that gap
 * without duplicating every inflection in the taxonomy.
 *
 * ponytail: a hand-rolled stemmer, not a linguistic one — it only strips the few
 * English suffixes that actually appear in this vocabulary. If the taxonomy grows
 * past DeFi verbs, reach for a real stemmer rather than extending this list.
 */
function stem(term: string): string {
  const root = term.replace(/(ations?|ation|ing|ed|es|s)$/i, '');
  // Never shorten past a distinctive root: "aps" -> "ap" would match far too much.
  return root.length >= 4 ? root : term;
}

/**
 * Word-boundary match on the stem of `term`, so inflections still hit.
 *
 * Escaping happens before the separator class is inserted. Doing it the other way
 * round escapes the `[- _]?` this function just added, producing a pattern that
 * matches the literal text "health[- _]?factor" and therefore nothing at all.
 */
function containsStem(text: string, term: string): boolean {
  const escaped = stem(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A hyphen or underscore in the taxonomy should match a space too:
  // "health-factor" needs to find "health factor".
  const pattern = escaped.replace(/[-_]/g, '[- _]?');
  return new RegExp(`(^|[^a-z0-9])${pattern}`, 'i').test(text);
}

/**
 * Scores the query against the category vocabulary.
 *
 * Thresholds are lower than the agent classifier's on purpose: a query is a few
 * words, not a description, so one deliberate term ("grid", "liquidation") is a
 * genuine signal where in an agent description it would be weak evidence.
 */
function detectCategory(text: string): { category: AgentCategory; matched: string } | null {
  let best: { category: AgentCategory; matched: string; score: number } | null = null;

  for (const rule of CATEGORY_RULES) {
    let score = 0;
    let matched = '';

    for (const phrase of rule.phrases) {
      if (text.includes(phrase)) {
        score += 3;
        if (!matched) matched = phrase;
      }
    }
    for (const term of rule.capabilityTerms) {
      if (containsStem(text, term)) {
        score += 2;
        if (!matched) matched = term;
      }
    }
    for (const keyword of rule.keywords) {
      if (containsStem(text, keyword)) {
        score += 1;
        if (!matched) matched = keyword;
      }
    }
    for (const counter of rule.counterKeywords) {
      if (text.includes(counter)) score -= 3;
    }

    if (score > 0 && (!best || score > best.score)) {
      best = { category: rule.category, matched, score };
    }
  }

  return best ? { category: best.category, matched: best.matched } : null;
}

/** Strips matched structured signals, leaving terms worth a text search. */
function residualText(raw: string, consumed: string[]): string | null {
  let remaining = raw;
  for (const term of consumed) {
    remaining = remaining.replaceAll(term, ' ');
  }

  const words = remaining
    .replace(/[^a-z0-9\s-]/gi, ' ')
    .split(/\s+/)
    .map((word) => word.trim().toLowerCase())
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));

  const unique = [...new Set(words)];
  return unique.length > 0 ? unique.join(' ') : null;
}

export function parseSearchIntent(query: string): SearchIntent {
  const raw = query.trim().toLowerCase().replace(/\s+/g, ' ');
  const explanation: string[] = [];
  const consumed: string[] = [];

  const categoryHit = detectCategory(raw);
  if (categoryHit) {
    consumed.push(categoryHit.matched);
    const label =
      CATEGORY_RULES.find((rule) => rule.category === categoryHit.category)?.label ??
      categoryHit.category;
    explanation.push(`Category "${label}" from "${categoryHit.matched}"`);
  }

  let protocol: string | null = null;
  for (const entry of PROTOCOL_PATTERNS) {
    const hit = firstMatch(raw, entry.patterns);
    if (hit) {
      protocol = entry.protocol;
      consumed.push(hit);
      explanation.push(`Protocol "${entry.protocol}" from "${hit.trim()}"`);
      break;
    }
  }

  const traits: string[] = [];
  for (const entry of TRAIT_PATTERNS) {
    const hit = firstMatch(raw, entry.patterns);
    if (hit) {
      traits.push(entry.trait);
      consumed.push(hit);
      explanation.push(`Requires trait "${entry.trait}" from "${hit.trim()}"`);
    }
  }

  let sort: SearchIntent['sort'] = 'registered_at';
  let resolvedOnly = false;
  // Descending for every supported ranking: newest, most-reviewed and
  // highest-reputation all mean "best first".
  const direction: SearchIntent['direction'] = 'desc';

  const trackRecord = firstMatch(raw, TRACK_RECORD_PATTERNS);
  const busiest = firstMatch(raw, BUSIEST_PATTERNS);
  const newest = firstMatch(raw, NEWEST_PATTERNS);

  if (trackRecord) {
    sort = 'feedback';
    resolvedOnly = true;
    // Every track-record phrase present is consumed, not just the first, so none
    // of them leak into the text search.
    for (const pattern of TRACK_RECORD_PATTERNS) {
      const hit = pattern.exec(raw);
      if (hit) consumed.push(hit[0]);
    }
    explanation.push(
      `Read "${trackRecord.trim()}" as a preference for a proven track record: ranking by recorded feedback and excluding agents whose metadata never resolved`,
    );
  } else if (busiest) {
    sort = 'feedback';
    consumed.push(busiest);
    explanation.push('Ranking by number of reviews');
  } else if (newest) {
    sort = 'registered_at';
    consumed.push(newest);
    explanation.push('Ranking by most recently registered');
  }

  const text = residualText(raw, consumed);
  if (text) explanation.push(`Free-text match on "${text}"`);

  if (explanation.length === 0) {
    explanation.push('No structured signals recognised; matching on the raw query text');
  }

  return {
    text: text ?? (raw.length > 0 ? raw : null),
    category: categoryHit?.category ?? null,
    protocol,
    traits,
    resolvedOnly,
    sort,
    direction,
    explanation,
  };
}
