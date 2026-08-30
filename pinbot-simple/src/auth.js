'use strict';

const crypto = require('crypto');
const config = require('./config');

const COOKIE_NAME = 'pinbot_session';
const SESSION_DAYS = 30;

// Wrong-password attempts are throttled per IP so the dashboard cannot be
// brute-forced just because the password is short.
const attempts = new Map();
const MAX_ATTEMPTS = 8;
const LOCKOUT_MS = 15 * 60 * 1000;

function secretFor(db) {
  if (!db.data.sessionSecret) {
    db.data.sessionSecret = crypto.randomBytes(32).toString('hex');
    db.save();
  }
  return db.data.sessionSecret + config.dashboardPassword;
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function makeToken(db) {
  const payload = Buffer.from(
    JSON.stringify({ exp: Date.now() + SESSION_DAYS * 86400000 })
  ).toString('base64url');
  return `${payload}.${sign(payload, secretFor(db))}`;
}

function verifyToken(db, token) {
  if (!token || !token.includes('.')) return false;
  const [payload, signature] = token.split('.');
  const expected = sign(payload, secretFor(db));
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now();
  } catch (_) {
    return false;
  }
}

function parseCookies(header) {
  const jar = {};
  for (const part of (header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    jar[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return jar;
}

function passwordMatches(supplied) {
  const a = Buffer.from(String(supplied || ''));
  const b = Buffer.from(config.dashboardPassword);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function throttleKey(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function isLockedOut(req) {
  const record = attempts.get(throttleKey(req));
  if (!record) return false;
  if (Date.now() - record.at > LOCKOUT_MS) {
    attempts.delete(throttleKey(req));
    return false;
  }
  return record.count >= MAX_ATTEMPTS;
}

function noteFailure(req) {
  const key = throttleKey(req);
  const record = attempts.get(key) || { count: 0, at: Date.now() };
  record.count += 1;
  record.at = Date.now();
  attempts.set(key, record);
}

function clearFailures(req) {
  attempts.delete(throttleKey(req));
}

function setSessionCookie(res, token, secure) {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_DAYS * 86400}`,
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function isAuthed(db, req) {
  const jar = parseCookies(req.headers.cookie);
  return verifyToken(db, jar[COOKIE_NAME]);
}

function requireAuth(db) {
  return (req, res, next) => {
    if (isAuthed(db, req)) return next();
    return res.status(401).json({ error: 'Please sign in again.' });
  };
}

module.exports = {
  COOKIE_NAME,
  makeToken,
  verifyToken,
  passwordMatches,
  setSessionCookie,
  clearSessionCookie,
  isAuthed,
  requireAuth,
  isLockedOut,
  noteFailure,
  clearFailures,
  parseCookies,
};
