'use strict';

const { injectBeforeCloseHead, record } = require('./helpers');

function fix(html, ctx) {
  if (/<link\b[^>]*\brel\s*=\s*["'](shortcut\s+)?icon["']/i.test(html) ||
      /<link\b[^>]*\brel\s*=\s*["']apple-touch-icon["']/i.test(html)) {
    return html;
  }
  const href = ctx.faviconHref || '/favicon.svg';
  const out = injectBeforeCloseHead(html, `<link rel="icon" href="${href}" type="image/svg+xml">`);
  record(ctx, { rule: 'favicon', fixed: true, detail: `<link rel="icon" href="${href}">` });
  return out;
}

function generateFaviconSvg(siteName, color = '#22D3EE') {
  const letter = (String(siteName || 'S').trim()[0] || 'S').toUpperCase();
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">',
    `  <rect width="64" height="64" rx="14" fill="#06070B"/>`,
    `  <rect x="3" y="3" width="58" height="58" rx="11" fill="none" stroke="${color}" stroke-width="3"/>`,
    `  <text x="32" y="44" font-family="monospace" font-size="34" font-weight="bold" fill="${color}" text-anchor="middle">${letter}</text>`,
    '</svg>',
    ''
  ].join('\n');
}

module.exports = { fix, generateFaviconSvg };
