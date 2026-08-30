'use strict';

// Turns a pasted list of products into structured records, so adding a whole
// catalogue is one paste rather than one form per book.
//
// Accepted per line:
//   Title | https://...
//   Title <tab> https://...
//   https://...            (the title is guessed from the link)

const SKIP_SEGMENTS = new Set([
  'dp', 'gp', 'product', 'listing', 'shop', 'ref', 'uk', 'us', 'en', 'gb',
  'www', 'amazon', 'etsy', 'co', 'com', 'b', 'o', 'aw', 'd',
]);

function looksLikeIdentifier(segment) {
  if (/^\d+$/.test(segment)) return true; // Etsy listing ids
  if (/^[A-Z0-9]{10}$/.test(segment)) return true; // Amazon ASINs
  if (/^ref=/.test(segment)) return true;
  return false;
}

function titleCase(text) {
  return text
    .split(' ')
    .map((word) => (word.length > 2 ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ');
}

// Amazon and Etsy both put a readable slug in the path; use it when there is
// no title, rather than leaving the product nameless.
function titleFromUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_) {
    return '';
  }

  const segments = parsed.pathname
    .split('/')
    .map((s) => decodeURIComponent(s).trim())
    .filter(Boolean)
    .filter((s) => !SKIP_SEGMENTS.has(s.toLowerCase()) && !looksLikeIdentifier(s));

  const slug = segments.sort((a, b) => b.length - a.length)[0];
  if (!slug) return '';

  const words = slug.replace(/[-_+]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (words.length < 3) return '';
  return titleCase(words).slice(0, 200);
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch (_) {
    return false;
  }
}

// A share link like amazon.co.uk/dp/B0CXYZ1234 has no readable slug, so fall
// back to the identifier. The product still imports, but comes in paused so a
// placeholder name can never reach Pinterest.
function fallbackTitle(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_) {
    return '';
  }

  const id = parsed.pathname
    .split('/')
    .map((s) => s.trim())
    .filter((s) => looksLikeIdentifier(s) && !/^ref=/.test(s))
    .pop();

  const host = /etsy\./i.test(parsed.hostname) ? 'Etsy' : /amazon\./i.test(parsed.hostname) ? 'Amazon' : 'Product';
  return id ? `${host} ${id} - needs a name` : '';
}

function parseLine(rawLine) {
  const line = rawLine.trim();
  if (!line || line.startsWith('#')) return null;

  // Split on a pipe or a tab; a bare URL is also fine.
  const parts = line.split(/\s*\|\s*|\t+/).map((p) => p.trim()).filter(Boolean);
  const urlPart = parts.find(isHttpUrl);

  if (!urlPart) {
    return { error: 'no link found', line };
  }

  const titlePart = parts.find((p) => p !== urlPart && p.length > 0);
  const givenTitle = (titlePart || titleFromUrl(urlPart)).trim();
  const title = givenTitle || fallbackTitle(urlPart);

  if (!title) {
    return { error: 'could not work out a name - use "Name | link"', line };
  }

  return { title: title.slice(0, 200), url: urlPart, needsName: !givenTitle };
}

function parseList(text) {
  const items = [];
  const skipped = [];
  const seen = new Set();

  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    // Check for a repeat before anything else, so a duplicate always reports
    // as a duplicate rather than as whatever else is wrong with the line.
    const url = line.split(/\s*\|\s*|\t+/).map((p) => p.trim()).find(isHttpUrl);
    if (url && seen.has(url)) {
      skipped.push({ error: 'the same link appears twice', line });
      continue;
    }

    const parsed = parseLine(line);
    if (!parsed) continue;
    if (parsed.error) {
      skipped.push(parsed);
      continue;
    }

    seen.add(parsed.url);
    items.push(parsed);
  }

  return { items, skipped };
}

module.exports = { parseList, parseLine, titleFromUrl, fallbackTitle, isHttpUrl };
