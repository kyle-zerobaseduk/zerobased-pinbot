'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const SCOPES = ['boards:read', 'boards:write', 'pins:read', 'pins:write', 'user_accounts:read'];

function basicAuthHeader() {
  const raw = `${config.pinterest.appId}:${config.pinterest.appSecret}`;
  return `Basic ${Buffer.from(raw).toString('base64')}`;
}

function buildAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: config.pinterest.appId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: SCOPES.join(','),
    state,
  });
  return `${config.pinterest.authBase}/?${params.toString()}`;
}

function apiBase(environment = 'production') {
  return environment === 'sandbox' ? config.pinterest.sandboxApiBase : config.pinterest.apiBase;
}

async function tokenRequest(body, environment = 'production') {
  const response = await fetch(`${apiBase(environment)}/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body).toString(),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Pinterest token request failed (${response.status}): ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

function connectionFromToken(token, extra = {}) {
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token || null,
    // Refresh a little early so a pin never fails on a token that expires mid-flight.
    expiresAt: new Date(Date.now() + (Number(token.expires_in || 2592000) - 300) * 1000).toISOString(),
    scopes: token.scope || SCOPES.join(','),
    connectedAt: new Date().toISOString(),
    ...extra,
  };
}

async function exchangeCode(code, environment = 'production') {
  const token = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
  }, environment);
  return connectionFromToken(token);
}

async function refreshConnection(connection, environment = 'production') {
  if (!connection.refreshToken) {
    throw new Error('No refresh token stored - reconnect this Pinterest account.');
  }
  const token = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: connection.refreshToken,
  }, environment);
  return connectionFromToken(token, {
    // Pinterest does not always return a new refresh token; keep the old one.
    refreshToken: token.refresh_token || connection.refreshToken,
    username: connection.username,
    accountId: connection.accountId,
  });
}

function isExpired(connection) {
  return !connection.expiresAt || new Date(connection.expiresAt).getTime() <= Date.now();
}

async function apiRequest(connection, endpoint, options = {}, environment = 'production') {
  const response = await fetch(`${apiBase(environment)}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${connection.accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (_) {
    payload = { raw: text };
  }

  if (!response.ok) {
    const message = payload?.message || payload?.error_description || text.slice(0, 300);
    const label = environment === 'sandbox' ? 'Pinterest Sandbox API' : 'Pinterest API';
    const err = new Error(`${label} ${response.status}: ${message}`);
    err.status = response.status;
    throw err;
  }
  return payload;
}

async function getAccount(connection, environment = 'production') {
  const data = await apiRequest(connection, '/user_account', {}, environment);
  return { username: data.username || '', accountId: data.id || '', accountType: data.account_type || '' };
}

async function getBoards(connection, environment = 'production') {
  const boards = [];
  let bookmark = '';
  do {
    const query = new URLSearchParams({ page_size: '100' });
    if (bookmark) query.set('bookmark', bookmark);
    const data = await apiRequest(connection, `/boards?${query.toString()}`, {}, environment);
    for (const board of data.items || []) {
      boards.push({ id: board.id, name: board.name, privacy: board.privacy || '' });
    }
    bookmark = data.bookmark || '';
  } while (bookmark);
  return boards;
}

function guessContentType(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}

// An uploaded image is sent as base64 so Pinterest never has to reach our server;
// a pasted image URL is passed straight through.
function mediaSource(image) {
  if (image.file) {
    const filePath = path.join(config.uploadsDir, path.basename(image.file));
    const data = fs.readFileSync(filePath).toString('base64');
    return { source_type: 'image_base64', content_type: guessContentType(image.file), data };
  }
  if (image.url) {
    return { source_type: 'image_url', url: image.url };
  }
  throw new Error('Pin has no image attached.');
}

async function createPin(connection, pin, image, environment = 'production') {
  const body = {
    board_id: pin.boardId,
    title: (pin.title || '').slice(0, 100),
    description: (pin.description || '').slice(0, 800),
    link: pin.link,
    media_source: mediaSource(image),
  };
  const data = await apiRequest(connection, '/pins', { method: 'POST', body: JSON.stringify(body) }, environment);
  return {
    id: data.id,
    url: data.id ? `https://www.pinterest.com/pin/${data.id}/` : null,
  };
}

async function createBoard(connection, name, environment = 'production') {
  const data = await apiRequest(connection, '/boards', {
    method: 'POST',
    body: JSON.stringify({ name, privacy: 'PUBLIC' }),
  }, environment);
  return { id: data.id, name: data.name || name, privacy: data.privacy || 'PUBLIC' };
}

async function getPin(connection, pinId, environment = 'production') {
  return apiRequest(connection, `/pins/${encodeURIComponent(pinId)}`, {}, environment);
}

// Used when Pinterest is not connected yet, or the user has left simulation on.
// Same shape as a real post so the rest of the app cannot tell the difference.
function simulateCreatePin() {
  return {
    id: `sim-${crypto.randomBytes(6).toString('hex')}`,
    url: null,
    simulated: true,
  };
}

module.exports = {
  SCOPES,
  apiBase,
  buildAuthUrl,
  exchangeCode,
  refreshConnection,
  isExpired,
  getAccount,
  getBoards,
  createBoard,
  getPin,
  createPin,
  simulateCreatePin,
  mediaSource,
};
