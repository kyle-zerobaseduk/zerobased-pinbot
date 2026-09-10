'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pinbot-sandbox-'));
process.env.DATA_DIR = tmp;
process.env.DASHBOARD_PASSWORD = 'test-password-123';
process.env.APP_URL = 'https://example.test';
process.env.PINTEREST_APP_ID = '123';
process.env.PINTEREST_APP_SECRET = 'secret';

const pinterest = require('../src/pinterest');
const { app, db } = require('../server');

let base;
let cookie = '';
let server;

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
  try { json = JSON.parse(text); } catch (_) { /* HTML or empty response */ }
  return { status: response.status, json, text, headers: response.headers };
}

test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  await call('/api/login', { method: 'POST', body: { password: 'test-password-123' } });
});

test.after(() => server.close());

test('Sandbox OAuth and one-record test stay separate from production and the queue', async () => {
  assert.equal(pinterest.apiBase('production'), 'https://api.pinterest.com/v5');
  assert.equal(pinterest.apiBase('sandbox'), 'https://api-sandbox.pinterest.com/v5');

  const brand = db.brand('kd');
  brand.pinterest = { username: 'kdpublishingkyle', accessToken: 'production-token' };
  brand.pinterestSandbox = {
    username: 'kdpublishingkyle',
    accessToken: 'sandbox-token',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  };
  db.data.boards.kd = [{ id: 'production-board', name: 'Word Search Books', privacy: 'PUBLIC' }];
  db.save();

  const product = db.addProduct({
    brandId: 'kd',
    title: 'Cozy Christmas Word Search',
    url: 'https://www.amazon.co.uk/dp/EXAMPLE',
    boardId: 'production-board',
  });
  const filename = 'controlled.png';
  const bytes = Buffer.from('controlled image bytes');
  fs.writeFileSync(path.join(tmp, 'uploads', filename), bytes);
  const image = db.addImage(product.id, { file: filename });
  const pin = db.addPin({
    brandId: 'kd',
    productId: product.id,
    imageId: image.id,
    boardId: 'production-board',
    title: 'Cozy Christmas Word Search',
    description: 'Approved description.',
    link: product.url,
    status: 'simulated',
    scheduledFor: new Date().toISOString(),
  });
  const unrelated = db.addPin({
    brandId: 'kd',
    productId: product.id,
    imageId: image.id,
    boardId: 'production-board',
    title: 'Unrelated queue item',
    description: 'Leave me alone.',
    link: product.url,
    scheduledFor: new Date().toISOString(),
  });

  const oauth = await call('/oauth/pinterest/sandbox/start/kd');
  assert.equal(oauth.status, 302);
  assert.match(oauth.headers.get('location'), /^https:\/\/www\.pinterest\.com\/oauth\//);
  const oauthState = db.data.oauthStates.at(-1);
  assert.equal(oauthState.environment, 'sandbox');
  assert.equal(oauthState.expectedUsername, 'kdpublishingkyle');

  const originals = {
    getAccount: pinterest.getAccount,
    getBoards: pinterest.getBoards,
    createBoard: pinterest.createBoard,
    createPin: pinterest.createPin,
    getPin: pinterest.getPin,
  };
  let createCalls = 0;
  try {
    pinterest.getAccount = async (_connection, environment) => {
      assert.equal(environment, 'sandbox');
      return { username: 'kdpublishingkyle', accountId: 'sandbox-account' };
    };
    pinterest.getBoards = async (_connection, environment) => {
      assert.equal(environment, 'sandbox');
      return [];
    };
    pinterest.createBoard = async (_connection, name, environment) => {
      assert.equal(environment, 'sandbox');
      assert.equal(name, 'Word Search Books [Sandbox]');
      return { id: 'sandbox-board', name, privacy: 'PUBLIC' };
    };
    pinterest.createPin = async (_connection, sentPin, sentImage, environment) => {
      createCalls += 1;
      assert.equal(environment, 'sandbox');
      assert.equal(sentPin.id, pin.id);
      assert.equal(sentPin.boardId, 'sandbox-board');
      assert.equal(sentImage.id, image.id);
      return { id: 'sandbox-pin', url: 'https://www.pinterest.com/pin/sandbox-pin/' };
    };
    pinterest.getPin = async (_connection, id, environment) => {
      assert.equal(environment, 'sandbox');
      assert.equal(id, 'sandbox-pin');
      return {
        id,
        board_id: 'sandbox-board',
        title: pin.title,
        description: pin.description,
        link: pin.link,
      };
    };

    const expected = {
      accountUsername: 'kdpublishingkyle',
      productTitle: product.title,
      productionBoardId: pin.boardId,
      title: pin.title,
      description: pin.description,
      link: pin.link,
      imageSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      sandboxBoardName: 'Word Search Books [Sandbox]',
    };
    const result = await call(`/api/pins/${pin.id}/sandbox-test`, {
      method: 'POST',
      body: { expected },
    });

    assert.equal(result.status, 200);
    assert.equal(result.json.environment, 'sandbox');
    assert.equal(result.json.boardCreated, true);
    assert.equal(result.json.result.id, 'sandbox-pin');
    assert.equal(createCalls, 1);
    assert.equal(db.data.settings.paused, true);
    assert.equal(db.data.settings.liveMode, false);
    assert.equal(db.pin(pin.id).status, 'simulated');
    assert.equal(db.pin(pin.id).sandboxTest.id, 'sandbox-pin');
    assert.equal(db.pin(unrelated.id).status, 'queued');
  } finally {
    Object.assign(pinterest, originals);
  }

  const failed = db.addPin({
    brandId: 'kd',
    productId: product.id,
    imageId: image.id,
    boardId: 'production-board',
    title: pin.title,
    description: pin.description,
    link: pin.link,
    status: 'queued',
    scheduledFor: new Date().toISOString(),
  });
  db.updatePin(failed.id, {
    attempts: 1,
    postedAt: new Date().toISOString(),
    pinterestPinId: 'sim-existing-practice',
    error: 'Pinterest API 403: Apps with Trial access may not create Pins in production',
  });
  const queuedBefore = db.pins({ status: 'queued' }).length;
  const cancelled = await call(`/api/pins/${failed.id}/cancel-trial-retry`, { method: 'POST', body: {} });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.status, 'simulated');
  assert.equal(cancelled.json.attempts, 1, 'failure audit is retained');
  assert.match(cancelled.json.error, /Trial access/);
  assert.equal(db.pins({ status: 'queued' }).length, queuedBefore - 1);
  assert.equal(db.pin(unrelated.id).status, 'queued');
});
