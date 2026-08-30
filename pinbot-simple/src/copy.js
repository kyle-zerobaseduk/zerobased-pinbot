'use strict';

const config = require('./config');

// Rotating angles keep repeat pins for the same product from reading identically.
// Each angle is a complete sentence, so the offline writer never has to glue
// fragments together and produce awkward grammar. K.D. Publishing sells two
// quite different things, so its angles are split by product type - a puzzle
// book should never be described as a journal.
const ANGLES = {
  kd_calm: [
    'The 80-day format includes daily check-ins, brain-dump space and stress tracking.',
    'Brain-dump pages give you space to record thoughts alongside the daily check-in.',
    'A 1-10 scale, regular pause points and a final reflection support the 80 daily entries.',
    'Progress tracking and notes pages are included alongside the daily entries.',
    'The journal is organised around 80 daily entries focused on calm and stress relief.',
    'Ten-day pause points are included for reviewing progress.',
  ],
  kd_gratitude: [
    'Each of the 80 days includes a gratitude prompt, check-in and Brain Dump section.',
    'A mood scale and optional 4-7-8 breathing exercise sit alongside the daily prompt.',
    'The journal is organised around 80 daily gratitude prompts.',
    'Regular pause points and a final reflection are included in the 80-day structure.',
    'The daily pages combine a gratitude prompt with space for reflection.',
    'Progress tracking and notes pages are included.',
  ],
  kd_confidence: [
    'Each daily entry includes a prompt, a small brave thing and a confidence check-in.',
    'Mind vs. Truth sections and a confidence scale are built into the 80-day structure.',
    'The journal includes 80 daily confidence challenges and an evidence locker.',
    'Starting-point ratings, regular pause points and a final reflection are included.',
    'Optional 4-7-8 breathing sits alongside the daily confidence practice.',
    'Progress tracking and notes pages support the 80 daily entries.',
  ],
  kd_puzzle: [
    'The paperback contains 100 themed word-search puzzles and a full answer key.',
    'A full answer key is included for checking the 100 completed puzzles.',
    'All 100 word searches follow the theme shown on the cover.',
    'The puzzles and full answer key are collected in one paperback.',
    'The book contains 100 word-search puzzles.',
    'The answer key is included in the book.',
  ],
  kd: [
    'This is a physical paperback available from Amazon.',
    'Published by K.D. Publishing as a paperback.',
    'The Amazon listing contains the full product details.',
    'This is a printed book rather than a digital download.',
  ],
  zb_christmas: [
    'The planner covers gifts, food, travel, clothing, decorations and other festive expenses.',
    'It includes Christmas budgeting, savings goals, gift tracking, expense tracking and spending summaries.',
    'Both UK A4 with pounds and US Letter with dollars PDF versions are included.',
    'Six savings challenges are included alongside the planning pages.',
    'Online-order, delivery and gift-wrapping trackers are included.',
    'Post-Christmas spending and debt-payoff planning pages are included.',
  ],
  zb_debt: [
    'The debt table records balances, interest rates, minimum payments and payoff dates.',
    'Both Avalanche and Snowball payoff methods are explained.',
    'A 36-month payment log covers 2026, 2027 and 2028.',
    'A 100-block visual progress tracker is included.',
    'The printable includes a worked UK example and Zero-Based Budget integration.',
    'BNPL and Klarna guidance is included.',
  ],
  zb_budget: [
    'The zero-based monthly budget compares planned and actual income, spending, savings and debt.',
    'The 18-page planner includes bills, variable spending, savings and sinking-fund trackers.',
    'A worked UK monthly-budget example is included.',
    'Subscription, debt-snapshot, no-spend and net-worth pages are included.',
    'The sinking-funds page covers Christmas, MOTs, holidays and emergencies.',
    'The printable uses UK pounds and is formatted for A4 paper.',
  ],
  zb: [
    'This is an instant digital download supplied as a printable PDF.',
    'The pages are designed to be printed and filled in by hand.',
    'No physical item is shipped.',
    'The product is sold by ZeroBased UK on Etsy.',
    'The PDF opens in a standard PDF viewer.',
    'Print the relevant pages when they are needed.',
  ],
};

// K.D. Publishing covers journals and puzzle books; pick the matching voice.
function anglesFor(product, brand) {
  const haystack = `${product.title} ${product.kind || ''}`.toLowerCase();
  if (brand.id === 'zb') {
    if (/christmas|festive|gift/.test(haystack)) return [...ANGLES.zb_christmas, ...ANGLES.zb];
    if (/debt|payoff|snowball|avalanche/.test(haystack)) return [...ANGLES.zb_debt, ...ANGLES.zb];
    if (/budget|money|finance|planner/.test(haystack)) return [...ANGLES.zb_budget, ...ANGLES.zb];
    return ANGLES.zb;
  }
  if (brand.id !== 'kd') return ANGLES[brand.id] || ANGLES.zb;

  if (/puzzle|word ?search|sudoku|crossword|maze|activity|game/.test(haystack)) {
    return [...ANGLES.kd_puzzle, ...ANGLES.kd];
  }
  if (/calm|stress[- ]?relief/.test(haystack)) return [...ANGLES.kd_calm, ...ANGLES.kd];
  if (/gratitude/.test(haystack)) return [...ANGLES.kd_gratitude, ...ANGLES.kd];
  if (/confidence|self[- ]?belief/.test(haystack)) return [...ANGLES.kd_confidence, ...ANGLES.kd];
  return ANGLES.kd;
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
    base = ['puzzle book', 'word search book', 'themed word searches', 'kdp books'];
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
- Use only facts present in the product title, type, seller notes or supplied angle.
- Do not invent prices, review counts, awards, benefits, audiences, specifications or delivery claims.

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
