'use strict';

const test = require('node:test');
const assert = require('node:assert');

const importer = require('../src/import');

test('reads "Name | link" lines', () => {
  const { items } = importer.parseList('80-Day Gratitude Journal | https://www.amazon.co.uk/dp/B0CXYZ1234');
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '80-Day Gratitude Journal');
  assert.equal(items[0].url, 'https://www.amazon.co.uk/dp/B0CXYZ1234');
  assert.equal(items[0].needsName, false);
});

test('reads tab-separated lines pasted from a spreadsheet', () => {
  const { items } = importer.parseList('Word Search Vol. 1\thttps://www.amazon.co.uk/dp/B0CABC5678');
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Word Search Vol. 1');
});

test('takes a name from an Etsy link when none is given', () => {
  const { items } = importer.parseList('https://www.etsy.com/uk/listing/1234567890/monthly-budget-planner-printable');
  assert.equal(items[0].title, 'Monthly Budget Planner Printable');
  assert.equal(items[0].needsName, false);
});

test('a bare Amazon share link imports but is flagged for naming', () => {
  const { items } = importer.parseList('https://www.amazon.co.uk/dp/B0CABC5678');
  assert.equal(items.length, 1);
  assert.equal(items[0].needsName, true, 'must be flagged so it imports paused');
  assert.match(items[0].title, /needs a name/);
});

test('a title is never left as an ASIN or a listing id', () => {
  assert.equal(importer.titleFromUrl('https://www.amazon.co.uk/dp/B0CABC5678'), '');
  assert.equal(importer.titleFromUrl('https://www.etsy.com/uk/listing/1234567890'), '');
});

test('tracking junk in the path does not become the name', () => {
  const title = importer.titleFromUrl('https://www.amazon.co.uk/80-Day-Gratitude-Journal/dp/B0CXYZ1234/ref=sr_1_1');
  assert.equal(title, '80 Day Gratitude Journal');
});

test('blank lines and # comments are ignored', () => {
  const { items, skipped } = importer.parseList('\n\n# my books\nA Book | https://example.com/a\n\n');
  assert.equal(items.length, 1);
  assert.equal(skipped.length, 0);
});

test('a repeated link is reported as a duplicate, not a naming problem', () => {
  const { items, skipped } = importer.parseList([
    'A Book | https://example.com/a',
    'A Book Again | https://example.com/a',
  ].join('\n'));

  assert.equal(items.length, 1);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].error, /twice/);
});

test('a line with no link is skipped with a readable reason', () => {
  const { skipped } = importer.parseList('just some notes I pasted by accident');
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].error, /no link/);
});

test('a non-http link is not accepted', () => {
  assert.equal(importer.isHttpUrl('javascript:alert(1)'), false);
  assert.equal(importer.isHttpUrl('file:///etc/passwd'), false);
  assert.equal(importer.isHttpUrl('https://www.etsy.com/listing/1'), true);
});
