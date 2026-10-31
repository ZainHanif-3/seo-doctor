'use strict';

/**
 * Scoring engine.
 *
 * Two models are used, both 0–100 and both reach 100 when nothing fails:
 *
 *  - SEO score — issue density. Each failing signal costs its severity weight,
 *    normalised by the number of crawled pages. This keeps a 30-page site with
 *    20 issues from scoring the same as a 1-page site with 20 issues.
 *
 *  - GEO score — signal coverage. Generative-engine visibility is a checklist
 *    (llms.txt, AI crawler access, schema graph, answer-first copy, citations…),
 *    so the score is the share of available signal weight that passes.
 *
 * `scoreIssues()` is the original v1 formula and is kept unchanged for
 * backwards compatibility with existing reports and tests.
 */

const WEIGHTS = { critical: 10, high: 6, medium: 3, low: 1 };
const SEVERITIES = ['critical', 'high', 'medium', 'low'];

// Original v1 formula — unchanged on purpose (tests + stored reports depend on it).
function scoreIssues(issues) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  let weighted = 0;
  for (const i of issues) {
    const sev = SEVERITIES.includes(i.severity) ? i.severity : 'low';
    counts[sev] += 1;
    weighted += WEIGHTS[sev];
  }
  const n = issues.length;
  const maxPossible = n * WEIGHTS.critical;
  let score = 100;
  if (n > 0) score = Math.round(100 - (weighted / maxPossible) * 100);
  if (!Number.isFinite(score) || score < 0) score = 0;
  if (score > 100) score = 100;
  return { score, counts, weighted, maxPossible };
}

const SEO_CATEGORIES = new Set(['meta', 'content', 'social', 'structured', 'technical']);
const GEO_CATEGORY = 'geo';

// Density constant: weighted issues per page that cost ~63% of the score.
const DENSITY_K = 45;

function clamp(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function weightOf(issue) {
  return WEIGHTS[issue && issue.severity] || WEIGHTS.low;
}

function countSeverities(issues) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const i of issues) {
    const sev = SEVERITIES.includes(i.severity) ? i.severity : 'low';
    counts[sev] += 1;
  }
  return counts;
}

/** Issue-density score for a set of SEO issues. */
function densityScore(issues, pages) {
  const n = Math.max(1, Number(pages) || 1);
  const weighted = issues.reduce((sum, i) => sum + weightOf(i), 0);
  if (weighted === 0) return 100;
  const density = weighted / n;
  return clamp(100 * Math.exp(-density / DENSITY_K));
}

/**
 * Signal-coverage score for GEO.
 * @param {Array} failures - failing GEO checks (each with a `weight`)
 * @param {number} possible - total available weight (per-page × pages + site)
 */
function coverageScore(failures, possible) {
  if (!possible || possible <= 0) return 100;
  const failed = failures.reduce((sum, f) => sum + (Number(f.weight) || 1), 0);
  return clamp(100 * (1 - failed / possible));
}

function splitIssues(issues) {
  const seo = [];
  const geo = [];
  for (const i of issues) {
    if (i.category === GEO_CATEGORY) geo.push(i);
    else seo.push(i);
  }
  return { seo, geo };
}

/**
 * Build the full score block for a report.
 *
 * @param {Array} issues        all audit issues
 * @param {Object} opts
 * @param {number} opts.pages   number of content pages crawled
 * @param {number} opts.geoPossible  total GEO weight available on this crawl
 * @returns {{seo:number, geo:number, overall:number, counts:Object,
 *            seoWeighted:number, geoFailedWeight:number, geoPossible:number}}
 */
function scoreReport(issues, opts = {}) {
  const pages = Math.max(1, Number(opts.pages) || 1);
  const { seo, geo } = splitIssues(issues);

  const seoScore = densityScore(seo, pages);

  const geoPossible = Number(opts.geoPossible) > 0 ? Number(opts.geoPossible) : 0;
  const geoFailures = geo.map(i => ({ weight: i.geoWeight != null ? i.geoWeight : weightOf(i) }));
  const geoScore = geoPossible > 0
    ? coverageScore(geoFailures, geoPossible)
    : (geo.length ? 0 : 100);

  const overall = clamp(seoScore * 0.6 + geoScore * 0.4);

  return {
    seo: seoScore,
    geo: geoScore,
    overall,
    counts: countSeverities(issues),
    seoWeighted: seo.reduce((s, i) => s + weightOf(i), 0),
    geoFailedWeight: geoFailures.reduce((s, f) => s + f.weight, 0),
    geoPossible
  };
}

/**
 * What the score becomes if every auto-repairable issue is fixed.
 * Used to show a realistic ceiling before the user clicks Improve, and to
 * decide whether hitting the target is even possible.
 */
function projectScore(issues, opts = {}) {
  const remaining = issues.filter(i => !i.autoFixable);
  const projected = scoreReport(remaining, opts);
  return {
    ...projected,
    blockers: remaining.filter(i => !i.autoFixable)
  };
}

module.exports = {
  WEIGHTS,
  SEVERITIES,
  SEO_CATEGORIES,
  GEO_CATEGORY,
  DENSITY_K,
  scoreIssues,
  scoreReport,
  projectScore,
  densityScore,
  coverageScore,
  splitIssues,
  countSeverities,
  clamp,
  weightOf
};
