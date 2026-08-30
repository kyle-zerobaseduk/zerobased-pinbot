# Setting up PinBot Simple

Written to be followed on a phone. One step at a time. Nothing here touches
PinBot V2, the `grateful-respect` project, the `zerobased-pinbot` service, its
volume, or either Pinterest account.

---

## Stage 1 — Put it online (about 10 minutes)

You will create a **brand new** Railway service. Do not open or edit the
existing `zerobased-pinbot` service at any point.

1. Open **railway.app** and sign in.
2. Tap **New Project** → **Deploy from GitHub repo**.
3. Choose **kyle-zerobaseduk/zerobased-pinbot**.
4. When it asks for settings, set:
   - **Branch**: `claude/pinbot-simple-build-1ivr7q`
   - **Root Directory**: `pinbot-simple`
5. Name the project something obvious, like **pinbot-simple**.

> The Root Directory setting is the important one. It tells Railway to build
> only the new folder and ignore PinBot V2 completely.

---

## Stage 2 — Add a disk (2 minutes)

Your products, images and pin history need somewhere permanent to live.

1. In the **new** project, open the service → **Variables** → **Volumes**.
2. Tap **Add Volume**. Mount path: `/data`.
3. Give it any name — but **not** `zerobased-pinbot-volume`. That one belongs to
   PinBot V2 and must be left alone.

---

## Stage 3 — One setting (1 minute)

Still in the new service, open **Variables** and add just this:

| Name | Value |
|---|---|
| `DASHBOARD_PASSWORD` | a password you choose |

Save. The service restarts on its own.

> PinBot finds the `/data` volume by itself, so there is nothing else to set.

Tap the generated URL. You should see the PinBot Simple login screen. Sign in
with the password you just chose.

**At this point the whole system works** — in practice mode. You can add
products, upload images, generate pin text and watch the queue fill up. Nothing
reaches Pinterest yet, which is exactly what we want while access is pending.

---

## Stage 4 — Load your products (as long as you like)

For each book or digital product:

1. Pick the brand at the top: **K.D. Publishing** or **ZeroBased UK**.
2. Go to **Products** → **Add several at once**. Paste one product per line:

   ```
   80-Day Gratitude Journal | https://www.amazon.co.uk/dp/...
   Large Print Word Search Vol. 1 | https://www.amazon.co.uk/dp/...
   ```

   A bare link on its own line works too — it imports **paused** with a
   placeholder name, so a guessed name can never be pinned. Rename it, then
   tap **Resume**.
3. Tap **Open** on each product → **Upload image**. Add two or three images per
   product so pins do not repeat the same picture.
4. Tap **Preview pin text** to see what PinBot would write.

Board names for both brands are already filled in. Swap them for your real
boards later, or edit them now in the **Pinterest** tab.

Then go to **Queue** → **Refill the queue** and you will see the next few days
of pins, rotating between your products.

---

## Stage 5 — Pinterest (when your API access comes through)

Do this only once Pinterest has approved your developer app.

**Step 5a.** In the Railway service, add one more variable:

| Name | Value |
|---|---|
| `APP_URL` | the full https address of this service |

**Step 5b.** Open your PinBot dashboard → **Settings** → scroll to **System**.
It shows a line called **Pinterest redirect URI**. Copy it.

**Step 5c.** Go to developers.pinterest.com → your app → paste that exact line
into the app's **Redirect URIs** and save.

**Step 5d.** Back in Railway, add two more variables from the Pinterest app page:

| Name | Value |
|---|---|
| `PINTEREST_APP_ID` | your app ID |
| `PINTEREST_APP_SECRET` | your app secret |

**Step 5e.** In PinBot → **Pinterest** tab → tap **Connect K.D. Publishing**.
Sign in to that Pinterest account and approve. Repeat with the brand switcher
set to **ZeroBased UK** for the second account.

Your real boards appear automatically. Go back through your products and pick
the correct board for each one.

---

## Stage 6 — Go live

1. **Settings** → turn **Post for real** on. (It will refuse until a Pinterest
   account is connected — that is deliberate.)
2. Use **Pin now** on one product first and check it looks right on Pinterest.
3. When you are happy, **Settings** → turn **Automatic posting** on.

---

## Day to day

- **Pause everything**: Settings → Automatic posting off.
- **Pause one brand**: Settings → the brand's own switch.
- **Pause one product**: Products → **Pause** on that product.
- **Something failed**: Queue → the pin shows the reason → **Try again**.
- **See what happened**: the **Activity** tab.

## The K.D. Publishing page

Your landing page is served at `/kd` on this same service. To put your own
design in, replace the contents of `pinbot-simple/site/kd-publishing.html`.
Nothing else needs changing.
