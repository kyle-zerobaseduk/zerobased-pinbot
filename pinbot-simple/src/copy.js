'use strict';

const config = require('./config');

// Rotating angles keep repeat pins for the same product from reading identically.
// Each angle is a complete sentence, so the offline writer never has to glue
// fragments together and produce awkward grammar.
// Each angle is a complete sentence, so the offline writer never has to glue
// fragments together and produce awkward grammar. K.D. Publishing sells two
// quite different things, so its angles are split by product type - a puzzle
// book should never be described as a journal.
const ANGLES = {
  kd_journal: [
    'There is something calming about sitting down with a paper journal and no screen in sight.',
    'Eighty days is long enough to build a habit and short enough to actually finish.',
    'A prompt on every page, so you are never staring at a blank one.',
    'It slots neatly into a morning coffee or a wind-down before bed.',
    'Undated pages mean you can start today rather than in January.',
    'Filling in one page a day adds up faster than you would expect.',
  ],
  kd_puzzle: [
    'One puzzle a day is an easy way to keep your mind sharp.',
    'Large print throughout, so solving stays relaxed rather than a squint.',
    'A good way to spend downtime away from a screen and give your eyes a rest.',
    'Finishing a grid and moving on to the next one is quietly satisfying.',
    'Easy enough to dip into for ten minutes, meaty enough for a long evening.',
    'Plenty of puzzles inside, so it lasts well beyond the first week.',
  ],
  kd: [
    'It makes a thoughtful gift for anyone who prefers paper to a screen.',
    'Print, paper and a pen - no app, no battery, no notifications.',
    'Small enough for a bag, sturdy enough to actually get used.',
    'A simple thing done properly, which is the whole idea.',
  ],
  zb: [
    'Starting from a ready-made template beats staring at a blank page.',
    'It is an instant download, so you can be using it within minutes.',
    'Get organised without signing up for yet another app or subscription.',
    'A clean, printable layout that looks right on paper and on screen.',
    'Set the system up once and you will actually keep using it.',
    'One small purchase that tidies up a whole messy process.',
    'Made in the UK, with UK dates, spelling and currency.',
    'Edit it once and reuse it every single month.',
  ],
};

// K.D. Publishing covers journals and puzzle books; pick the matching voice.
function anglesFor(product, brand) {
  if (brand.id !== 'kd') return ANGLES[brand.id] || ANGLES.zb;

  const haystack = `${product.title} ${product.kind || ''}`.toLowerCase();
  if (/puzzle|word ?search|sudoku|crossword|maze|activity|game/.test(haystack)) {
    return [...ANGLES.kd_puzzle, ...ANGLES.kd];
  }
  if (/journal|diary|planner|gratitude|reflection|prompt/.test(haystack)) {
    return [...ANGLES.kd_journal, ...ANGLES.kd];
  }
  return [...ANGLES.kd, ...ANGLES.kd_journal];
}

const CTA = {
  amazon: 'Tap to see it on Amazon.',
  etsy: 'Tap through to the Etsy listing.',
};

function titleCase(text) {
  return text.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1));
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = item.toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item.trim());
  }
  return out;
}

// "budget" adds nothing once "budget planner" is already in the list.
function dropRedundant(list) {
  return list.filter((item, index) => !list.some((other, otherIndex) => (
    otherIndex !== index
    && other.length > item.length
    && other.toLowerCase().split(/\s+/).includes(item.toLowerCase())
  )));
}

function toHashtags(keywords, limit = 4, offset = 0) {
  // Multi-word phrases make far better hashtags than stray single words.
  const usable = dedupe(keywords).filter((k) => k.length > 5 && /[a-z]{3}/i.test(k));
  if (usable.length === 0) return [];
  const picked = [];
  for (let i = 0; i < Math.min(limit, usable.length); i += 1) {
    picked.push(usable[(offset + i) % usable.length]);
  }
  return dedupe(picked)
    .map((k) => `#${titleCase(k).replace(/[^A-Za-z0-9]/g, '')}`)
    .filter((h) => h.length > 3);
}

