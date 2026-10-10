'use strict';

const STOPWORDS = new Set(('a an and are as at be but by for from has have how i in is it its of on or that the this to was were what when where which who will with you your not can all our we they he she them us so if then than too very just about into over after before between out up down off again further once here there all any both each few more most other some such no nor only own same so too s t don should now').split(' '));

function normalizeInputUrl(input) {
  if (!input || typeof input !== 'string') return null;
  let u = input.trim();
  if (!u) return null;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(u)) u = 'https://' + u.replace(/^\/+/, '');
  let parsed;
  try { parsed = new URL(u); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname) return null;
  parsed.hash = '';
  return parsed.toString();
}

function siteKey(hostname) {
  return String(hostname || '').toLowerCase().replace(/^www\./, '');
}

function isSameSite(a, b) {
  try {
    return siteKey(new URL(a).hostname) === siteKey(new URL(b).hostname);
  } catch { return false; }
}

function absUrl(base, href) {
  if (!href) return null;
  const h = String(href).trim();
  if (!h || /^(#|mailto:|tel:|javascript:|data:|blob:|about:)/i.test(h)) return null;
  try { return new URL(h, base).toString(); } catch { return null; }
}

function stripHash(url) {
  try { const u = new URL(url); u.hash = ''; return u.toString(); } catch { return url; }
}

const PAGE_EXT_RE = /\.(css|js|mjs|png|jpe?g|gif|svg|webp|ico|avif|bmp|woff2?|ttf|otf|eot|mp4|webm|mp3|pdf|zip|gz|xml|json|txt|csv|rss|atom)$/i;

function looksLikePage(url) {
  try {
    const p = new URL(url).pathname;
    if (p === '/' || p.endsWith('/')) return true;
    return !PAGE_EXT_RE.test(p);
  } catch { return false; }
}

function mirrorRelPath(url) {
  let p;
  try { p = decodeURIComponent(new URL(url).pathname); } catch { p = '/'; }
  p = p.replace(/^\/+/, '');
  if (!p) p = 'index.html';
  else if (p.endsWith('/')) p += 'index.html';
  else if (!/\.[a-z0-9]{1,8}$/i.test(p)) p = p + '/index.html';
  return p.split('/').map(seg => seg.replace(/[<>:"|?*\\]/g, '_')).join('/');
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordCount(text) {
  const t = String(text || '').trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[_\-]+/g, ' ')
    .replace(/[^a-z0-9 ]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleCase(s) {
  return String(s || '').replace(/\b[a-z]/g, c => c.toUpperCase());
}

function deriveSiteName(host) {
  const base = siteKey(host).split('.')[0] || host || 'Website';
  const pretty = titleCase(base.replace(/[-_]+/g, ' '));
  return pretty || 'Website';
}

function firstSignificantWord(text) {
  const words = String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) || [];
  for (const w of words) {
    if (w.length >= 3 && !STOPWORDS.has(w)) return w;
  }
  return '';
}

function truncateSentence(text, target = 155, max = 160) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const window = t.slice(0, max);
  let cut = -1;
  for (const m of window.matchAll(/[.!?](?=\s|$)/g)) cut = m.index + 1;
  if (cut >= target - 40 && cut >= 60) return window.slice(0, cut).trim();
  const sp = window.lastIndexOf(' ');
  cut = sp > 60 ? sp : max;
  let out = window.slice(0, cut).trim().replace(/[,;:\-–]+$/, '');
  if (!/[.!?]$/.test(out)) out += '.';
  return out;
}

function truncateTitle(base, max = 60) {
  let t = String(base || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  t = (sp > 20 ? cut.slice(0, sp) : cut).replace(/[ \-–—|,]+$/, '').trim();
  if (!t) t = cut.trim();
  if (t.length > max) t = t.slice(0, max).trim();
  return t;
}

function truncateWords(text, maxWords = 40) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(' ');
  return words.slice(0, maxWords).join(' ');
}

function excerptFromText(text, words = 24) {
  return truncateWords(text, words);
}

function isHttps(url) {
  try { return new URL(url).protocol === 'https:'; } catch { return false; }
}

function originOf(url) {
  try { return new URL(url).origin; } catch { return ''; }
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

module.exports = {
  STOPWORDS, normalizeInputUrl, siteKey, isSameSite, absUrl, stripHash,
  looksLikePage, mirrorRelPath, escapeHtml, stripTags, wordCount, slugify,
  titleCase, deriveSiteName, firstSignificantWord, truncateSentence,
  truncateTitle, truncateWords, excerptFromText, isHttps, originOf, hostOf
};
