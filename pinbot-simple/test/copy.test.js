'use strict';

const test = require('node:test');
const assert = require('node:assert');

process.env.ANTHROPIC_API_KEY = 'unused-invalid-key';
delete process.env.AI_COPYWRITER_MODE; // built-in remains the safe default
const config = require('../src/config');
const copy = require('../src/copy');

const kd = { id: 'kd', name: 'K.D. Publishing', marketplace: 'amazon', tagline: 'Books' };
const zb = { id: 'zb', name: 'ZeroBased UK', marketplace: 'etsy', tagline: 'Digital' };

const journal = { title: 'The 80-Day Gratitude Journal', kind: 'Paperback guided journal', keywords: ['gratitude journal'], notes: '80 daily gratitude prompts.' };
const puzzle = { title: 'Halloween Word Search', kind: 'Paperback word-search puzzle book', keywords: ['Halloween word search'], notes: '100 puzzles with a full answer key.' };
const digital = { title: 'UK Monthly Budget Planner', kind: 'Printable monthly budget planner', keywords: ['budget planner'], notes: '18-page A4 printable.' };

test('a puzzle book is never described as a journal', () => {
  for (let variant = 0; variant < 12; variant += 1) {
    const text = copy.offlineCopy(puzzle, kd, variant);
    assert.ok(!/journal/i.test(text.description), `variant ${variant} mentioned a journal: ${text.description}`);
  }
});

test('a journal is never described as a puzzle', () => {
  for (let variant = 0; variant < 12; variant += 1) {
    const text = copy.offlineCopy(journal, kd, variant);
    assert.ok(!/puzzle|word search|sudoku/i.test(text.description), `variant ${variant}: ${text.description}`);
  }
});

test('each brand gets the right call to action', () => {
  assert.match(copy.offlineCopy(journal, kd, 0).description, /Amazon/);
  assert.match(copy.offlineCopy(digital, zb, 0).description, /Etsy/);
});

test('repeat pins for one product do not read identically', () => {
  const seen = new Set();
  for (let variant = 0; variant < 6; variant += 1) {
    seen.add(copy.offlineCopy(journal, kd, variant).description);
  }
  assert.ok(seen.size >= 5, `expected varied copy, got ${seen.size} unique of 6`);
});

test('copy stays inside Pinterest length limits', () => {
  for (const [product, brand] of [[journal, kd], [puzzle, kd], [digital, zb]]) {
    for (let variant = 0; variant < 8; variant += 1) {
      const text = copy.offlineCopy(product, brand, variant);
      assert.ok(text.title.length <= 100, `title too long: ${text.title}`);
      assert.ok(text.description.length <= 480, 'description too long');
      assert.ok(text.title.length > 0 && text.description.length > 30);
    }
  }
});

test('keywords drop words that just repeat a longer phrase', () => {
  const keywords = copy.inferKeywords(digital, zb);
  assert.ok(keywords.includes('budget planner'));
  assert.ok(!keywords.includes('budget'), `redundant keyword kept: ${keywords.join(', ')}`);
});

test('hashtags are clean and never a bare fragment', () => {
  const tags = copy.toHashtags(['gratitude journal', 'a', 'daily journal'], 4, 0);
  assert.deepEqual(tags, ['#GratitudeJournal', '#DailyJournal']);
});

test('a product with no keywords still produces usable copy', () => {
  const bare = { title: 'Mystery Book', kind: '', keywords: [], notes: '' };
  const text = copy.offlineCopy(bare, kd, 0);
  assert.ok(text.title.length > 0);
  assert.ok(text.description.includes('Mystery Book'));
  assert.ok(text.keywords.length > 0);
});

test('audited copy does not add unsupported benefit or specification claims', () => {
  const products = [journal, puzzle, digital];
  for (const product of products) {
    const brand = product === digital ? zb : kd;
    for (let variant = 0; variant < 12; variant += 1) {
      const text = copy.offlineCopy(product, brand, variant).description;
      assert.doesNotMatch(text, /keep your mind sharp|large print|build a habit|actually finish|squint/i);
    }
  }
});

test('word-search copy uses cover-verified puzzle count and answer key', () => {
  const text = copy.offlineCopy(puzzle, kd, 0).description;
  assert.match(text, /100 themed word-search puzzles/i);
  assert.match(text, /full answer key/i);
});

test('journal copy is matched to each verified interior', () => {
  const calm = { title: 'The 80-Day Calm Journal', kind: 'Paperback guided journal', keywords: [], notes: '' };
  const confidence = { title: 'The 80-Day Confidence Journal', kind: 'Paperback guided journal', keywords: [], notes: '' };

  assert.match(copy.offlineCopy(calm, kd, 0).description, /daily check-ins.*brain-dump.*stress tracking/i);
  assert.match(copy.offlineCopy(journal, kd, 0).description, /gratitude prompt.*check-in.*Brain Dump/i);
  assert.match(copy.offlineCopy(confidence, kd, 0).description, /small brave thing.*confidence check-in/i);
});

test('generateCopy uses the built-in writer when paid AI mode is not enabled', async () => {
  const text = await copy.generateCopy(journal, kd, 0);
  assert.equal(text.source, 'offline');
});

test('a leftover Anthropic key does not enable paid AI calls by itself', () => {
  assert.equal(config.aiConfigured, false);
});

test('ZeroBased UK copy matches Christmas, debt and monthly-budget products', () => {
  const christmas = { title: 'Christmas Budget Planner', kind: 'Printable Christmas budget planner', keywords: [], notes: '' };
  const debt = { title: 'UK Debt Payoff Tracker', kind: 'Printable debt payoff tracker', keywords: [], notes: '' };
  const budget = { title: 'UK Monthly Budget Planner', kind: 'Printable monthly budget planner', keywords: [], notes: '' };

  assert.match(copy.offlineCopy(christmas, zb, 0).description, /gifts.*food.*travel.*clothing.*decorations/i);
  assert.match(copy.offlineCopy(debt, zb, 0).description, /balances.*interest rates.*minimum payments.*payoff dates/i);
  assert.match(copy.offlineCopy(budget, zb, 0).description, /planned and actual income.*spending.*savings.*debt/i);
});
