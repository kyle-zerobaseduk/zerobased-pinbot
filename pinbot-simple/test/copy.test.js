'use strict';

const test = require('node:test');
const assert = require('node:assert');

delete process.env.ANTHROPIC_API_KEY; // exercise the built-in writer
const copy = require('../src/copy');

const kd = { id: 'kd', name: 'K.D. Publishing', marketplace: 'amazon', tagline: 'Books' };
const zb = { id: 'zb', name: 'ZeroBased UK', marketplace: 'etsy', tagline: 'Digital' };

const journal = { title: '80-Day Gratitude Journal', kind: 'Paperback journal', keywords: ['gratitude journal'], notes: 'Undated.' };
const puzzle = { title: 'Large Print Word Search Vol. 1', kind: 'Puzzle book', keywords: ['word search book'], notes: '' };
const digital = { title: 'Monthly Budget Planner Bundle', kind: 'Printable PDF', keywords: ['budget planner'], notes: '12 pages.' };

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

test('generateCopy falls back to the built-in writer with no API key', async () => {
  const text = await copy.generateCopy(journal, kd, 0);
  assert.equal(text.source, 'offline');
});
