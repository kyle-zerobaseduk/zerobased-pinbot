'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pinbot-http-'));
process.env.DATA_DIR = tmp;
process.env.DASHBOARD_PASSWORD = 'test-password-123';
process.env.TZ = 'Europe/London';
delete process.env.ANTHROPIC_API_KEY;

const { app, db } = require('../server');

let base;
let cookie = '';
let server;

test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

async function call(pathname, options = {}) {
  const response = await fetch(base + pathname, {
    method: options.method || 'GET',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    redirect: 'manual',
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* html response */ }
  return { status: response.status, json, text };
}

test('the dashboard is locked until you sign in', async () => {
  const locked = await call('/api/state');
  assert.equal(locked.status, 401);
});

test('a wrong password is rejected', async () => {
  const wrong = await call('/api/login', { method: 'POST', body: { password: 'nope' } });
  assert.equal(wrong.status, 401);
});

test('the right password signs you in and unlocks the dashboard', async () => {
  const login = await call('/api/login', { method: 'POST', body: { password: 'test-password-123' } });
  assert.equal(login.status, 200);

  const state = await call('/api/state');
  assert.equal(state.status, 200);
  assert.equal(state.json.brands.length, 2);
  assert.equal(state.json.settings.paused, true);
});

test('brand data sent to the browser never contains an access token', async () => {
  db.brand('kd').pinterest = { accessToken: 'secret-token-value', refreshToken: 'r', username: 'kdpub' };
  db.save();

  const state = await call('/api/state');
  assert.ok(!JSON.stringify(state.json).includes('secret-token-value'));
  assert.equal(state.json.brands.find((b) => b.id === 'kd').pinterest.connected, true);
  assert.equal(state.json.brands.find((b) => b.id === 'kd').pinterest.username, 'kdpub');

  db.brand('kd').pinterest = null;
  db.save();
});

test('a product needs a real link', async () => {
  const bad = await call('/api/products', {
    method: 'POST',
    body: { brandId: 'kd', title: 'Bad link', url: 'not-a-url' },
  });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /link/i);
});

test('adding a product, an image and a board, then queueing a pin', async () => {
  const board = await call('/api/boards/kd/manual', { method: 'POST', body: { name: 'Guided Journals' } });
  assert.equal(board.status, 200);
  const boardId = board.json[0].id;

  const product = await call('/api/products', {
    method: 'POST',
    body: {
      brandId: 'kd',
      title: '80-Day Gratitude Journal',
      url: 'https://www.amazon.co.uk/dp/EXAMPLE',
      kind: 'Paperback journal',
      keywords: 'gratitude journal, daily journal',
      boardId,
    },
  });
  assert.equal(product.status, 200);

  // A 1x1 PNG, the smallest valid upload.
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const image = await call(`/api/products/${product.json.id}/images`, { method: 'POST', body: { dataUrl: png } });
  assert.equal(image.status, 200);
  assert.ok(fs.existsSync(path.join(tmp, 'uploads', image.json.file)));

  const planned = await call('/api/plan', { method: 'POST', body: {} });
  assert.equal(planned.status, 200);
  assert.ok(planned.json.created > 0, 'planner should queue pins');

  const state = await call('/api/state');
  const queued = state.json.pins.filter((p) => p.status === 'queued');
  assert.ok(queued.length > 0);
  assert.equal(queued[0].boardId, boardId);
  assert.ok(queued[0].description.length > 20, 'pin should have generated copy');
});

test('a non-image upload is refused', async () => {
  const product = db.products('kd')[0];
  const bad = await call(`/api/products/${product.id}/images`, {
    method: 'POST',
    body: { dataUrl: 'data:application/pdf;base64,SGVsbG8=' },
  });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /JPG|image/i);
});

test('"pin now" produces a practice pin while live mode is off', async () => {
  const product = db.products('kd')[0];
  const pinned = await call(`/api/products/${product.id}/pin-now`, { method: 'POST', body: {} });
  assert.equal(pinned.status, 200);
  assert.equal(pinned.json.status, 'simulated');
});

test('live mode cannot be switched on before Pinterest is connected', async () => {
  const attempt = await call('/api/settings', { method: 'POST', body: { liveMode: true } });
  assert.equal(attempt.status, 400);
  assert.match(attempt.json.error, /Connect a Pinterest account/i);
});

test('posting times are validated', async () => {
  const bad = await call('/api/brands/kd', { method: 'POST', body: { slots: ['25:00', 'nine'] } });
  assert.equal(bad.status, 400);

  const good = await call('/api/brands/kd', { method: 'POST', body: { slots: ['07:30', '19:45'] } });
  assert.equal(good.status, 200);
  assert.deepEqual(good.json.slots, ['07:30', '19:45']);
});

test('the K.D. Publishing page is served publicly', async () => {
  const page = await call('/kd');
  assert.equal(page.status, 200);
  assert.match(page.text, /K\.D\. Publishing/);
});

test('the health check works without signing in', async () => {
  const saved = cookie;
  cookie = '';
  const health = await call('/healthz');
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  cookie = saved;
});

test('signing out locks the dashboard again', async () => {
  await call('/api/logout', { method: 'POST' });
  const after = await call('/api/state');
  assert.equal(after.status, 401);
});

test('both brands start with usable board suggestions', async () => {
  await call('/api/login', { method: 'POST', body: { password: 'test-password-123' } });
  const state = await call('/api/state');
  assert.ok(state.json.boards.kd.length >= 3, 'K.D. Publishing should have starter boards');
  assert.ok(state.json.boards.zb.length >= 3, 'ZeroBased UK should have starter boards');
});

test('a pasted list imports in one go', async () => {
  const before = db.products('zb').length;
  const result = await call('/api/products/bulk', {
    method: 'POST',
    body: {
      brandId: 'zb',
      text: [
        'Monthly Budget Planner | https://www.etsy.com/uk/listing/111/monthly-budget-planner',
        'https://www.etsy.com/uk/listing/222/weekly-meal-planner-printable',
        'https://www.etsy.com/uk/listing/333',
        'this line has no link',
      ].join('\n'),
    },
  });

  assert.equal(result.status, 200);
  assert.equal(result.json.created, 3);
  assert.equal(result.json.needsName, 1, 'the id-only link should import paused');
  assert.equal(result.json.skipped.length, 1);
  assert.equal(db.products('zb').length, before + 3);

  const unnamed = db.products('zb').find((p) => /needs a name/.test(p.title));
  assert.equal(unnamed.active, false, 'a placeholder name must not be pinnable');
});

test('re-importing the same list does not create duplicates', async () => {
  const before = db.products('zb').length;
  const result = await call('/api/products/bulk', {
    method: 'POST',
    body: { brandId: 'zb', text: 'Monthly Budget Planner | https://www.etsy.com/uk/listing/111/monthly-budget-planner' },
  });

  assert.equal(result.json.created, 0);
  assert.equal(result.json.alreadyThere.length, 1);
  assert.equal(db.products('zb').length, before);
});

test('an imported placeholder product is never queued for posting', async () => {
  const engine = require('../src/engine');
  const unnamed = db.products('zb').find((p) => /needs a name/.test(p.title));
  db.addImage(unnamed.id, { url: 'https://example.com/x.jpg' });

  const created = await engine.planBrand(db, db.brand('zb'), new Date('2026-08-30T05:00:00Z'));
  assert.ok(!created.some((pin) => pin.productId === unnamed.id), 'paused product must not be pinned');
});
