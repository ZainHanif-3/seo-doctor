'use strict';

const { firstSignificantWord, slugify } = require('../util');

const THIN_WORDS = 300;

function headingSkip(headings) {
  let prev = 0;
  const skips = [];
  for (const h of headings) {
    if (prev && h.level > prev + 1) skips.push(`h${prev}→h${h.level}`);
    prev = h.level;
  }
  if (headings.length && headings[0].level > 2 && !headings.some(h => h.level === 1)) {
    skips.push(`starts at h${headings[0].level}`);
  }
  return skips;
}

function run(ctx) {
  const issues = [];
  const pages = ctx.pages;

  for (const p of pages) {
    const pr = p.parsed;
    const url = p.finalUrl || p.url;

    // ---- H1 ----
    if (pr.h1s.length === 0) {
      issues.push(ctx.mk({
        rule: 'h1', severity: 'high', category: 'content', page: url, pages: [url],
        title: 'Missing <h1>',
        message: 'The page has no H1 — the primary topic heading that search engines and users read first.',
        evidence: pr.headings.length
          ? `first heading found: <h${pr.headings[0].level}> "${pr.headings[0].text}"`
          : 'no headings found on the page',
        fixable: true, autoFixable: true,
        advice: 'Add exactly one H1 that describes the page and includes the primary keyword.'
      }));
    } else if (pr.h1s.length > 1) {
      issues.push(ctx.mk({
        rule: 'h1', severity: 'medium', category: 'content', page: url, pages: [url],
        title: 'Multiple <h1> tags',
        message: `${pr.h1s.length} H1 tags found — multiple H1s dilute the page's main topic.`,
        evidence: pr.h1s.map(h => `"${h}"`).join(' | '),
        fixable: true, autoFixable: true,
        advice: 'Keep one H1; demote the rest to H2.'
      }));
    }

    // ---- heading level skips ----
    const skips = headingSkip(pr.headings);
    if (skips.length) {
      issues.push(ctx.mk({
        rule: 'heading-skip', severity: 'low', category: 'content', page: url, pages: [url],
        title: 'Skipped heading levels',
        message: 'Heading levels jump (e.g. h1 → h3), which breaks document outline semantics.',
        evidence: skips.join(', '),
        fixable: true, autoFixable: true,
        advice: 'Use headings in strict order: h1 → h2 → h3, without skipping levels.'
      }));
    }

    // ---- thin content ----
    if (pr.wordCount > 0 && pr.wordCount < THIN_WORDS) {
      issues.push(ctx.mk({
        rule: 'thin', severity: 'medium', category: 'content', page: url, pages: [url],
        title: `Thin content (${pr.wordCount} words)`,
        message: `Only ${pr.wordCount} words of body text — pages under ${THIN_WORDS} words rarely rank.`,
        evidence: `"${(pr.bodyText || '').slice(0, 140)}…"`,
        fixable: false,
        advice: `Expand the page to at least ${THIN_WORDS} words of unique, useful copy.`
      }));
    }

    // ---- image alt ----
    const badAlt = pr.images.filter(im => im.alt == null || String(im.alt).trim() === '');
    if (badAlt.length) {
      issues.push(ctx.mk({
        rule: 'img-alt', severity: 'high', category: 'content', page: url, pages: [url],
        title: `${badAlt.length} image(s) missing alt text`,
        message: 'Images without alt text are invisible to search engines and screen readers.',
        evidence: badAlt.map(im => `<img src="${im.src || '(no src)'}">`).join('; ').slice(0, 300),
        fixable: true, autoFixable: true,
        advice: 'Describe each image in under 125 characters; use alt="" only for decorative images.'
      }));
    }

    // ---- image dimensions (CLS) ----
    const noDims = pr.images.filter(im => im.src && (!im.width || !im.height));
    if (noDims.length) {
      issues.push(ctx.mk({
        rule: 'img-dimensions', severity: 'medium', category: 'content', page: url, pages: [url],
        title: `${noDims.length} image(s) without width/height`,
        message: 'Images without explicit dimensions cause layout shift (CLS) as the page loads.',
        evidence: noDims.map(im => `<img src="${im.src}">`).join('; ').slice(0, 300),
        fixable: true, autoFixable: true,
        advice: 'Add width/height attributes matching the intrinsic image size.'
      }));
    }

    // ---- keyword presence ----
    const kw = firstSignificantWord(pr.h1s[0] || pr.title);
    if (kw) {
      if (pr.h1s.length && pr.title && !pr.title.toLowerCase().includes(kw)) {
        issues.push(ctx.mk({
          rule: 'keyword-title', severity: 'low', category: 'content', page: url, pages: [url],
          title: 'Primary keyword missing from title',
          message: `The H1 keyword "${kw}" does not appear in the title tag.`,
          evidence: `H1 keyword: "${kw}" — title: "${pr.title}"`,
          fixable: false,
          advice: `Work the word "${kw}" into the title tag naturally.`
        }));
      }
      if (pr.description && !pr.description.toLowerCase().includes(kw)) {
        issues.push(ctx.mk({
          rule: 'keyword-description', severity: 'low', category: 'content', page: url, pages: [url],
          title: 'Primary keyword missing from description',
          message: `The primary keyword "${kw}" does not appear in the meta description.`,
          evidence: `keyword: "${kw}" — description: "${pr.description.slice(0, 110)}"`,
          fixable: false,
          advice: `Include "${kw}" once in the description, naturally (no keyword stuffing).`
        }));
      }
    }

    void slugify;
  }

  return issues;
}

module.exports = { run, headingSkip };
