'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const cron = require('node-cron');

const config = require('./src/config');
const { Db } = require('./src/db');
const engine = require('./src/engine');
const apiRoutes = require('./src/routes/api');
const oauthRoutes = require('./src/routes/oauth');

const db = new Db();
const app = express();

// Railway terminates TLS in front of the app.
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Generous limit: product images arrive as base64 inside the JSON body.
app.use(express.json({ limit: '12mb' }));

app.use('/api', apiRoutes.buildRouter(db));
app.use('/oauth', oauthRoutes.buildRouter(db));

// Uploaded product images. Filenames are random, and Pinterest may need to read them.
app.use('/uploads', express.static(config.uploadsDir, { maxAge: '7d' }));
// A missing image must 404, not fall through to the dashboard HTML below.
app.use('/uploads', (req, res) => res.status(404).json({ error: 'Image not found.' }));

// The public K.D. Publishing page, kept as a plain static file.
app.get(['/kd-publishing', '/kd'], (req, res) => {
  res.sendFile(path.join(__dirname, 'site', 'kd-publishing.html'));
});

// Pinterest and visitors must be able to read the policy without a dashboard login.
app.get(['/privacy/ZeroBasedUK', '/privacy/ZeroBasedUK/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'site', 'privacy.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    paused: db.data.settings.paused,
    liveMode: db.data.settings.liveMode,
    products: db.data.products.length,
    queued: db.pins({ status: 'queued' }).length,
  });
});

// Unknown API routes answer as API, not as the dashboard page.
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  db.log('error', `Request failed: ${err.message}`);
  res.status(500).json({ error: 'Something went wrong. Check the Activity tab.' });
});

// ---------------------------------------------------------------------------
// Background jobs
// ---------------------------------------------------------------------------

let ticking = false;

function startJobs() {
  // Every minute: post whatever is due. A guard stops overlapping runs.
  cron.schedule('* * * * *', async () => {
    if (ticking) return;
    ticking = true;
    try {
      await engine.runDue(db);
    } catch (err) {
      db.log('error', `Scheduler error: ${err.message}`);
    } finally {
      ticking = false;
    }
  });

  // Every 15 minutes: keep the queue topped up a few days ahead.
  cron.schedule('*/15 * * * *', async () => {
    try {
      await engine.planAll(db);
    } catch (err) {
      db.log('error', `Planner error: ${err.message}`);
    }
  });
}

function start() {
  startJobs();
  return app.listen(config.port, () => {
    db.log('info', `PinBot Simple listening on port ${config.port}.`);
    db.log('info', `Data directory: ${config.dataDir}`);
    db.log('info', `Timezone: ${db.data.settings.timezone}`);
    db.log('info', `Posting mode: ${db.data.settings.liveMode ? 'LIVE' : 'SIMULATION'} (${db.data.settings.paused ? 'paused' : 'running'})`);

    if (!config.dashboardPassword) {
      db.log('warn', 'DASHBOARD_PASSWORD is not set - the dashboard cannot be opened until it is.');
    }
    if (!config.pinterestConfigured) {
      db.log('info', 'Pinterest app credentials not set yet - running in simulation only. That is expected before approval.');
    }
    if (!fs.existsSync(path.join(__dirname, 'site', 'kd-publishing.html'))) {
      db.log('warn', 'site/kd-publishing.html is missing - the /kd page will 404.');
    }
  });
}

// Only take over the port when run directly; tests import the app instead.
if (require.main === module) start();

module.exports = { app, db, start, startJobs };