// Guess useful keywords from the product itself so the offline writer is not empty-handed.
function inferKeywords(product, brand) {
  const words = `${product.title} ${product.kind || ''}`
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !['with', 'from', 'this', 'that', 'your', 'book', 'pack'].includes(w));

  // Staple search terms, matched to what the product actually is - a puzzle
  // book should not pick up "guided journal" hashtags.
  const haystack = `${product.title} ${product.kind || ''}`.toLowerCase();
  let base;
  if (brand.id !== 'kd') {
    base = ['digital download', 'printable', 'etsy shop', 'instant download'];
  } else if (/puzzle|word ?search|sudoku|crossword|maze|activity|game/.test(haystack)) {
    base = ['puzzle book', 'word search book', 'large print puzzles', 'kdp books'];
  } else if (/journal|diary|planner|gratitude|reflection|prompt/.test(haystack)) {
    base = ['guided journal', 'daily journal', 'journal prompts', 'kdp books'];
  } else {
    base = ['paperback book', 'kdp books', 'gift books'];
  }

  // Order matters: the seller's own keywords first, then brand staples, then
  // anything scraped out of the title as a last resort.
  return dropRedundant(dedupe([...(product.keywords || []), ...base, ...words.slice(0, 4)])).slice(0, 8);
}

function offlineCopy(product, brand, variant = 0) {
  const angles = anglesFor(product, brand);
  const angle = angles[variant % angles.length];
  const keywords = inferKeywords(product, brand);
  const cta = CTA[brand.marketplace] || 'Tap through for the full details.';

  const titleVariants = [
    product.title,
    `${product.title} | ${brand.name}`,
    `${product.title} — ${product.kind || (brand.id === 'kd' ? 'Paperback' : 'Digital Download')}`,
  ];
  const title = titleVariants[variant % titleVariants.length].slice(0, 100);

  const description = [
    `${product.title}.`,
    angle,
    product.notes ? product.notes.trim() : '',
    cta,
    toHashtags(keywords, 4, variant).join(' '),
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, 480);

  return { title, description, keywords, source: 'offline' };
}

async function aiCopy(product, brand, variant) {
  const prompt = `Write Pinterest pin copy for one product.

Brand: ${brand.name} (${brand.tagline})
Sold on: ${brand.marketplace === 'amazon' ? 'Amazon' : 'Etsy'}
Product title: ${product.title}
Product type: ${product.kind || 'not specified'}
Seller notes: ${product.notes || 'none'}
Existing keywords: ${(product.keywords || []).join(', ') || 'none'}
Angle to lean on for this variation: ${anglesFor(product, brand)[variant % anglesFor(product, brand).length]}

Rules:
- British English. Warm and plain-spoken, never hypey. No emoji spam (at most one).
- Pinterest title: max 95 characters, readable, includes the main search term.
- Description: 2 to 3 short sentences, max 400 characters, ending with 3-4 relevant hashtags.
- Keywords: 6 to 8 lowercase Pinterest search phrases people would actually type.
- Do not invent prices, review counts, awards or delivery claims.

Reply with JSON only, exactly this shape:
{"title": "...", "description": "...", "keywords": ["...", "..."]}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': config.anthropic.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: config.anthropic.model,
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic API ${response.status}: ${body.slice(0, 200)}`);
  }

  const payload = await response.json();
  const text = (payload.content || []).map((block) => block.text || '').join('').trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AI reply was not JSON');

  const parsed = JSON.parse(match[0]);
  if (!parsed.title || !parsed.description) throw new Error('AI reply missing title or description');

  return {
    title: String(parsed.title).slice(0, 100),
    description: String(parsed.description).slice(0, 480),
    keywords: Array.isArray(parsed.keywords) ? parsed.keywords.map(String).slice(0, 8) : [],
    source: 'ai',
  };
}

// Always returns something usable: AI when a key is configured, otherwise the
// built-in writer. An AI failure quietly falls back rather than breaking a pin.
async function generateCopy(product, brand, variant = 0, logger) {
  if (config.aiConfigured) {
    try {
      return await aiCopy(product, brand, variant);
    } catch (err) {
      if (logger) logger('warn', `AI copy failed, using built-in writer: ${err.message}`);
    }
  }
  return offlineCopy(product, brand, variant);
}

module.exports = { generateCopy, offlineCopy, inferKeywords, toHashtags, anglesFor, ANGLES };
