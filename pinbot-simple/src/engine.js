'use strict';

const config = require('./config');
const time = require('./time');
const copy = require('./copy');
const pinterest = require('./pinterest');

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

// Fair rotation: whatever has been used least, and longest ago, goes next.
// Counting already-queued pins stops the planner filling a whole day with one product.
function pickProduct(products, pins) {
  const queuedByProduct = new Map();
  for (const pin of pins) {
    if (pin.status !== 'queued') continue;
    queuedByProduct.set(pin.productId, (queuedByProduct.get(pin.productId) || 0) + 1);
  }

  const eligible = products.filter((p) => p.active && p.url && p.images.length > 0);
  if (eligible.length === 0) return null;

  return eligible.slice().sort((a, b) => {
    const queuedDiff = (queuedByProduct.get(a.id) || 0) - (queuedByProduct.get(b.id) || 0);
    if (queuedDiff !== 0) return queuedDiff;
    if (a.pinCount !== b.pinCount) return a.pinCount - b.pinCount;
    const aLast = a.lastPinnedAt ? Date.parse(a.lastPinnedAt) : 0;
    const bLast = b.lastPinnedAt ? Date.parse(b.lastPinnedAt) : 0;
    if (aLast !== bLast) return aLast - bLast;
    return Date.parse(a.createdAt) - Date.parse(b.createdAt);
  })[0];
}

