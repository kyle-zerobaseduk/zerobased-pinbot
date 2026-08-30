'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert');

// Point the app at a throwaway data directory before anything reads config.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pinbot-test-'));
process.env.DATA_DIR = tmp;
process.env.TZ = 'Europe/London';
delete process.env.ANTHROPIC_API_KEY; // force the offline copywriter

const { Db } = require('../src/db');
const engine = require('../src/engine');
const time = require('../src/time');

let counter = 0;
function freshDb() {
  counter += 1;
  return new Db(path.join(tmp, `db-${counter}.json`));
}

function addProduct(db, brandId, title) {
  const product = db.addProduct({ brandId, title, url: `https://example.com/${title}` });
  db.addImage(product.id, { url: `https://example.com/${title}.jpg` });
  return db.product(product.id);
}

test('starts paused and in simulation mode', () => {
  const db = freshDb();
  assert.equal(db.data.settings.paused, true);
  assert.equal(db.data.settings.liveMode, false);
});

test('rotation spreads pins across products instead of repeating one', async () => {
  const db = freshDb();
  ['Journal A', 'Journal B', 'Journal C'].forEach((t) => addProduct(db, 'kd', t));

  const now = new Date('2026-08-30T05:00:00Z');
  const created = await engine.planBrand(db, db.brand('kd'), now);

  assert.ok(created.length >= 3, `expected several pins, got ${created.length}`);
  const firstThree = created.slice(0, 3).map((p) => p.productId);
  assert.equal(new Set(firstThree).size, 3, 'first three pins should use three different products');
});

test('planner respects the daily cap and never schedules into the past', async () => {
  const db = freshDb();
  db.setSettings({ maxPerDay: 2, planAheadDays: 1 });
  addProduct(db, 'kd', 'Word Search Vol 1');

  // 14:00 London is after the 09:00 and 13:00 slots, leaving only 18:00 today.
  const now = new Date('2026-08-30T13:00:00Z');
  const created = await engine.planBrand(db, db.brand('kd'), now);

  assert.equal(created.length, 1);
  assert.ok(Date.parse(created[0].scheduledFor) > now.getTime());
  assert.equal(time.localTime(new Date(created[0].scheduledFor), 'Europe/London'), '18:00');
});

test('planning is idempotent - running twice does not double-book a slot', async () => {
  const db = freshDb();
  addProduct(db, 'zb', 'Budget Planner');
  const now = new Date('2026-08-30T05:00:00Z');

  const first = await engine.planBrand(db, db.brand('zb'), now);
  const second = await engine.planBrand(db, db.brand('zb'), now);

  assert.ok(first.length > 0);
  assert.equal(second.length, 0);
});

test('nothing is planned for a brand with no usable products', async () => {
  const db = freshDb();
  const product = db.addProduct({ brandId: 'kd', title: 'No Image Yet', url: 'https://example.com/x' });
  assert.equal(product.images.length, 0);

  const created = await engine.planBrand(db, db.brand('kd'), new Date('2026-08-30T05:00:00Z'));
  assert.equal(created.length, 0);
});

test('due pins post in simulation mode and update rotation counters', async () => {
  const db = freshDb();
  const product = addProduct(db, 'kd', 'Puzzle Book');
  const pin = db.addPin({
    brandId: 'kd',
    productId: product.id,
    imageId: product.images[0].id,
    title: 'Puzzle Book',
    description: 'A description.',
    link: product.url,
    scheduledFor: new Date('2026-08-30T05:00:00Z').toISOString(),
  });

  db.setSettings({ paused: false });
  const posted = await engine.runDue(db, new Date('2026-08-30T06:00:00Z'));

  assert.equal(posted.length, 1);
  assert.equal(db.pin(pin.id).status, 'simulated');
  assert.equal(db.product(product.id).pinCount, 1);
  assert.equal(db.product(product.id).images[0].uses, 1);
  assert.ok(db.product(product.id).lastPinnedAt);
});

test('a global pause stops everything from posting', async () => {
  const db = freshDb();
  const product = addProduct(db, 'kd', 'Paused Book');
  db.addPin({
    brandId: 'kd',
    productId: product.id,
    imageId: product.images[0].id,
    title: 'x',
    description: 'y',
    link: product.url,
    scheduledFor: new Date('2026-08-30T05:00:00Z').toISOString(),
  });

  const posted = await engine.runDue(db, new Date('2026-08-30T06:00:00Z'));
  assert.equal(posted.length, 0);
});

test('pausing one brand leaves the other brand posting', async () => {
  const db = freshDb();
  db.setSettings({ paused: false });
  db.brand('kd').paused = true;
  db.save();

  for (const brandId of ['kd', 'zb']) {
    const product = addProduct(db, brandId, `Item ${brandId}`);
    db.addPin({
      brandId,
      productId: product.id,
      imageId: product.images[0].id,
      title: 'x',
      description: 'y',
      link: product.url,
      scheduledFor: new Date('2026-08-30T05:00:00Z').toISOString(),
    });
  }

  const posted = await engine.runDue(db, new Date('2026-08-30T06:00:00Z'));
  assert.equal(posted.length, 1);
  assert.equal(posted[0].brandId, 'zb');
});

test('a pin whose image was deleted retries then fails with a readable reason', async () => {
  const db = freshDb();
  db.setSettings({ paused: false });
  const product = addProduct(db, 'kd', 'Broken');
  const pin = db.addPin({
    brandId: 'kd',
    productId: product.id,
    imageId: 'img_missing',
    title: 'x',
    description: 'y',
    link: product.url,
    scheduledFor: new Date('2026-08-30T05:00:00Z').toISOString(),
  });

  for (let i = 0; i < engine.MAX_ATTEMPTS; i += 1) {
    await engine.postPin(db, db.pin(pin.id));
  }

  const finished = db.pin(pin.id);
  assert.equal(finished.status, 'failed');
  assert.equal(finished.attempts, engine.MAX_ATTEMPTS);
  assert.match(finished.error, /missing/i);
});

test('deleting a product clears its queued pins but keeps posted history', () => {
  const db = freshDb();
  const product = addProduct(db, 'kd', 'Gone Soon');
  db.addPin({ brandId: 'kd', productId: product.id, title: 'q', description: 'd', link: 'u', scheduledFor: new Date().toISOString() });
  const posted = db.addPin({ brandId: 'kd', productId: product.id, title: 'p', description: 'd', link: 'u', scheduledFor: new Date().toISOString(), status: 'simulated' });

  db.deleteProduct(product.id);

  assert.equal(db.pins({ status: 'queued' }).length, 0);
  assert.ok(db.pin(posted.id), 'posted pin should survive');
});

test('a corrupt data file is parked, not lost, and the app still starts', () => {
  const file = path.join(tmp, 'corrupt.json');
  fs.writeFileSync(file, '{ this is not json');
  const db = new Db(file);

  assert.equal(db.brands().length, 2);
  const parked = fs.readdirSync(tmp).filter((f) => f.startsWith('corrupt.json.corrupt-'));
  assert.equal(parked.length, 1);
});
