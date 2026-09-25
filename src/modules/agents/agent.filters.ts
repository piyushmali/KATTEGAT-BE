import { and, arrayContains, eq, gte, ilike, or, sql, type SQL } from 'drizzle-orm';
import { agentCategories, agents } from '../../infrastructure/database/schema.js';

/**
 * One definition of what the marketplace's filters mean, in SQL.
 *
 * Extracted from the agents repository because three callers now need the identical
 * predicate and had started to disagree: the agent list, its paginating count, and the
 * per-category counts behind the discovery grid's tabs. The tabs were the proof — they
 * counted primary assignments over the whole index while the grid filtered on any
 * assignment under three active filters, so a tab read "Trading & Execution 135,424"
 * above a total of 6,191 and clicking it produced 1,872. Three numbers, one question.
 *
 * A count that contradicts the page it labels is worse than no count, so the predicate
 * lives in one place and every caller builds from it.
 */

export interface AgentFilters {
  category?: string;
  protocolTag?: string;
  query?: string;
  traits?: string[];
  resolvedOnly?: boolean;
  hasEndpoint?: boolean;
  classifiedOnly?: boolean;
  minConfidence?: number;
}

/**
 * True when an agent carries at least one category that is not the catch-all.
 *
 * The definition of "classified", used by both `classified_only` and — negated — by
 * `category=uncategorized`, so the two cannot drift into describing different sets.
 *
 * `exists` rather than a join because an agent holds several category rows and a join would
 * multiply it into several result rows, inflating every count built on it.
 */
function hasRealCategory(): SQL {
  return sql`exists (select 1 from ${agentCategories} where ${and(
    eq(agentCategories.agentId, agents.id),
    sql`${agentCategories.category} <> 'uncategorized'`,
  )})`;
}

/**
 * `uncategorized` means "no real category", not "carries an uncategorized row".
 *
 * This is the one filter whose meaning had to change rather than just move. It used to look
 * for a stored `uncategorized` assignment, which the classifier does write — but 191,302 of
 * those rows were deleted to fit the catalogue inside a 1 GB free tier during the database
 * migration, so the agents are now unclassified by *absence* of a row. Asked for
 * uncategorized agents, the old filter found 39 in a browsable set holding 81,827 of them.
 *
 * Defining it as the complement of classified fixes that without restoring 191,302 rows,
 * and is the better definition regardless: it makes the marker row redundant rather than
 * load-bearing, so trimming it again is harmless and an agent whose classification was never
 * attempted is reported honestly instead of being invisible to both filters.
 */
function hasNoRealCategory(): SQL {
  return sql`not ${hasRealCategory()}`;
}

/**
 * The condition for agents in one category, as the grid means it.
 *
 * Any assignment, not just the primary one: an agent that rebalances *and* chases yield
 * belongs in both lists, and the "Why this agent?" panel shows both. `minConfidence` narrows
 * the named category and is meaningless without one, which is why it is applied here.
 */
export function inCategory(category: string, minConfidence?: number): SQL {
  if (category === 'uncategorized') return hasNoRealCategory();

  const conditions = [
    eq(agentCategories.agentId, agents.id),
    eq(agentCategories.category, category),
  ];
  if (minConfidence !== undefined) {
    conditions.push(gte(agentCategories.confidence, minConfidence));
  }

  return sql`exists (select 1 from ${agentCategories} where ${and(...conditions)})`;
}

/**
 * Builds the WHERE clause shared by the agent list, its count and the category counts.
 *
 * `omitCategory` is for the category counts, which need every other filter applied but must
 * group across categories rather than being restricted to one. Without it the counts would
 * have to rebuild the predicate, which is how they drifted in the first place.
 */
export function buildAgentWhere(
  filters: AgentFilters,
  options: { omitCategory?: boolean } = {},
): SQL | undefined {
  const conditions: SQL[] = [];

  if (filters.protocolTag) {
    conditions.push(sql`${agents.protocolTag} = ${filters.protocolTag}`);
  }

  if (filters.resolvedOnly === true) {
    conditions.push(sql`${agents.metadataResolvedAt} is not null`);
  }

  /*
   * `unconfigured` is the tag for an agent that published no interface, so this is "has
   * somewhere to call" rather than a protocol choice. Written as an inequality against the one
   * excluded value instead of an IN list of the four included ones, so a protocol added to the
   * taxonomy later is included by default rather than silently filtered out.
   */
  if (filters.hasEndpoint === true) {
    conditions.push(sql`${agents.protocolTag} <> 'unconfigured'`);
  }

  if (filters.classifiedOnly === true) {
    conditions.push(hasRealCategory());
  }

  if (filters.query) {
    const term = `%${filters.query}%`;
    const clause = or(ilike(agents.name, term), ilike(agents.description, term));
    if (clause) conditions.push(clause);
  }

  if (filters.traits && filters.traits.length > 0) {
    // Drizzle's helper rather than a hand-written `@>`, because a hand-written one binds the
    // JS array without a `::text[]` cast, which Postgres silently matches against nothing.
    conditions.push(arrayContains(agents.traitTags, filters.traits));
  }

  if (filters.category && options.omitCategory !== true) {
    conditions.push(inCategory(filters.category, filters.minConfidence));
  }

  return conditions.length > 0 ? and(...conditions) : undefined;
}
