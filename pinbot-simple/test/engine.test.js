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
const pinterest = require('../src/pinterest');
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
  db.updatePin(pin.id, { approvedForPublishing: true, approvedAt: new Date().toISOString() });

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
    const pin = db.addPin({
      brandId,
      productId: product.id,
      imageId: product.images[0].id,
      title: 'x',
      description: 'y',
      link: product.url,
      scheduledFor: new Date('2026-08-30T05:00:00Z').toISOString(),
    });
    db.updatePin(pin.id, { approvedForPublishing: true, approvedAt: new Date().toISOString() });
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
  db.updatePin(pin.id, { approvedForPublishing: true, approvedAt: new Date().toISOString() });

  for (let i = 0; i < engine.MAX_ATTEMPTS; i += 1) {
    await engine.postPin(db, db.pin(pin.id));
  }

  const finished = db.pin(pin.id);
  assert.equal(finished.status, 'failed');
  assert.equal(finished.attempts, engine.MAX_ATTEMPTS);
  assert.match(finished.error, /missing/i);
});

test('new and planned drafts are Not approved by default', async () => {
  const db = freshDb();
  const product = addProduct(db, 'kd', 'Approval Default');
  const direct = db.addPin({
    brandId: 'kd',
    productId: product.id,
    imageId: product.images[0].id,
    title: 'Direct draft',
    description: 'Review me.',
    link: product.url,
    scheduledFor: new Date().toISOString(),
  });
  assert.equal(direct.approvedForPublishing, false);
  assert.equal(direct.approvedAt, null);

  const planned = await engine.planBrand(db, db.brand('kd'), new Date('2026-08-30T05:00:00Z'));
  assert.ok(planned.length > 0);
  assert.ok(planned.every((pin) => pin.approvedForPublishing === false));
});

test('an unapproved due draft cannot reach the production Pinterest call', async () => {
  const db = freshDb();
  const product = addProduct(db, 'kd', 'Blocked Live Draft');
  const pin = db.addPin({
    brandId: 'kd',
    productId: product.id,
    imageId: product.images[0].id,
    boardId: 'board-1',
    title: 'Never send this',
    description: 'Unapproved.',
    link: product.url,
    scheduledFor: new Date('2026-08-30T05:00:00Z').toISOString(),
  });
  db.brand('kd').pinterest = { accessToken: 'production-token', expiresAt: new Date(Date.now() + 86400000).toISOString() };
  db.setSettings({ paused: false, liveMode: true });

  const originalCreatePin = pinterest.createPin;
  let calls = 0;
  pinterest.createPin = async () => { calls += 1; throw new Error('must not be called'); };
  try {
    const run = await engine.runDue(db, new Date('2026-08-30T06:00:00Z'));
    assert.deepEqual(run, []);
    await engine.postPin(db, db.pin(pin.id));
    assert.equal(calls, 0);
    assert.equal(db.pin(pin.id).status, 'queued');
    assert.equal(db.pin(pin.id).attempts, 0);
  } finally {
    pinterest.createPin = originalCreatePin;
  }
});

test('an individually approved draft becomes scheduler-eligible in simulation only', async () => {
  const db = freshDb();
  const product = addProduct(db, 'kd', 'Approved Practice Draft');
  const pin = db.addPin({
    brandId: 'kd',
    productId: product.id,
    imageId: product.images[0].id,
    title: 'Approved practice',
    description: 'Simulation only.',
    link: product.url,
    scheduledFor: new Date('2026-08-30T05:00:00Z').toISOString(),
  });
  db.updatePin(pin.id, { approvedForPublishing: true, approvedAt: new Date().toISOString() });
  db.setSettings({ paused: false, liveMode: false });

  const originalCreatePin = pinterest.createPin;
  let productionCalls = 0;
  pinterest.createPin = async () => { productionCalls += 1; throw new Error('must not be called'); };
  try {
    const run = await engine.runDue(db, new Date('2026-08-30T06:00:00Z'));
    assert.equal(run.length, 1);
    assert.equal(db.pin(pin.id).status, 'simulated');
    assert.equal(productionCalls, 0);
  } finally {
    pinterest.createPin = originalCreatePin;
  }
});

test('a working production connection with legacy extra scopes is reduced on refresh', async () => {
  const db = freshDb();
  const brand = db.brand('kd');
  brand.pinterest = {
    accessToken: 'old-access',
    refreshToken: 'refresh',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    scopes: 'boards:read boards:write pins:read pins:write user_accounts:read',
    username: 'kdpub',
  };

  const originalRefresh = pinterest.refreshConnection;
  let calls = 0;
  pinterest.refreshConnection = async (connection, environment) => {
    calls += 1;
    assert.equal(connection.accessToken, 'old-access');
    assert.equal(environment, undefined);
    return {
      accessToken: 'reduced-access',
      refreshToken: 'refresh-2',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      scopes: pinterest.PRODUCTION_SCOPES.join(','),
      username: 'kdpub',
    };
  };
  try {
    const connection = await engine.liveConnection(db, brand);
    assert.equal(calls, 1);
    assert.equal(connection.accessToken, 'reduced-access');
    assert.equal(connection.scopes, 'boards:read,pins:write,user_accounts:read');
  } finally {
    pinterest.refreshConnection = originalRefresh;
  }
});

test('migration marks legacy drafts unapproved and drops unnecessary Pinterest response data', () => {
  const file = path.join(tmp, 'legacy.json');
  const legacy = freshDb().data;
  legacy.version = 1;
  legacy.pins = [{
    id: 'pin_legacy', brandId: 'kd', productId: 'prod_legacy', status: 'queued',
    title: 'Legacy', description: 'Legacy draft', link: 'https://example.com',
    scheduledFor: new Date().toISOString(), approvedForPublishing: true, approvedAt: new Date().toISOString(),
  }];
  legacy.products = [{
    id: 'prod_legacy', brandId: 'kd', title: 'Legacy product', url: 'https://example.com',
    boardId: 'needed-board', images: [], active: true,
  }];
  legacy.brands[0].pinterest = {
    accessToken: 'keep-token', username: 'kdpub', accountId: 'drop-id', accountType: 'BUSINESS',
  };
  legacy.brands[0].pinterestSandboxBoards = [{ id: 'cached', name: 'Cached' }];
  legacy.boards.kd = [{ id: 'needed-board', name: 'Word Search Books', privacy: 'PUBLIC' }];
  fs.writeFileSync(file, JSON.stringify(legacy));

  const db = new Db(file);
  assert.equal(db.data.version, 2);
  assert.equal(db.pin('pin_legacy').approvedForPublishing, false);
  assert.equal(db.pin('pin_legacy').approvedAt, null);
  assert.equal(db.brand('kd').pinterest.accessToken, 'keep-token');
  assert.equal(db.brand('kd').pinterest.accountId, undefined);
  assert.equal(db.brand('kd').pinterest.accountType, undefined);
  assert.equal(db.brand('kd').pinterestSandboxBoards, undefined);
  assert.deepEqual(db.boards('kd'), [], 'the connected account board inventory is fetched live, not persisted');
  assert.equal(db.product('prod_legacy').boardId, 'needed-board', 'the selected board ID remains operational');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pins[0].approvedForPublishing, false);
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
