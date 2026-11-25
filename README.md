# MedTracker

A medication tracker you can install as an app (PWA). Add your medications, set when to take them, and get reminder notifications on desktop and iOS.

## Features

- **Medication tiles.** Each tile shows the name, strength and form, the schedule, the next dose, what the medication is for, today's progress and the remaining supply. Click a tile to open the detail view, which adds adherence, upcoming doses, 14-day history, prescriber and pharmacy, notes, and label information (uses, warnings, side effects, interactions).
- **Automatic medication recognition.** As you type, names are matched against the U.S. National Library of Medicine's RxTerms/RxNorm databases. Picking a strength fills in the dose and form. MedTracker then looks up the generic and brand names and the drug class (RxClass), and pulls FDA label text (openFDA). Typos get "Did you mean…?" suggestions. Unknown medications can still be added by hand.
- **Schedules.** The presets are *Every day*, *Twice a day* and *Every other day*. *Custom* repeats every N days, or every N weeks on chosen weekdays. Every schedule has start and optional end dates, and you can turn on "Choose specific times" to pick exact dose times (custom allows up to 8 a day).
- **Reminders.** Each medication has its own on/off switch for notifications, and reminders follow its schedule. The notification has **Mark as taken** and **Snooze 10 min** buttons. *Discreet mode* leaves the medication name out of notifications and never sends it to the server.
- **Today panel.** Take, skip or undo each dose. Supply on hand counts down automatically.
- **Encrypted export/import.** Your data is encrypted on your device into a `.medvault` file (AES-256-GCM, key from your passphrase with PBKDF2-SHA-256 at 600,000 iterations). Import it on another device to merge with or replace that device's data. No server ever sees it.
- **Google sign-in with end-to-end encrypted cloud sync.** Your Google profile picture becomes your account icon. Medications and dose history sync across every device where you're signed in. They're encrypted on your device with a key only you can unlock (your sync passphrase or recovery key), so the cloud stores only ciphertext. Sync works offline: edits are saved on the device and upload when you reconnect. The account menu shows the sync status. A guest mode works without an account and keeps everything on the device. Guest data moves into your account the first time you sign in.

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

