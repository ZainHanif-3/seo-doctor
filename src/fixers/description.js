'use strict';

const { truncateSentence, excerptFromText, stripTags } = require('../util');
const { injectBeforeCloseHead, replaceMetaBy, esc, record } = require('./helpers');

function buildDescription(ctx) {
  const reasons = ctx.descIssues || [];
  if (reasons.includes('long') && ctx.existingDescription) {
    return truncateSentence(ctx.existingDescription, 155, 160);
  }
  const source = (ctx.firstParagraph || '').trim();
  if (source.length >= 40) return truncateSentence(source, 155, 160);
  const body = stripTags(ctx.bodyHtml || '');
  if (body.length >= 60) return excerptFromText(body, 26);
  if (ctx.h1) return truncateSentence(`${ctx.h1}. ${ctx.siteName || ''}`, 155, 160);
  return '';
}

function fix(html, ctx) {
  if (!ctx.descIssues || !ctx.descIssues.length) return html;
  const desc = buildDescription(ctx);
  if (!desc || desc.length < 30) {
    record(ctx, { rule: 'description', fixed: false, note: 'no source text available to derive a description' });
    return html;
  }
  const tag = `<meta name="description" content="${esc(desc)}">`;
  const res = replaceMetaBy(html, /\bname\s*=\s*["']description["']/i, tag);
  const out = res.replaced ? res.html : injectBeforeCloseHead(res.html, tag);
  ctx.description = desc;
  record(ctx, { rule: 'description', fixed: true, detail: desc });
  return out;
}

module.exports = { fix, buildDescription };
