# Dosely

A medication tracker you can install as an app (PWA). Add your medications, set when to take them, and get reminder notifications on desktop and iOS.

## Features

- **Medication tiles.** Each tile shows the name, strength and form, the schedule, the next dose, what the medication is for, today's progress and the remaining supply. Click a tile to open the detail view, which adds adherence, upcoming doses, 14-day history, prescriber and pharmacy, notes, and label information (uses, warnings, side effects, interactions).
- **Automatic medication recognition.** As you type, names are matched against the U.S. National Library of Medicine's RxTerms/RxNorm databases. Picking a strength fills in the dose and form. Dosely then looks up the generic and brand names and the drug class (RxClass), and pulls FDA label text (openFDA). Typos get "Did you mean…?" suggestions. Unknown medications can still be added by hand.
- **Schedules.** The presets are *Every day*, *Twice a day* and *Every other day*. *Custom* repeats every N days, or every N weeks on chosen weekdays. Every schedule has start and optional end dates, and you can turn on "Choose specific times" to pick exact dose times (custom allows up to 8 a day).
- **Reminders.** Each medication has its own on/off switch for notifications, and reminders follow its schedule. The notification has **Mark as taken** and **Snooze 10 min** buttons. *Discreet mode* leaves the medication name out of notifications and never sends it to the server.
- **Today panel.** Take, skip or undo each dose. Supply on hand counts down automatically.
- **Encrypted export/import.** Your data is encrypted on your device into a `.medvault` file (AES-256-GCM, key from your passphrase with PBKDF2-SHA-256 at 600,000 iterations). Import it on another device to merge with or replace that device's data. No server ever sees it.
- **Google sign-in with end-to-end encrypted cloud sync.** Your Google profile picture becomes your account icon. Medications and dose history sync across every device where you're signed in. They're encrypted on your device with a key only you can unlock (your sync passphrase or recovery key), so the cloud stores only ciphertext. Sync works offline: edits are saved on the device and upload when you reconnect. The account menu shows the sync status. A guest mode works without an account and keeps everything on the device. Guest data moves into your account the first time you sign in.
- **Delete your account.** Account menu → **Delete account** permanently deletes the account and everything stored for it (see [Deleting an account](#deleting-an-account)). Guests get **Delete all data**, which clears this device.

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
- **iPhone/iPad** (iOS/iPadOS 16.4+): Apple only allows web push for sites that are installed to the Home Screen. In Safari, tap **Share → Add to Home Screen**, open Dosely from the Home Screen, then turn on notifications. The settings screen walks you through it.
- Push needs **HTTPS** everywhere except `localhost`.

**Reminder server.** For reminders to arrive while Dosely is *closed*, the push server (`server/index.ts`) has to run somewhere that supports Node with HTTPS and a persistent disk, such as Render, Fly.io, Railway or Google Cloud Run. GitHub Pages can't run it. Without it, the Pages site builds with `VITE_API_BASE=none`, and reminders appear only while the app is open on screen (iPhone pauses it when you switch away). Reopening within 2 hours of a missed dose shows its reminder then. To connect one:
1. Deploy the server with `npm start`, and set `ALLOWED_ORIGINS=https://undeadcommander.github.io` and `VAPID_SUBJECT=mailto:<your address>`. Keep `server/data/` on persistent storage: if `vapid.json` changes, every device has to turn notifications on again.
2. In GitHub, go to **Settings → Secrets and variables → Actions → Variables** and add `VITE_API_BASE` = `https://<your-server>/api`. Then re-run the Pages workflow.

How it works: whenever your medications or dose log change, the client works out the next 30 days of dose times and sends that list to the push server, keyed by a random per-device secret. The server sends each one when it's due. Opening the app refreshes the list. If the server can't be reached, the app shows reminders itself while it's open.

## Privacy

- **Guests:** medications and dose history are stored only in this browser (IndexedDB).
- **Google accounts:** data is also stored in Cloud Firestore in the `sign-in-for-med` Firebase project, under `users/{uid}/`, **end-to-end encrypted**: it's encrypted on the device before upload, so Google and the project's owners see only ciphertext. The security rules in [`firebase/firestore.rules`](firebase/firestore.rules) also let each signed-in account read and write only its own documents. Signing out removes the account's data from the device (see [Signing out](#signing-out)).
- The push server stores only the push subscription and upcoming reminder times and text for each device. With discreet mode on, the text is generic.
- Name lookups send the text you type to the public NLM (`clinicaltables.nlm.nih.gov`, `rxnav.nlm.nih.gov`) and openFDA (`api.fda.gov`) APIs. These are free, keyless public services. openFDA allows about 1,000 requests a day per IP without a key, and results are cached locally for 30 days.
- Exports are encrypted end to end. If you lose the passphrase, the file can't be recovered.

### Signing out

Account menu → **Sign out** first brings the cloud copy up to date: it uploads every change still queued on the device (including other tabs' changes and doses marked as taken from a notification) and waits until the server has confirmed them, not just until they're in Firestore's offline cache. Then the account's other open tabs stop editing, saving and syncing (they show the sign-in screen), anything they added at the last moment is uploaded the same way, and only then is the device's copy of the account removed (the same things as account deletion, step 2 below) and the app signed out of Google. If that last upload fails, nothing is removed and the other tabs come back.

If the cloud can't be brought up to date (offline, sync locked or not set up on the device, the cloud refused a change, or it doesn't confirm in time), nothing is removed. The app lists what isn't in the cloud and offers to stay signed in, try again, unlock, export a backup, or sign out anyway, which needs a second confirmation because it permanently deletes those changes. When nothing is waiting, signing out works offline too. Guests keep their data on the device when they go to the sign-in screen.

### Deleting an account

Account menu → **Delete account** (type `DELETE`, then confirm your Google account in a pop-up). It removes, in this order:

1. **The cloud copy:** every `meds` and `logs` document. First, `meta/crypto` is overwritten with a `{ v: 1, deleted: true, phase: 'deleting' }` marker: other devices pause, and the security rules refuse new data from then on. When everything is deleted, the marker becomes permanent (`done: true`; the rules don't let it be changed or removed). If the deletion fails partway, the encryption settings are put back; if the device doing it disappears, the next device that sees the marker after 15 minutes finishes the job.
2. **This device's copy:** local medications and dose history, queued uploads, the device's sync key, Firestore's offline cache, the session, scheduled reminders (and the push server's record for this device), notifications on screen, and the drug-information cache (it names the medications looked up). Device preferences, such as discreet notifications, aren't tied to an account and are kept.
3. **The sign-in account** in Firebase Authentication. Your Google account itself isn't affected. Signing in again later starts a fresh, empty account.

Other devices remove their copies and sign out when they next see the marker, including ones that were offline or closed at the time (the marker stays for good). If the sign-in account couldn't be removed, the next sign-in to it sees the marker and removes it. Other tabs in the same browser just pause while one tab deletes, and are cleared by it. For guests, **Delete all data** removes the guest data and reminders from this device.

### Cloud sync (Firestore)

- **Data layout:** `users/{uid}/meds/{medId}` holds one document per medication (`{ v, iv, ct, k }`, ciphertext only; `k` names the key it's encrypted with), or `{ v: 1, deleted: true }` once it's deleted (permanent, so a device that was offline can't bring it back). `users/{uid}/logs/{YYYY-MM}~{shard}` holds dose history, split by month and into up to 32 shards by medication (`{ logs: { [logId]: { v, iv, ct, k } }, w }`, where `w` lists the entries the last write changed so the rules can check each one). Each log is encrypted on its own, so a dose record is a small write. Monthly documents `logs/{YYYY-MM}` from older versions are moved into the shards automatically. `users/{uid}/meta/crypto` holds the wrapped data key.
- **How it works:** the device's local copy (IndexedDB, shared live between its tabs) is what the UI shows. Each edit queues the items it changed (`src/lib/syncOps.ts`) in `localStorage`, shared by the device's tabs, until the server acknowledges the upload; the upload encrypts the item's current local version (`src/lib/syncCrypto.ts`) and writes it through Firestore's IndexedDB offline cache. Cloud snapshots are decrypted (cached across launches) and combined with the local copy: medications merge field by field (the newer change of each field wins, so edits of different fields on two devices both survive), dose logs follow the cloud unless an upload of them is still queued, and the same dose logged on two devices keeps the newer action. Supply on hand is worked out from the last count and the doses taken since, so doses logged on two devices at once both count. The first time an account syncs on a device, local and cloud data are merged. Dose history is kept for a year.
- **Capacity:** with a year of history at two doses a day, the cloud allows about 1,100 medications (each log shard document stays under Firestore's 1 MiB limit) and the device's storage is limited only by the browser's IndexedDB quota. Tested with 500 medications and 365,000 dose records: loads in under a second and a tap takes about 90 ms on a laptop (phones are slower).

### End-to-end encryption

- **Keys.** Each account has one random AES-256-GCM data key. It's stored in `meta/crypto` only *wrapped* (encrypted) twice: with a key derived from your **sync passphrase** (PBKDF2-SHA-256, 600,000 iterations, random salt) and with a key derived from a random 128-bit **recovery key** (HKDF-SHA-256), shown once as 7 groups of 4 characters with a built-in typo check. Each wrapping has a key-check value, so a wrong passphrase is reported as such and not as damaged data. The recovery key is also kept in `meta/crypto` encrypted with the data key, so an unlocked device can show it again.
- **Passphrase strength.** A new passphrase (sync or export) is rated with [zxcvbn](https://github.com/zxcvbn-ts/zxcvbn), plus checks for what it misses: one word with counters or endings (`dog1 dog2 dog3`), words in alphabetical order, keyboard walks, interleaved runs (`a1b2c3`), leetspeak words (`P@ssw0rd`) and short strings. "Very weak" ones are refused. The checker and its dictionaries (about 1.7 MB, 850 kB compressed) are a separate file fetched when you start typing a passphrase, so without a connection a new passphrase can't be set (Retry shows). Unlocking and importing are never held up by it.
- **Documents.** Every medication and dose log is AES-GCM encrypted with a fresh IV. The ciphertext is bound (as additional authenticated data) to your uid, the collection, and the document ID (medications) or log document ID and log ID (dose logs), so ciphertext can't be swapped between documents or accounts. Medications are gzip-compressed and padded to 512-byte steps; every dose log pads to the same size, so its status doesn't show in its length. The old plaintext `updatedAt` field is gone: the timestamp is inside the ciphertext.
- **On each device.** After Google sign-in you set up encryption (first device) or unlock (other devices) once. The unwrapped key is kept only as a non-extractable `CryptoKey` in IndexedDB (`medtracker-keys`): the app can use it, but its bytes can't be read out. Nothing is read from or written to `meds`/`logs` before that.
- **Locked devices.** Once an account uses encryption, its medications and dose history open on a device only after it's unlocked there. Until then the app shows only the unlock screen (and sign-out): it doesn't load the data, show it, accept edits, export it, or schedule reminders from it. While the app checks whether a signed-in account uses encryption it shows nothing either. The device remembers the answer (`medtracker.e2ee.<uid>`), so an unencrypted account still opens offline and an encrypted one never opens unlocked just because the cloud can't be reached. A device with a stored key unlocks by itself, offline too. Forgetting the key, or the Google session ending outside the app (expired or revoked), locks the device: reminders stop (here and on the push server), notifications on screen close, cached drug lookups are dropped, and the device's copy is encrypted with the account key and the readable copy removed. Edits not uploaded yet are kept in that encrypted copy and still upload after unlocking, and "Mark as taken" taps from notifications wait until then too. A locked device with a readable copy and no key to encrypt it with (e.g. locked before this was added) removes that copy if the cloud has all of it, and otherwise keeps it unshown until unlocked. When the account key is reset on another device, this device keeps its copy unshown until it's unlocked with the new key, so it can be merged into the new cloud copy.
- **Settings** (account menu → **Cloud encryption**): change the passphrase (re-wraps the key only; other unlocked devices stay unlocked), show or replace the recovery key, forget the key on this device, or, when locked, start over (deletes the cloud copy and re-uploads this device's data with new keys).
- **Migration.** Data synced before encryption is re-uploaded encrypted, overwriting the plaintext in place, on the first unlock. It's resumable: anything still plaintext in a later snapshot is picked up again. Cloud items that fail to decrypt (tampered or damaged) are skipped, counted in the account menu, and never delete this device's copy.
- **Limits.**
  - If you lose **both** the passphrase and the recovery key, the cloud copy can't be decrypted by anyone. Data on your devices is kept, and you can start over from one of them.
  - Firestore still sees metadata: how many medication documents and log documents exist, random medication and log IDs, month names and shard numbers, which medications are deleted, write times, and approximate sizes (rounded up by padding).
  - The app code served from GitHub Pages is trusted. Whoever controls this repo or its Pages deployment could ship code that reads your key or data on your device.
  - iPhone: Safari and the Home Screen app have separate storage, so each needs unlocking once. If Safari clears the site's data, you'll be asked to unlock again.
  - An outdated copy of the app left open in a tab could still upload a dose log in plaintext to an old monthly document (the rules reject plaintext medications and plaintext in shard documents). It's re-encrypted and moved at the next sync.
- **Rules:** they allow `meds`, `logs` and `meta` for the owner only; accept medications only encrypted (or as a final deletion marker); check every dose log written to a shard document is encrypted; refuse new data once an account is being deleted; and keep a finished deletion marker for good. They were tested in the Firestore emulator. Publish them before deploying a version of the app that writes shard documents. To change them, edit [`firebase/firestore.rules`](firebase/firestore.rules) and publish it in **Firebase console → Firestore → Rules** (or with `npx firebase-tools deploy --only firestore:rules --project sign-in-for-med`).
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
