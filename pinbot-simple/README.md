# PinBot Simple

A small, reliable Pinterest scheduler for two brands:

- **K.D. Publishing** — Amazon KDP journals, word searches and puzzle books
- **ZeroBased UK** — digital products on Etsy

Products in → pins scheduled and rotated → Pinterest → Amazon/Etsy.

> **PinBot Simple does not touch PinBot V2.** It lives entirely inside this
> `pinbot-simple/` folder, has its own `package.json`, and is meant to run as a
> **separate** Railway service. The existing `grateful-respect` project, the
> `zerobased-pinbot` service and its volume are left exactly as they are.

## What makes it simpler than V2

| | PinBot V2 | PinBot Simple |
|---|---|---|
| Runtime dependencies | express, node-cron, dotenv, axios | express, node-cron |
| Required env vars to boot | 4+ | 1 (`DASHBOARD_PASSWORD`) |
| Behaviour with no Pinterest access | crashes / fails | runs in practice mode |
| Data store | 6 JSON files | 1 JSON file, written atomically |
| Corrupt data file | crash loop | parked, app restarts clean |
| Automated tests | none | 33 |

## Running it locally

```bash
cd pinbot-simple
npm install
DASHBOARD_PASSWORD=letmein npm start
# open http://localhost:3000
npm test
```

## Environment variables

Only the first is required.

| Variable | Needed | What it does |
|---|---|---|
| `DASHBOARD_PASSWORD` | **yes** | The password for the dashboard |
| `DATA_DIR` | on Railway | Where data lives. Use `/data` with a volume |
| `APP_URL` | for Pinterest | Public address, e.g. `https://pinbot.zerobaseduk.co.uk` |
| `PINTEREST_APP_ID` | for Pinterest | From the Pinterest developer app |
| `PINTEREST_APP_SECRET` | for Pinterest | From the Pinterest developer app |
| `ANTHROPIC_API_KEY` | optional | Turns on AI-written pin copy |
| `TZ` | optional | Defaults to `Europe/London` |

Everything except `DASHBOARD_PASSWORD` can be added later. Without Pinterest
credentials the app runs in **practice mode**: pins are planned, written,
scheduled and "posted" so the whole system can be tested and tuned, but nothing
is sent to Pinterest.

## Layout

```
pinbot-simple/
  server.js            entry point: routes, static files, cron jobs
  src/
    config.js          env vars and paths
    db.js              the single JSON data file
    time.js            timezone maths (no date library)
    copy.js            pin copywriter: AI, with a built-in fallback
    pinterest.js       Pinterest OAuth + v5 API
    engine.js          rotation, planning, posting, retries
    auth.js            password login and signed session cookie
    routes/api.js      dashboard API
    routes/oauth.js    Pinterest connect / disconnect
  public/              the dashboard (plain HTML, CSS, JS - no build step)
  site/                the public K.D. Publishing page, served at /kd
  test/                33 tests: node --test
```

## Safety rules built in

- Starts **paused** and in **practice mode**; nothing posts until switched on.
- Live posting cannot be enabled until a Pinterest account is actually connected.
- "Disconnect" removes our stored token only — it never changes the Pinterest
  account itself.
- Access tokens are never sent to the browser.
- A failed pin retries twice, ten minutes apart, then stops and shows the reason.

## Health check

`GET /healthz` returns posting state and queue size without needing a login.
