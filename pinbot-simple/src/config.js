'use strict';

const fs = require('fs');
const path = require('path');

// Minimal .env loader so local runs work without an extra dependency.
// Railway (and any host) supplies real environment variables, which always win.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(path.join(__dirname, '..', '.env'));

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));

const config = {
  port: Number(process.env.PORT) || 3000,
  dataDir,
  uploadsDir: path.join(dataDir, 'uploads'),
  dbFile: path.join(dataDir, 'pinbot.json'),
  timezone: process.env.TZ || 'Europe/London',
  dashboardPassword: process.env.DASHBOARD_PASSWORD || '',
  appUrl: (process.env.APP_URL || '').replace(/\/+$/, ''),
  pinterest: {
    appId: process.env.PINTEREST_APP_ID || '',
    appSecret: process.env.PINTEREST_APP_SECRET || '',
    apiBase: process.env.PINTEREST_API_BASE || 'https://api.pinterest.com/v5',
    authBase: process.env.PINTEREST_AUTH_BASE || 'https://www.pinterest.com/oauth',
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.AI_MODEL || 'claude-haiku-4-5-20251001',
  },
};

config.pinterestConfigured = Boolean(config.pinterest.appId && config.pinterest.appSecret);
config.aiConfigured = Boolean(config.anthropic.apiKey);
config.redirectUri = config.appUrl ? `${config.appUrl}/oauth/pinterest/callback` : '';

module.exports = config;
