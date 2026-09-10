'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const config = require('../config');
const auth = require('../auth');
const copy = require('../copy');
const engine = require('../engine');
const importer = require('../import');
const pinterest = require('../pinterest');
const time = require('../time');

const IMAGE_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

// Never let access tokens reach the browser.
function publicBrand(brand) {
  const connection = brand.pinterest;
  const sandboxConnection = brand.pinterestSandbox;
  return {
    id: brand.id,
    name: brand.name,
    marketplace: brand.marketplace,
    tagline: brand.tagline,
    accent: brand.accent,
    paused: brand.paused,
    slots: brand.slots,
    pinterest: connection
      ? {
          connected: true,
          username: connection.username || '',
          connectedAt: connection.connectedAt || null,
          expiresAt: connection.expiresAt || null,
        }
      : { connected: false },
    pinterestSandbox: sandboxConnection
      ? {
          connected: true,
          username: sandboxConnection.username || '',
          connectedAt: sandboxConnection.connectedAt || null,
          expiresAt: sandboxConnection.expiresAt || null,
        }
      : { connected: false },
  };
}

function isSafeProductUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch (_) {
    return false;
  }
}

function cleanKeywords(value) {
  if (Array.isArray(value)) return value.map((k) => String(k).trim()).filter(Boolean).slice(0, 12);
  return String(value || '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function saveDataUrl(dataUrl) {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(String(dataUrl || ''));
  if (!match) throw new Error('That file did not look like an image.');

  const [, mime, base64] = match;
  const ext = IMAGE_TYPES[mime.toLowerCase()];
  if (!ext) throw new Error('Please use a JPG, PNG, WEBP or GIF image.');

  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('That image is larger than 10MB.');

  const filename = `${crypto.randomBytes(10).toString('hex')}${ext}`;
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  fs.writeFileSync(path.join(config.uploadsDir, filename), buffer);
  return filename;
}

function buildRouter(db) {
  const router = express.Router();
  const guard = auth.requireAuth(db);

  // ---- session ------------------------------------------------------------
  router.post('/login', (req, res) => {
    if (!config.dashboardPassword) {
      return res.status(500).json({ error: 'No dashboard password is set on the server yet.' });
    }
    if (auth.isLockedOut(req)) {
      return res.status(429).json({ error: 'Too many wrong passwords. Try again in 15 minutes.' });
    }
    if (!auth.passwordMatches(req.body.password)) {
      auth.noteFailure(req);
      return res.status(401).json({ error: 'That password is not right.' });
    }
    auth.clearFailures(req);
    auth.setSessionCookie(res, auth.makeToken(db), req.secure || req.headers['x-forwarded-proto'] === 'https');
    return res.json({ ok: true });
  });

  router.post('/logout', (req, res) => {
    auth.clearSessionCookie(res);
    res.json({ ok: true });
  });

  router.get('/session', (req, res) => {
    res.json({ authed: auth.isAuthed(db, req), passwordSet: Boolean(config.dashboardPassword) });
  });

  // ---- everything the dashboard renders from -------------------------------
  router.get('/state', guard, (req, res) => {
    const tz = db.data.settings.timezone;
    res.json({
      settings: db.data.settings,
      brands: db.brands().map(publicBrand),
      products: db.products(),
      pins: db.data.pins.slice().sort((a, b) => Date.parse(b.scheduledFor) - Date.parse(a.scheduledFor)).slice(0, 200),
      boards: db.data.boards,
      logs: db.data.logs.slice(-60).reverse(),
      now: new Date().toISOString(),
      today: time.localDate(new Date(), tz),
      health: {
        pinterestConfigured: config.pinterestConfigured,
        aiConfigured: config.aiConfigured,
        appUrlSet: Boolean(config.appUrl),
        redirectUri: config.redirectUri,
      },
    });
  });

  // ---- settings and brands -------------------------------------------------
  router.post('/settings', guard, (req, res) => {
    const patch = {};
    if (req.body.paused !== undefined) patch.paused = Boolean(req.body.paused);
    if (req.body.liveMode !== undefined) patch.liveMode = Boolean(req.body.liveMode);
    if (req.body.maxPerDay !== undefined) {
      patch.maxPerDay = Math.min(25, Math.max(1, Number(req.body.maxPerDay) || 3));
    }
    if (req.body.planAheadDays !== undefined) {
      patch.planAheadDays = Math.min(14, Math.max(1, Number(req.body.planAheadDays) || 3));
    }
    if (req.body.timezone) patch.timezone = String(req.body.timezone);

    if (patch.liveMode) {
      const anyConnected = db.brands().some((b) => b.pinterest && b.pinterest.accessToken);
      if (!anyConnected) {
        return res.status(400).json({ error: 'Connect a Pinterest account before turning live posting on.' });
      }
    }

    db.log('info', `Settings updated: ${JSON.stringify(patch)}`);
    res.json(db.setSettings(patch));
  });

  router.post('/brands/:id', guard, (req, res) => {
    const brand = db.brand(req.params.id);
    if (!brand) return res.status(404).json({ error: 'Unknown brand.' });

    if (req.body.paused !== undefined) brand.paused = Boolean(req.body.paused);
    if (Array.isArray(req.body.slots)) {
      const slots = req.body.slots.map(String).filter(time.isValidSlot);
      if (slots.length === 0) return res.status(400).json({ error: 'Add at least one valid posting time (HH:MM).' });
      brand.slots = [...new Set(slots)].sort();
    }
    db.save();
    db.log('info', `${brand.name} updated.`);
    res.json(publicBrand(brand));
  });

  // ---- products ------------------------------------------------------------
  router.post('/products', guard, (req, res) => {
    const { brandId, title, url } = req.body;
    if (!db.brand(brandId)) return res.status(400).json({ error: 'Choose a brand first.' });
    if (!title || !String(title).trim()) return res.status(400).json({ error: 'Give the product a name.' });
    if (!isSafeProductUrl(url)) return res.status(400).json({ error: 'Paste the full Amazon or Etsy link (starting https://).' });

    const product = db.addProduct({
      brandId,
      title: String(title).trim().slice(0, 200),
      url: String(url).trim(),
      kind: String(req.body.kind || '').slice(0, 80),
      keywords: cleanKeywords(req.body.keywords),
      notes: String(req.body.notes || '').slice(0, 500),
      boardId: String(req.body.boardId || ''),
    });
    db.log('info', `Product added: ${product.title}`);
    res.json(product);
  });

  // Add a whole catalogue from one pasted list.
  router.post('/products/bulk', guard, (req, res) => {
    if (!db.brand(req.body.brandId)) return res.status(400).json({ error: 'Choose a brand first.' });

    const { items, skipped } = importer.parseList(req.body.text);
    if (items.length === 0 && skipped.length === 0) {
      return res.status(400).json({ error: 'Paste one product per line first.' });
    }

    const existing = new Set(db.products(req.body.brandId).map((p) => p.url));
    const created = [];
    const alreadyThere = [];

    for (const item of items) {
      if (existing.has(item.url)) {
        alreadyThere.push(item.title);
        continue;
      }
      existing.add(item.url);
      created.push(db.addProduct({
        brandId: req.body.brandId,
        title: item.title,
        url: item.url,
        boardId: String(req.body.boardId || ''),
        // A guessed placeholder name must never reach Pinterest unreviewed.
        active: !item.needsName,
      }));
    }

    const needsName = created.filter((p) => !p.active).length;
    db.log('info', `Imported ${created.length} product(s)${needsName ? `, ${needsName} paused pending a proper name` : ''}.`);

    res.json({
      created: created.length,
      needsName,
      alreadyThere,
      skipped,
    });
  });

  router.patch('/products/:id', guard, (req, res) => {
    const patch = { ...req.body };
    if (patch.url !== undefined && !isSafeProductUrl(patch.url)) {
      return res.status(400).json({ error: 'That does not look like a valid link.' });
    }
    if (patch.keywords !== undefined) patch.keywords = cleanKeywords(patch.keywords);
    const product = db.updateProduct(req.params.id, patch);
    if (!product) return res.status(404).json({ error: 'Product not found.' });
    res.json(product);
  });

  router.delete('/products/:id', guard, (req, res) => {
    const product = db.product(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found.' });
    db.deleteProduct(req.params.id);
    db.log('info', `Product removed: ${product.title}`);
    res.json({ ok: true });
  });

  // ---- images --------------------------------------------------------------
  router.post('/products/:id/images', guard, (req, res) => {
    const product = db.product(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found.' });

    try {
      if (req.body.dataUrl) {
        const filename = saveDataUrl(req.body.dataUrl);
        return res.json(db.addImage(product.id, { file: filename }));
      }
      if (req.body.url) {
        if (!isSafeProductUrl(req.body.url)) return res.status(400).json({ error: 'That image link is not valid.' });
        return res.json(db.addImage(product.id, { url: String(req.body.url).trim() }));
      }
      return res.status(400).json({ error: 'Choose a file or paste an image link.' });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  router.delete('/products/:productId/images/:imageId', guard, (req, res) => {
    const product = db.product(req.params.productId);
    if (!product) return res.status(404).json({ error: 'Product not found.' });

    const image = product.images.find((i) => i.id === req.params.imageId);
    const removed = db.deleteImage(req.params.productId, req.params.imageId);
    // Tidy up the file on disk, but only after the record is gone.
    if (removed && image && image.file) {
      try {
        fs.unlinkSync(path.join(config.uploadsDir, path.basename(image.file)));
      } catch (_) {
        /* the record is what matters */
      }
    }
    res.json({ ok: removed });
  });

  // ---- copy generation -----------------------------------------------------
  router.post('/products/:id/generate', guard, async (req, res) => {
    const product = db.product(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found.' });

    const brand = db.brand(product.brandId);
    const variant = Number(req.body.variant) || 0;
    const text = await copy.generateCopy(product, brand, variant, (level, msg) => db.log(level, msg));
    res.json(text);
  });

  // ---- pins ----------------------------------------------------------------
  router.post('/plan', guard, async (req, res) => {
    const created = await engine.planAll(db);
    res.json({ created: created.length });
  });

  router.post('/products/:id/pin-now', guard, async (req, res) => {
    const product = db.product(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found.' });
    if (!product.images.length) return res.status(400).json({ error: 'Add an image to this product first.' });

    const brand = db.brand(product.brandId);
    const image = engine.pickImage(product);
    const text = await copy.generateCopy(product, brand, product.pinCount, (level, msg) => db.log(level, msg));

    const pin = db.addPin({
      brandId: brand.id,
      productId: product.id,
      imageId: image.id,
      boardId: product.boardId || '',
      title: req.body.title || text.title,
      description: req.body.description || text.description,
      link: product.url,
      scheduledFor: new Date().toISOString(),
    });

    res.json(await engine.postPin(db, pin));
  });

  router.patch('/pins/:id', guard, (req, res) => {
    const pin = db.pin(req.params.id);
    if (!pin) return res.status(404).json({ error: 'Pin not found.' });
    if (pin.status === 'posted') return res.status(400).json({ error: 'That pin is already live on Pinterest.' });

    const patch = {};
    for (const key of ['title', 'description', 'boardId', 'imageId']) {
      if (req.body[key] !== undefined) patch[key] = String(req.body[key]);
    }
    if (req.body.scheduledFor) {
      const when = new Date(req.body.scheduledFor);
      if (Number.isNaN(when.getTime())) return res.status(400).json({ error: 'That date is not valid.' });
      patch.scheduledFor = when.toISOString();
    }
    res.json(db.updatePin(pin.id, patch));
  });

  router.post('/pins/:id/retry', guard, async (req, res) => {
    const pin = db.pin(req.params.id);
    if (!pin) return res.status(404).json({ error: 'Pin not found.' });
    db.updatePin(pin.id, { status: 'queued', attempts: 0, error: null, scheduledFor: new Date().toISOString() });
    res.json(await engine.postPin(db, db.pin(pin.id)));
  });

  // A Trial-access production 403 turns an existing Practice record back into a queued retry.
  // Cancel only that exact retry while retaining the record and its error as audit history.
  router.post('/pins/:id/cancel-trial-retry', guard, (req, res) => {
    const pin = db.pin(req.params.id);
    if (!pin) return res.status(404).json({ error: 'Pin not found.' });
    const isTrialRetry = pin.status === 'queued' && pin.attempts === 1 &&
      String(pin.error || '').includes('Apps with Trial access may not create Pins in production') &&
      String(pin.pinterestPinId || '').startsWith('sim-') && Boolean(pin.postedAt);
    if (!isTrialRetry) {
      return res.status(409).json({ error: 'This is not the uniquely identifiable Trial-access retry.' });
    }
    const cancelledAt = new Date().toISOString();
    db.updatePin(pin.id, { status: 'simulated', retryCancelledAt: cancelledAt });
    db.log('info', `Cancelled the failed Trial production retry for "${pin.title}"; Practice history was kept.`);
    res.json(db.pin(pin.id));
  });

  async function sandboxConnection(brand) {
    if (!brand.pinterestSandbox?.accessToken) return null;
    if (!pinterest.isExpired(brand.pinterestSandbox)) return brand.pinterestSandbox;
    const refreshed = await pinterest.refreshConnection(brand.pinterestSandbox, 'sandbox');
    brand.pinterestSandbox = { ...brand.pinterestSandbox, ...refreshed };
    db.save();
    return brand.pinterestSandbox;
  }

  router.get('/sandbox/brands/:brandId/status', guard, async (req, res) => {
    const brand = db.brand(req.params.brandId);
    if (!brand) return res.status(404).json({ error: 'Unknown brand.' });
    const connection = await sandboxConnection(brand);
    if (!connection) return res.status(400).json({ error: 'Connect this brand to Pinterest Sandbox first.' });
    try {
      const account = await pinterest.getAccount(connection, 'sandbox');
      const boards = await pinterest.getBoards(connection, 'sandbox');
      brand.pinterestSandbox = { ...connection, ...account };
      brand.pinterestSandboxBoards = boards;
      db.save();
      res.json({ connected: true, account, boards });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // This endpoint never reads the queue and never uses the production API host or token.
  router.post('/pins/:id/sandbox-test', guard, async (req, res) => {
    if (!db.data.settings.paused || db.data.settings.liveMode) {
      return res.status(409).json({ error: 'Sandbox tests require global Posting PAUSED and PRACTICE mode ON.' });
    }

    const pin = db.pin(req.params.id);
    if (!pin) return res.status(404).json({ error: 'Pin not found.' });
    if (pin.status === 'posted') return res.status(409).json({ error: 'A production-posted record cannot be used for a Sandbox test.' });
    if (pin.sandboxTest?.id) {
      return res.status(409).json({ error: `This record already created Sandbox Pin ${pin.sandboxTest.id}.` });
    }

    const product = db.product(pin.productId);
    const image = product?.images.find((item) => item.id === pin.imageId);
    const brand = db.brand(pin.brandId);
    if (!brand || !product || !image?.file) {
      return res.status(409).json({ error: 'The controlled record needs its existing local product image.' });
    }

    const expected = req.body.expected || {};
    const required = ['accountUsername', 'productTitle', 'productionBoardId', 'title', 'description', 'link', 'imageSha256', 'sandboxBoardName'];
    const missing = required.filter((key) => typeof expected[key] !== 'string' || !expected[key]);
    if (missing.length) return res.status(400).json({ error: `Missing expected fields: ${missing.join(', ')}` });

    const filePath = path.join(config.uploadsDir, path.basename(image.file));
    if (!fs.existsSync(filePath)) return res.status(409).json({ error: 'The controlled image file is missing.' });
    const imageSha256 = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    const differences = [];
    const match = (field, actual, wanted) => {
      if (actual !== wanted) differences.push({ field, actual, expected: wanted });
    };
    match('Pinterest account', brand.pinterest?.username || '', expected.accountUsername);
    match('Product', product.title, expected.productTitle);
    match('Production board ID', pin.boardId, expected.productionBoardId);
    match('Title', pin.title, expected.title);
    match('Description', pin.description, expected.description);
    match('Destination', pin.link, expected.link);
    match('Image SHA-256', imageSha256, expected.imageSha256.toLowerCase());
    if (differences.length) return res.status(409).json({ error: 'Controlled record does not match.', differences });

    const connection = await sandboxConnection(brand);
    if (!connection) return res.status(400).json({ error: 'Connect this brand to Pinterest Sandbox first.' });

    try {
      const account = await pinterest.getAccount(connection, 'sandbox');
      if (account.username.toLowerCase() !== expected.accountUsername.toLowerCase()) {
        return res.status(409).json({ error: `Sandbox is connected as @${account.username}, not @${expected.accountUsername}.` });
      }

      let boards = await pinterest.getBoards(connection, 'sandbox');
      let sandboxBoard = boards.find((item) => item.name === expected.sandboxBoardName);
      let boardCreated = false;
      if (!sandboxBoard) {
        sandboxBoard = await pinterest.createBoard(connection, expected.sandboxBoardName, 'sandbox');
        boards = [...boards, sandboxBoard];
        boardCreated = true;
      }
      brand.pinterestSandboxBoards = boards;
      db.save();

      const result = await pinterest.createPin(connection, { ...pin, boardId: sandboxBoard.id }, image, 'sandbox');
      db.updatePin(pin.id, {
        sandboxTest: {
          id: result.id,
          url: result.url,
          boardId: sandboxBoard.id,
          boardName: sandboxBoard.name,
          createdAt: new Date().toISOString(),
        },
      });
      const verified = await pinterest.getPin(connection, result.id, 'sandbox');
      db.log('info', `Created one Pinterest Sandbox Pin for "${pin.title}" (${brand.name}); production was untouched.`);
      res.json({
        environment: 'sandbox',
        boardCreated,
        account,
        board: sandboxBoard,
        imageSha256,
        result,
        verified,
      });
    } catch (err) {
      db.log('error', `Pinterest Sandbox test failed: ${err.message}`);
      res.status(502).json({ error: err.message });
    }
  });

  router.delete('/pins/:id', guard, (req, res) => {
    const pin = db.pin(req.params.id);
    if (!pin) return res.status(404).json({ error: 'Pin not found.' });
    db.deletePin(pin.id);
    res.json({ ok: true });
  });

  // ---- boards --------------------------------------------------------------
  router.post('/boards/:brandId/refresh', guard, async (req, res) => {
    const brand = db.brand(req.params.brandId);
    if (!brand) return res.status(404).json({ error: 'Unknown brand.' });
    if (!brand.pinterest || !brand.pinterest.accessToken) {
      return res.status(400).json({ error: 'Connect this Pinterest account first.' });
    }
    try {
      const connection = await engine.liveConnection(db, brand);
      const boards = await pinterest.getBoards(connection);
      db.setBoards(brand.id, boards);
      db.log('info', `Loaded ${boards.length} Pinterest board(s) for ${brand.name}.`);
      res.json(boards);
    } catch (err) {
      db.log('error', `Could not load boards for ${brand.name}: ${err.message}`);
      res.status(502).json({ error: err.message });
    }
  });

  // Lets boards be set up (and pins tested) before Pinterest access is granted.
  router.post('/boards/:brandId/manual', guard, (req, res) => {
    const brand = db.brand(req.params.brandId);
    if (!brand) return res.status(404).json({ error: 'Unknown brand.' });

    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Give the board a name.' });

    const boards = db.boards(brand.id).slice();
    boards.push({ id: String(req.body.id || `manual-${crypto.randomBytes(4).toString('hex')}`), name, manual: true });
    db.setBoards(brand.id, boards);
    res.json(boards);
  });

  router.delete('/boards/:brandId/:boardId', guard, (req, res) => {
    const brand = db.brand(req.params.brandId);
    if (!brand) return res.status(404).json({ error: 'Unknown brand.' });
    db.setBoards(brand.id, db.boards(brand.id).filter((b) => b.id !== req.params.boardId));
    res.json({ ok: true });
  });

  return router;
}

module.exports = { buildRouter, publicBrand, saveDataUrl, isSafeProductUrl, cleanKeywords };