function pickImage(product) {
  if (!product.images.length) return null;
  return product.images.slice().sort((a, b) => {
    if (a.uses !== b.uses) return a.uses - b.uses;
    return Date.parse(a.addedAt) - Date.parse(b.addedAt);
  })[0];
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

function slotsFor(brand) {
  return (brand.slots || []).filter(time.isValidSlot).slice().sort();
}

// Fills empty posting slots for the next few days with queued pins the user can
// review, edit or delete before anything goes out.
async function planBrand(db, brand, now = new Date()) {
  const settings = db.data.settings;
  const tz = settings.timezone || config.timezone;
  const created = [];

  const dates = time.upcomingDates(now, tz, Math.max(1, settings.planAheadDays || 3));
  const slots = slotsFor(brand);
  if (slots.length === 0) return created;

  for (const date of dates) {
    const brandPins = db.pins({ brandId: brand.id });
    const onThisDay = brandPins.filter(
      (pin) => pin.status !== 'cancelled' && time.localDate(new Date(pin.scheduledFor), tz) === date
    );
    let countToday = onThisDay.length;

    for (const slot of slots) {
      if (countToday >= (settings.maxPerDay || 3)) break;

      const when = time.zonedToUtc(date, slot, tz);
      if (when.getTime() <= now.getTime()) continue; // never backfill the past
      if (onThisDay.some((pin) => pin.scheduledFor === when.toISOString())) continue;

      const product = pickProduct(db.products(brand.id), db.pins({ brandId: brand.id }));
      if (!product) return created; // nothing postable for this brand yet

      const image = pickImage(product);
      const variant = product.pinCount + db.pins({ brandId: brand.id })
        .filter((pin) => pin.productId === product.id && pin.status === 'queued').length;

      const text = await copy.generateCopy(product, brand, variant, (level, msg) => db.log(level, msg));

      const pin = db.addPin({
        brandId: brand.id,
        productId: product.id,
        imageId: image.id,
        boardId: product.boardId || '',
        title: text.title,
        description: text.description,
        link: product.url,
        scheduledFor: when.toISOString(),
      });

      onThisDay.push(pin);
      created.push(pin);
      countToday += 1;
    }
  }

  return created;
}

async function planAll(db, now = new Date()) {
  const created = [];
  for (const brand of db.brands()) {
    created.push(...(await planBrand(db, brand, now)));
  }
  if (created.length) db.log('info', `Planned ${created.length} new pin(s).`);
  return created;
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

// Refreshes the stored token when it is close to expiry, then hands it back.
async function liveConnection(db, brand) {
  const connection = brand.pinterest;
  if (!connection || !connection.accessToken) return null;
  const reducingScopes = !pinterest.hasExactScopes(connection, 'production');
  if (!pinterest.isExpired(connection) && !reducingScopes) return connection;

  const refreshed = await pinterest.refreshConnection(connection);
  brand.pinterest = { ...connection, ...refreshed };
  db.save();
  db.log('info', `${reducingScopes ? 'Reduced and refreshed' : 'Refreshed'} Pinterest token for ${brand.name}.`);
  return brand.pinterest;
}

function markSuccess(db, pin, product, image, result) {
  db.updatePin(pin.id, {
    status: result.simulated ? 'simulated' : 'posted',
    postedAt: new Date().toISOString(),
    pinterestPinId: result.id,
    pinterestUrl: result.url,
    error: null,
  });
  if (product) {
    product.pinCount += 1;
    product.lastPinnedAt = new Date().toISOString();
  }
  if (image) image.uses += 1;
  db.save();
}

function markFailure(db, pin, message) {
  const attempts = (pin.attempts || 0) + 1;
  if (attempts >= MAX_ATTEMPTS) {
    db.updatePin(pin.id, { status: 'failed', attempts, error: message });
    db.log('error', `Pin failed after ${attempts} attempts: ${message}`);
  } else {
    db.updatePin(pin.id, {
      attempts,
      error: message,
      scheduledFor: new Date(Date.now() + RETRY_DELAY_MS).toISOString(),
    });
    db.log('warn', `Pin attempt ${attempts} failed, retrying in 10 minutes: ${message}`);
  }
}

// Posts one pin. Falls back to simulation whenever live posting is off or
// Pinterest is not connected yet, so the whole pipeline is testable today.
async function postPin(db, pin) {
  if (pin.approvedForPublishing !== true) {
    db.log('warn', `Blocked unapproved pin "${pin.title}" before the publishing path.`);
    return db.pin(pin.id);
  }

  const brand = db.brand(pin.brandId);
  const product = db.product(pin.productId);
  const image = product ? product.images.find((i) => i.id === pin.imageId) : null;

  if (!brand || !product || !image) {
    markFailure(db, pin, 'Product or image is missing - it may have been deleted.');
    return db.pin(pin.id);
  }

  const goLive = db.data.settings.liveMode && brand.pinterest && brand.pinterest.accessToken;

  try {
    let result;
    if (goLive) {
      if (!pin.boardId) throw new Error('No Pinterest board chosen for this product.');
      const connection = await liveConnection(db, brand);
      result = await pinterest.createPin(connection, pin, image);
      db.log('info', `Posted to Pinterest: "${pin.title}" (${brand.name}).`);
    } else {
      result = pinterest.simulateCreatePin();
      const why = !db.data.settings.liveMode ? 'simulation mode is on' : 'Pinterest is not connected yet';
      db.log('info', `Simulated pin "${pin.title}" (${brand.name}) - ${why}.`);
    }
    markSuccess(db, pin, product, image, result);
  } catch (err) {
    markFailure(db, pin, err.message);
  }

  return db.pin(pin.id);
}

function duePins(db, now = new Date()) {
  return db
    .pins({ status: 'queued' })
    .filter((pin) => pin.approvedForPublishing === true)
    .filter((pin) => Date.parse(pin.scheduledFor) <= now.getTime())
    .sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor));
}

// The once-a-minute tick: post anything due, respecting the pause switches.
async function runDue(db, now = new Date()) {
  if (db.data.settings.paused) return [];

  const posted = [];
  for (const pin of duePins(db, now)) {
    const brand = db.brand(pin.brandId);
    if (!brand || brand.paused) continue;
    posted.push(await postPin(db, pin));
  }
  return posted;
}

module.exports = {
  pickProduct,
  pickImage,
  planBrand,
  planAll,
  postPin,
  runDue,
  duePins,
  liveConnection,
  MAX_ATTEMPTS,
};