**iPhone/iPad Home Screen app (self-hosted sign-in helpers).** Safari blocks the third-party storage that redirect sign-in relies on when the sign-in pages live on another domain (`sign-in-for-med.firebaseapp.com`). Without a fix, the Home Screen app bounces back to the sign-in screen. So the site hosts Firebase's sign-in helper pages itself, in [`public/__/auth/`](public/__/auth/). This is Option 3 of Firebase's ["Best practices for using signInWithRedirect"](https://firebase.google.com/docs/auth/web/redirect-best-practices). The Pages build sets `VITE_FIREBASE_SELF_HOSTED_AUTH=true`, which makes `authDomain` become `undeadcommander.github.io/Medication-Tracker`, so sign-in never leaves the app's own origin. Local development keeps using `firebaseapp.com`. Things to keep in mind:
- The Google OAuth client ("Web client (auto created by Google Service)" in [Google Cloud → Credentials](https://console.cloud.google.com/apis/credentials?project=sign-in-for-med)) lists `https://undeadcommander.github.io/Medication-Tracker/__/auth/handler` as an authorized redirect URI. A new host or path needs its own entry.
- The helper files are copies of `https://sign-in-for-med.firebaseapp.com/__/auth/{handler,handler.js,experiments.js,iframe,iframe.js}`, with `handler` and `iframe` saved as `.html` so GitHub Pages serves them as web pages. Re-download them now and then to pick up Google's updates.

### Push notifications

- **Desktop** (Chrome, Edge, Firefox, Safari): open the account menu, choose **Notification settings**, then **Turn on notifications**.
- **iPhone/iPad** (iOS/iPadOS 16.4+): Apple only allows web push for sites that are installed to the Home Screen. In Safari, tap **Share → Add to Home Screen**, open MedTracker from the Home Screen, then turn on notifications. The settings screen walks you through it.
- Push needs **HTTPS** everywhere except `localhost`.

**Reminder server.** For reminders to arrive while MedTracker is *closed*, the push server (`server/index.ts`) has to run somewhere that supports Node with HTTPS and a persistent disk, such as Render, Fly.io, Railway or Google Cloud Run. GitHub Pages can't run it. Without it, the Pages site builds with `VITE_API_BASE=none`, and reminders appear only while the app is open or in the background. To connect one:
1. Deploy the server with `npm start`, and set `ALLOWED_ORIGINS=https://undeadcommander.github.io` and `VAPID_SUBJECT=mailto:<your address>`. Keep `server/data/` on persistent storage: if `vapid.json` changes, every device has to turn notifications on again.
2. In GitHub, go to **Settings → Secrets and variables → Actions → Variables** and add `VITE_API_BASE` = `https://<your-server>/api`. Then re-run the Pages workflow.

How it works: whenever your medications or dose log change, the client works out the next 30 days of dose times and sends that list to the push server, keyed by a random per-device secret. The server sends each one when it's due. Opening the app refreshes the list. If the server can't be reached, the app shows reminders itself while it's open.

## Privacy

- **Guests:** medications and dose history are stored only in this browser's local storage.
- **Google accounts:** data is also stored in Cloud Firestore in the `sign-in-for-med` Firebase project, under `users/{uid}/`, **end-to-end encrypted**: it's encrypted on the device before upload, so Google and the project's owners see only ciphertext. The security rules in [`firebase/firestore.rules`](firebase/firestore.rules) also let each signed-in account read and write only its own documents. Signing out deletes this device's copy of the key and clears Firestore's offline cache.
- The push server stores only the push subscription and upcoming reminder times and text for each device. With discreet mode on, the text is generic.
- Name lookups send the text you type to the public NLM (`clinicaltables.nlm.nih.gov`, `rxnav.nlm.nih.gov`) and openFDA (`api.fda.gov`) APIs. These are free, keyless public services. openFDA allows about 1,000 requests a day per IP without a key, and results are cached locally for 30 days.
- Exports are encrypted end to end. If you lose the passphrase, the file can't be recovered.

### Cloud sync (Firestore)

- **Data layout:** `users/{uid}/meds/{medId}` holds one document per medication (`{ v, iv, ct }`, ciphertext only). `users/{uid}/logs/{YYYY-MM}` holds dose history, one document per month (`{ logs: { [logId]: { v, iv, ct } } }`); each log is encrypted on its own, so each new dose record is still a small per-field write. `users/{uid}/meta/crypto` holds the wrapped data key.
- **How it works:** the device's local copy is what the UI shows. Each edit becomes small operations (`src/lib/syncOps.ts`), which are queued in `localStorage` until the server acknowledges them, encrypted (`src/lib/syncCrypto.ts`), and written through Firestore's IndexedDB offline cache. Snapshots from the server are decrypted in order and replace the local copy. The first time an account syncs on a device, local and cloud data are merged. Logs recorded for the same dose on two devices are collapsed, and the newest wins.

### End-to-end encryption

- **Keys.** Each account has one random AES-256-GCM data key. It's stored in `meta/crypto` only *wrapped* (encrypted) twice: with a key derived from your **sync passphrase** (PBKDF2-SHA-256, 600,000 iterations, random salt) and with a key derived from a random 128-bit **recovery key** (HKDF-SHA-256), shown once as 7 groups of 4 characters with a built-in typo check. Each wrapping has a key-check value, so a wrong passphrase is reported as such and not as damaged data. The recovery key is also kept in `meta/crypto` encrypted with the data key, so an unlocked device can show it again.
- **Documents.** Every medication and dose log is AES-GCM encrypted with a fresh IV. The ciphertext is bound (as additional authenticated data) to your uid, the collection, and the document ID (medications) or month and log ID (dose logs), so ciphertext can't be swapped between documents or accounts. Medications are gzip-compressed and padded to 512-byte steps; every dose log pads to the same size, so its status doesn't show in its length. The old plaintext `updatedAt` field is gone: the timestamp is inside the ciphertext.
- **On each device.** After Google sign-in you set up encryption (first device) or unlock (other devices) once. The unwrapped key is kept only as a non-extractable `CryptoKey` in IndexedDB (`medtracker-keys`): the app can use it, but its bytes can't be read out. Until a device is unlocked, the app works locally and edits are queued. Nothing is read from or written to `meds`/`logs` before that.
- **Settings** (account menu → **Cloud encryption**): change the passphrase (re-wraps the key only; other unlocked devices stay unlocked), show or replace the recovery key, forget the key on this device, or, when locked, start over (deletes the cloud copy and re-uploads this device's data with new keys).
- **Migration.** Data synced before encryption is re-uploaded encrypted, overwriting the plaintext in place, on the first unlock. It's resumable: anything still plaintext in a later snapshot is picked up again. Cloud items that fail to decrypt (tampered or damaged) are skipped, counted in the account menu, and never delete this device's copy.
- **Limits.**
  - If you lose **both** the passphrase and the recovery key, the cloud copy can't be decrypted by anyone. Data on your devices is kept, and you can start over from one of them.
  - Firestore still sees metadata: how many medication documents and months exist, random medication and log IDs, month names (`YYYY-MM`), write times, and approximate sizes (rounded up by padding).
  - The app code served from GitHub Pages is trusted. Whoever controls this repo or its Pages deployment could ship code that reads your key or data on your device.
  - iPhone: Safari and the Home Screen app have separate storage, so each needs unlocking once. If Safari clears the site's data, you'll be asked to unlock again.
  - An outdated copy of the app left open in a tab could still upload a dose log in plaintext (the rules reject plaintext medications). It's re-encrypted at the next sync.
- **Rules:** they allow `meds`, `logs` and `meta` for the owner only, and accept medication writes only in the encrypted `{ v, iv, ct }` shape. To change them, edit [`firebase/firestore.rules`](firebase/firestore.rules) and publish it in **Firebase console → Firestore → Rules** (or with `npx firebase-tools deploy --only firestore:rules --project sign-in-for-med`).
- **Cost:** it stays within the free Spark plan for personal use (50k reads and 20k writes a day).

## Project layout

```
shared/        types + schedule engine (used by client and server)
src/lib/       store, auth (Google), push client, drug lookup, vault (encryption), dose helpers
src/components UI: tiles, detail, form, schedule editor, notifications, export/import
server/        Express + web-push reminder server
public/        service worker, manifest, icons
```

> Drug information comes from public NLM and FDA data. It's a reference, not medical advice.
