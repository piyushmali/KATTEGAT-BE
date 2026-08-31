import type { AgentCategoryAssignment } from '../agents/agent.types.js';
import {
  CATEGORY_RULES,
  CLASSIFIER_VERSION,
  CONFIDENCE_SATURATION,
  PRIMARY_THRESHOLD,
  SECONDARY_THRESHOLD,
  SIGNAL_WEIGHTS,
  type CategoryRule,
} from './taxonomy.js';

/**
 * Assigns marketplace categories to an agent, with the evidence for each.
 *
 * Deliberately a deterministic rule engine, not a model call. Three reasons:
 * the same agent must classify identically on every sync so the marketplace does
 * not reshuffle between page loads; every assignment has to be explainable in the
 * UI ("matched capability: rebalance"); and an LLM adds latency plus per-agent
 * cost to what is fundamentally a keyword decision. §22 of the brief makes the
 * same point — do not spend a model call on a deterministic filter.
 *
 * An optional model-assisted pass for genuinely ambiguous agents plugs in behind
 * `integrations/ai/provider.ts`; it is not wired up because the rules cover the
 * four launch categories and unresolved cases are visibly `uncategorized` rather
 * than silently wrong.
 */

export interface ClassificationInput {
  name: string;
  description: string | null;
  capabilities: string[];
}

interface Scored {
  rule: CategoryRule;
  score: number;
  signals: string[];
}

/** Escapes a term so it can sit inside a RegExp literal safely. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Word-boundary containment test.
 *
 * Prevents the classic false positive where `grid` matches `gridlock` or `lp`
 * matches `help`. Terms ending in a partial stem (`rebalanc`, `deleverag`) are
 * intentionally left open at the end so they catch every inflection.
 */
function containsTerm(haystack: string, term: string): boolean {
  const escaped = escapeRegExp(term);
  // Only anchor the trailing boundary when the term looks like a whole word;
  // stems such as "rebalanc" must still match "rebalancing".
  const pattern = new RegExp(`(^|[^a-z0-9])${escaped}`, 'i');
  return pattern.test(haystack);
}

/** Lowercases and unifies separators so `smart_grids` and `smart grids` agree. */
function normalizeCapability(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

/**
 * Splits a capability into its path segments.
 *
 * Real registration files carry hierarchical OASF skill identifiers like
 * `energy/smart_grids` or `finance_and_business/banking`, so a capability is a path,
 * not a word.
 */
function capabilitySegments(capability: string): string[] {
  return normalizeCapability(capability)
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/**
 * Whole-token match of a term against one capability segment.
 *
 * Substring matching was the original implementation and it was wrong: the OASF
 * taxonomy's `energy/smart_grids` contains "grid", so `capability.includes('grid')`
 * classified six general-purpose agents as grid-trading bots. Requiring the term to
 * occupy a whole hyphen-delimited token means `grid-trading` still matches while
 * `smart-grids` does not.
 *
 * Note this is deliberately *not* stemmed. Stemming would make "grid" match "grids"
 * and reintroduce exactly the false positive.
 */
function segmentMatchesTerm(segment: string, term: string): boolean {
  if (segment === term) return true;
  return segment.startsWith(`${term}-`) || segment.endsWith(`-${term}`) || segment.includes(`-${term}-`);
}

function scoreRule(
  rule: CategoryRule,
  text: string,
  name: string,
  capabilities: string[][],
): Scored {
  let score = 0;
  const signals: string[] = [];

  /*
   * The name, scored separately and at phrase strength.
   *
   * A name is a deliberate self-identification, so `Grid_Beam_Prime.agent` is strong
   * evidence in a way that the same word buried in a paragraph is not. Scored on top of the
   * keyword pass rather than instead of it, so a name match clears the threshold on its own
   * (2) and a name plus corroborating prose clears it comfortably (3).
   *
   * This is what v3 was missing. Every `Grid_*.agent` on Termix scored exactly 1 against a
   * threshold of 2 and was filed `uncategorized`, which is why grid-trading held seven
   * agents out of a possible 140.
   */
  for (const keyword of rule.keywords) {
    if (containsTerm(name, keyword)) {
      score += SIGNAL_WEIGHTS.name;
      signals.push(`name:${keyword}`);
    }
  }

  for (const term of rule.capabilityTerms) {
    const normalizedTerm = normalizeCapability(term);
    const hit = capabilities.some((segments) =>
      segments.some((segment) => segmentMatchesTerm(segment, normalizedTerm)),
    );
    if (hit) {
      score += SIGNAL_WEIGHTS.capability;
      signals.push(`capability:${term}`);
    }
  }

  for (const phrase of rule.phrases) {
    if (text.includes(phrase)) {
      score += SIGNAL_WEIGHTS.phrase;
      signals.push(`phrase:${phrase}`);
    }
  }

  for (const keyword of rule.keywords) {
    if (containsTerm(text, keyword)) {
      score += SIGNAL_WEIGHTS.keyword;
      signals.push(`keyword:${keyword}`);
    }
  }

  for (const counter of rule.counterKeywords) {
    if (text.includes(counter)) {
      score += SIGNAL_WEIGHTS.counter;
      signals.push(`excluded:${counter}`);
    }
  }

  return { rule, score: Math.max(0, score), signals };
}

function toConfidence(score: number): number {
  const ratio = score / CONFIDENCE_SATURATION;
  // Two decimals: the underlying signal is a weighted keyword count, and more
  // precision than this would imply a measurement we do not have.
  return Math.round(Math.min(1, Math.max(0, ratio)) * 100) / 100;
}

/**
 * Returns every matching category, primary first.
 *
 * Always returns at least one assignment: an agent nothing matches is explicitly
 * `uncategorized` with a `no-signal-match` reason, which keeps it discoverable
 * and makes gaps in the taxonomy visible instead of dropping the agent.
 */
export function classifyAgent(input: ClassificationInput): AgentCategoryAssignment[] {
  const text = [input.name, input.description ?? '']
    .join(' \n ')
    .toLowerCase()
    .replace(/\s+/g, ' ');
  const capabilities = input.capabilities
    .map(capabilitySegments)
    .filter((segments) => segments.length > 0);

  const name = input.name.toLowerCase().replace(/\s+/g, ' ');

  const scored = CATEGORY_RULES.map((rule) => scoreRule(rule, text, name, capabilities))
    .filter((entry) => entry.score > 0)
    // Ties broken by the taxonomy's declaration order so output is stable.
    .sort((a, b) => b.score - a.score);

  const [best] = scored;

  if (!best || best.score < PRIMARY_THRESHOLD) {
    return [
      {
        category: 'uncategorized',
        confidence: 0,
        isPrimary: true,
        signals: best ? [`weak-signal:${best.rule.category}`] : ['no-signal-match'],
        classifierVersion: CLASSIFIER_VERSION,
      },
    ];
  }

  const assignments: AgentCategoryAssignment[] = [
    {
      category: best.rule.category,
      confidence: toConfidence(best.score),
      isPrimary: true,
      signals: best.signals,
      classifierVersion: CLASSIFIER_VERSION,
    },
  ];

  for (const entry of scored.slice(1)) {
    if (entry.score < SECONDARY_THRESHOLD) continue;
    assignments.push({
      category: entry.rule.category,
      confidence: toConfidence(entry.score),
      isPrimary: false,
      signals: entry.signals,
      classifierVersion: CLASSIFIER_VERSION,
    });
  }

  return assignments;
}
