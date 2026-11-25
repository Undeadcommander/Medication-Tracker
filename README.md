# MedTracker

A medication tracker you can install as an app (PWA). Add your medications, set when to take them, and get reminder notifications on desktop and iOS.

## Features

- **Medication tiles.** Each tile shows the name, strength and form, the schedule, the next dose, what the medication is for, today's progress and the remaining supply. Click a tile to open the detail view, which adds adherence, upcoming doses, 14-day history, prescriber and pharmacy, notes, and label information (uses, warnings, side effects, interactions).
- **Automatic medication recognition.** As you type, names are matched against the U.S. National Library of Medicine's RxTerms/RxNorm databases. Picking a strength fills in the dose and form. MedTracker then looks up the generic and brand names and the drug class (RxClass), and pulls FDA label text (openFDA). Typos get "Did you mean…?" suggestions. Unknown medications can still be added by hand.
- **Schedules.** The presets are *Every day*, *Twice a day* and *Every other day*. *Custom* repeats every N days, or every N weeks on chosen weekdays. Every schedule has start and optional end dates, and you can turn on "Choose specific times" to pick exact dose times (custom allows up to 8 a day).
- **Reminders.** Each medication has its own on/off switch for notifications, and reminders follow its schedule. The notification has **Mark as taken** and **Snooze 10 min** buttons. *Discreet mode* leaves the medication name out of notifications and never sends it to the server.
- **Today panel.** Take, skip or undo each dose. Supply on hand counts down automatically.
- **Encrypted export/import.** Your data is encrypted on your device into a `.medvault` file (AES-256-GCM, key from your passphrase with PBKDF2-SHA-256 at 600,000 iterations). Import it on another device to merge with or replace that device's data. No server ever sees it.
- **Google sign-in.** Your Google profile picture becomes your account icon, and each account's data is kept separately on the device. A guest mode works without an account. Guest data moves into your account the first time you sign in.

## Running it

Requires Node.js 20+.

```bash
npm install
npm run dev               # web app on http://localhost:5173, push server on :8787
```

Other scripts: `npm test` (Vitest), `npm run typecheck`, `npm run build` (outputs `dist/`), and `npm start` (one server on `$PORT` that serves `dist/` and the `/api` push endpoints).

### Deployment (GitHub Pages)

Every push to `main` runs [`.github/workflows/pages.yml`](.github/workflows/pages.yml). It typechecks, runs the tests, builds with `--base=/Medication-Tracker/`, and publishes to **https://undeadcommander.github.io/Medication-Tracker/**. In the repo's **Settings → Pages**, **Source** must be set to **GitHub Actions**.

All paths (service worker, manifest, icons, API) are relative to the site's base path, so the same code runs at `/` locally and under `/Medication-Tracker/` on Pages.

### Google sign-in (Firebase project `sign-in-for-med`)

The public Firebase web config is committed in [`src/firebase-config.json`](src/firebase-config.json), like Haven. These values are identifiers, not secrets: access is controlled by Firebase's authorized domains. Optional `VITE_FIREBASE_*` variables in `.env` override them (see `.env.example`).

Already configured in the Firebase console:
- **Sign-in method:** Google is enabled.
- **Authorized domains:** `localhost`, `undeadcommander.github.io`, plus Firebase's defaults. A new domain (a custom domain, say) must be added under **Authentication → Settings → Authorized domains**, otherwise sign-in fails with `auth/unauthorized-domain`.

Before inviting other people, publish the OAuth consent screen. In [Google Cloud Console → APIs & Services → OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent?project=sign-in-for-med), add the app name, logo and privacy-policy link, then publish. Until then Google may show an "unverified app" warning.

How it works: sign-in uses a Google popup (a full-page redirect on an iPhone/iPad Home Screen app, where popups don't work). The Firebase SDK loads only when someone signs in, so guests never download it. The only details read from the Google account are the name, email and profile picture, and the picture becomes the account icon.

**Known limitation:** sign-in inside the iPhone/iPad *Home Screen app* may fail on GitHub Pages. Safari blocks the storage that redirect sign-in needs when the site's domain differs from `authDomain` (`sign-in-for-med.firebaseapp.com`), and GitHub Pages can't proxy Firebase's `/__/auth/*` handler to fix that. Desktop browsers and Safari tabs are unaffected. If it matters, host on Firebase Hosting and set `authDomain` to the site's own domain (see Firebase's ["Best practices for using signInWithRedirect"](https://firebase.google.com/docs/auth/web/redirect-best-practices)).

### Push notifications

- **Desktop** (Chrome, Edge, Firefox, Safari): open the account menu, choose **Notification settings**, then **Turn on notifications**.
- **iPhone/iPad** (iOS/iPadOS 16.4+): Apple only allows web push for sites that are installed to the Home Screen. In Safari, tap **Share → Add to Home Screen**, open MedTracker from the Home Screen, then turn on notifications. The settings screen walks you through it.
- Push needs **HTTPS** everywhere except `localhost`.

**Reminder server.** For reminders to arrive while MedTracker is *closed*, the push server (`server/index.ts`) has to run somewhere that supports Node with HTTPS and a persistent disk, such as Render, Fly.io, Railway or Google Cloud Run. GitHub Pages can't run it. Without it, the Pages site builds with `VITE_API_BASE=none`, and reminders appear only while the app is open or in the background. To connect one:
1. Deploy the server with `npm start`, and set `ALLOWED_ORIGINS=https://undeadcommander.github.io` and `VAPID_SUBJECT=mailto:<your address>`. Keep `server/data/` on persistent storage: if `vapid.json` changes, every device has to turn notifications on again.
2. In GitHub, go to **Settings → Secrets and variables → Actions → Variables** and add `VITE_API_BASE` = `https://<your-server>/api`. Then re-run the Pages workflow.

How it works: whenever your medications or dose log change, the client works out the next 30 days of dose times and sends that list to the push server, keyed by a random per-device secret. The server sends each one when it's due. Opening the app refreshes the list. If the server can't be reached, the app shows reminders itself while it's open.

## Privacy

- Your medications and dose history are stored only in this browser's local storage. There is no account database.
- The push server stores only the push subscription and upcoming reminder times and text for each device. With discreet mode on, the text is generic.
- Name lookups send the text you type to the public NLM (`clinicaltables.nlm.nih.gov`, `rxnav.nlm.nih.gov`) and openFDA (`api.fda.gov`) APIs. These are free, keyless public services. openFDA allows about 1,000 requests a day per IP without a key, and results are cached locally for 30 days.
- Exports are encrypted end to end. If you lose the passphrase, the file can't be recovered.

## Project layout

```
shared/        types + schedule engine (used by client and server)
src/lib/       store, auth (Google), push client, drug lookup, vault (encryption), dose helpers
src/components UI: tiles, detail, form, schedule editor, notifications, export/import
server/        Express + web-push reminder server
public/        service worker, manifest, icons
```

> Drug information comes from public NLM and FDA data. It's a reference, not medical advice.
