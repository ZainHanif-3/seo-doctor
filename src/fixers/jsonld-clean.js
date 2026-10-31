'use strict';

const { injectBeforeCloseHead, hasMeta, record } = require('./helpers');

/**
 * Broken JSON-LD is worse than none: Google reports "Could not parse" and the
 * entity data is discarded. Removing blocks that fail JSON.parse is safe —
 * they contribute nothing while they are invalid.
 */
function fix(html, ctx) {
  if (!ctx.invalidJsonLdIssues && !/application\/ld\+json/i.test(html)) return html;

  let removed = 0;
  const out = html.replace(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    (whole, body) => {
      const raw = String(body || '').trim();
      if (!raw) { removed += 1; return ''; }
      try {
        JSON.parse(raw);
        return whole;
      } catch {
        removed += 1;
        return '';
      }
    }
  );

  if (!removed) {
    record(ctx, { rule: 'jsonld-invalid', fixed: false, note: 'no unparseable JSON-LD found' });
    return html;
  }
  record(ctx, { rule: 'jsonld-invalid', fixed: true, detail: `removed ${removed} unparseable JSON-LD block(s)` });
  return out;
}

module.exports = { fix };
