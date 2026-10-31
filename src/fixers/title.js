'use strict';

const { truncateTitle } = require('../util');
const { injectBeforeCloseHead, esc, record } = require('./helpers');

const TITLE_MIN = 30;

/**
 * Short titles are the one case `truncateTitle` cannot help with. Build a
 * longer variant from the site name and the page path, staying under 60.
 */
function padTitle(title, ctx) {
  if (title.length >= TITLE_MIN) return title;
  const siteName = ctx.siteName || '';
  const suffix = ctx.pathSuffix || '';
  const candidates = [
    siteName && `${title} – ${siteName}`,
    suffix && `${title} | ${suffix}`,
    suffix && siteName && `${title} | ${suffix} – ${siteName}`
  ].filter(Boolean);

  const fits = candidates.filter(t => t.length >= TITLE_MIN && t.length <= 60);
  if (fits.length) return fits[0];

  const under = candidates.filter(t => t.length <= 60).sort((a, b) => b.length - a.length);
  return under[0] || truncateTitle(title, 60);
}

function buildTitle(ctx) {
  const siteName = ctx.siteName || 'Website';
  let base = (ctx.h1 || '').trim() || (ctx.firstHeading || '').trim() || (ctx.existingTitle || '').trim();
  if (!base) base = siteName;
  base = base.replace(/\s+/g, ' ').trim();
  let title = base.toLowerCase() === siteName.toLowerCase() ? base : `${base} – ${siteName}`;
  if (title.toLowerCase() !== base.toLowerCase() && base.toLowerCase().endsWith(siteName.toLowerCase())) {
    title = base;
  }
  title = truncateTitle(title, 60);

  const reasons = ctx.titleIssues || [];
  if (reasons.includes('duplicate')) {
    const others = (ctx.otherTitles || []).map(t => t.toLowerCase());
    if (others.includes(title.toLowerCase())) {
      const suffix = ctx.pathSuffix ? ` | ${ctx.pathSuffix}` : '';
      title = truncateTitle(title + suffix, 60);
      if (others.includes(title.toLowerCase())) {
        title = truncateTitle(`${title} (${ctx.pageKey || 'page'})`, 60);
      }
    }
  }
  if (title.length > 60) title = truncateTitle(title, 60);
  if (title.length < TITLE_MIN) title = padTitle(title, ctx);
  if (title.length > 60) title = truncateTitle(title, 60);
  if (!title) title = truncateTitle(siteName, 60);
  return title;
}

function fix(html, ctx) {
  if (!ctx.titleIssues || !ctx.titleIssues.length) return html;
  const title = buildTitle(ctx);
  const existing = (ctx.existingTitle || '').trim();
  if (title === existing) {
    record(ctx, { rule: 'title', fixed: false, note: 'generated title already matches existing' });
    return html;
  }
  const re = /<title[^>]*>[\s\S]*?<\/title>/i;
  let out;
  if (re.test(html)) out = html.replace(re, `<title>${esc(title)}</title>`);
  else out = injectBeforeCloseHead(html, `<title>${esc(title)}</title>`);
  ctx.title = title;
  record(ctx, { rule: 'title', fixed: true, detail: `${existing ? existing : '(none)'} → ${title}` });
  return out;
}

module.exports = { fix, buildTitle };
