'use strict';

const crypto = require('crypto');
const express = require('express');

const config = require('../config');
const auth = require('../auth');
const pinterest = require('../pinterest');

const STATE_TTL_MS = 10 * 60 * 1000;

function page(title, body) {
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body{font:16px/1.6 system-ui,sans-serif;background:#12151b;color:#e8eaf0;margin:0;
       display:grid;place-items:center;min-height:100vh;padding:24px;text-align:center}
  .card{max-width:420px;background:#1b1f28;border:1px solid #2a3040;border-radius:14px;padding:28px}
  h1{font-size:20px;margin:0 0 12px}
  p{color:#a8b0c0;margin:0 0 20px}
  a{display:inline-block;background:#e0446a;color:#fff;text-decoration:none;
    padding:12px 20px;border-radius:10px;font-weight:600}
</style>
<div class="card"><h1>${title}</h1>${body}<a href="/">Back to PinBot</a></div>`;
}

function buildRouter(db) {
  const router = express.Router();

  // Start the Pinterest login. Signed-in dashboard users only.
  router.get('/pinterest/start/:brandId', (req, res) => {
    if (!auth.isAuthed(db, req)) return res.redirect('/');

    const brand = db.brand(req.params.brandId);
    if (!brand) return res.status(404).send(page('Unknown brand', '<p>That brand does not exist.</p>'));

    if (!config.pinterestConfigured) {
      return res.status(400).send(
        page('Pinterest not set up yet', '<p>Add PINTEREST_APP_ID and PINTEREST_APP_SECRET to the service, then try again.</p>')
      );
    }
    if (!config.appUrl) {
      return res.status(400).send(
        page('Missing web address', '<p>Set APP_URL to this app&rsquo;s public address so Pinterest knows where to send you back.</p>')
      );
    }

    const state = crypto.randomBytes(16).toString('hex');
    db.data.oauthStates = db.data.oauthStates
      .filter((s) => Date.now() - s.at < STATE_TTL_MS)
      .concat({ state, brandId: brand.id, at: Date.now() });
    db.save();

    res.redirect(pinterest.buildAuthUrl(state));
  });

  // Pinterest sends the user back here with a one-time code.
  router.get('/pinterest/callback', async (req, res) => {
    const { code, state, error } = req.query;

    if (error) {
      db.log('warn', `Pinterest login cancelled: ${error}`);
      return res.send(page('Pinterest login cancelled', '<p>Nothing was changed. You can try again any time.</p>'));
    }

    const record = db.data.oauthStates.find((s) => s.state === state);
    db.data.oauthStates = db.data.oauthStates.filter((s) => s.state !== state);
    db.save();

    if (!record || Date.now() - record.at > STATE_TTL_MS) {
      return res.status(400).send(page('That link expired', '<p>Please start the Pinterest connection again.</p>'));
    }

    const brand = db.brand(record.brandId);
    if (!brand) return res.status(404).send(page('Unknown brand', '<p>That brand does not exist.</p>'));

    try {
      const connection = await pinterest.exchangeCode(String(code));
      const account = await pinterest.getAccount(connection);
      brand.pinterest = { ...connection, ...account };
      db.save();
      db.log('info', `Connected Pinterest account @${account.username} to ${brand.name}.`);

      // Boards are what the dashboard needs next, so fetch them straight away.
      try {
        const boards = await pinterest.getBoards(brand.pinterest);
        db.setBoards(brand.id, boards);
      } catch (boardErr) {
        db.log('warn', `Connected, but could not load boards yet: ${boardErr.message}`);
      }

      return res.send(
        page(`Connected to @${account.username}`, `<p>${brand.name} is now linked to Pinterest.</p>`)
      );
    } catch (err) {
      db.log('error', `Pinterest connection failed: ${err.message}`);
      return res.status(502).send(page('Could not connect', `<p>${err.message}</p>`));
    }
  });

  // Removes our stored token only. It does not touch the Pinterest account.
  router.post('/pinterest/disconnect/:brandId', (req, res) => {
    if (!auth.isAuthed(db, req)) return res.status(401).json({ error: 'Please sign in again.' });

    const brand = db.brand(req.params.brandId);
    if (!brand) return res.status(404).json({ error: 'Unknown brand.' });

    brand.pinterest = null;
    // Live posting cannot continue with nothing connected.
    if (!db.brands().some((b) => b.pinterest)) db.data.settings.liveMode = false;
    db.save();
    db.log('info', `Removed the stored Pinterest token for ${brand.name}. The Pinterest account itself is untouched.`);
    res.json({ ok: true });
  });

  return router;
}

module.exports = { buildRouter };
