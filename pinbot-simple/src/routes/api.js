'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const config = require('../config');
const auth = require('../auth');
const copy = require('../copy');
const engine = require('../engine');
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
