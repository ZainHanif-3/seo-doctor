'use strict';

const WEIGHTS = { critical: 10, high: 6, medium: 3, low: 1 };
const SEVERITIES = ['critical', 'high', 'medium', 'low'];

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

module.exports = { WEIGHTS, SEVERITIES, scoreIssues };
