# CMU Database — Android app

Offline-first mobile app for the Chemical Management Unit, EPA Liberia (ERRS Department).
Officers record importers, chemicals, permits, consignments and inspections on their phones —
with GPS and photos — and the app syncs with a central Google Sheet when there is network.

**What's inside**

| Folder / file | What it is |
| --- | --- |
| `src/` | The app (React). `schema.js` defines every table and field — edit it to add fields. |
| `apps-script/Code.gs` | The sync server. Paste it into the CMU Google Sheet's Apps Script editor. |
| `android/` | The Android project (Capacitor). |
| `.github/workflows/build-android.yml` | Builds the APK on GitHub automatically. |

**Features:** sign-in with staff ID + PIN · roles (admin, officer, director = read-only) ·
works fully offline · auto-sync when the network returns · conflict protection (an older
copy can never overwrite a newer one) · duplicate warnings (same company name, reg. no.,
CAS no., permit no., bill of lading) · GPS capture with accuracy · inspection photos
uploaded to Google Drive · permit-expiry and follow-up alerts · CSV export/share
(WhatsApp, email, Drive) · server-side Audit Log of every change.

---

## Step 1 — Set up the Google Sheet server (15 minutes)

1. Create a **new** Google Sheet called `CMU Mobile Database` (using a new sheet avoids clashing with your existing CMU sheets).
2. **Extensions → Apps Script.** Delete the sample code, paste all of `apps-script/Code.gs`, click **Save**.
3. Choose the function **`setup`** in the toolbar and click **Run**. Approve the permissions (Advanced → Go to project).
   This creates the sheets *Importers, Chemicals, Permits, Consignments, Inspections, Users, Photos, Audit Log*
   and a Drive folder *CMU Inspection Photos*.
4. Open the **Users** sheet. Change the `ADMIN01` PIN, then add one row per staff member:

   | staff_id | name | role | pin | active |
   | --- | --- | --- | --- | --- |
   | CMU001 | Mary Kollie | officer | 4821 | TRUE |
   | DIR001 | ERRS Director | director | 7310 | TRUE |

   Leave `token` and `last_login` empty — the server fills them. Set `active` to FALSE to block a lost phone instantly.
5. **Deploy → New deployment →** gear icon **Web app**. *Execute as:* **Me**. *Who has access:* **Anyone**. Click **Deploy**.
6. Copy the **Web app URL** (ends in `/exec`). Staff paste this on the app's sign-in screen.
   Open it in a browser once: you should see `{"ok":true,"service":"CMU Database API",...}`.

When you change `Code.gs` later, use **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**.
That keeps the same URL. (A *new* deployment makes a new URL and breaks installed phones.)

## Step 2 — Build the APK on GitHub (no Android Studio needed)

1. Create a free account at [github.com](https://github.com) and click **New repository** → name `cmu-mobile` → **Private** → Create.
2. On the empty repository page click **uploading an existing file**. Unzip `cmu-mobile.zip` on your computer,
   open the `cmu-mobile` folder, select **everything inside it** (including the hidden `.github` folder —
   on Windows enable *View → Hidden items*; on Mac press `Cmd+Shift+.`) and drag it into the page. Click **Commit changes**.
   *(If drag-and-drop skips `.github`, create the file manually: Add file → Create new file → name it
   `.github/workflows/build-android.yml` and paste the content.)*
3. Open the **Actions** tab. The *Build Android APK* run starts automatically (≈ 6–10 minutes).
   If nothing runs, click *Build Android APK → Run workflow*.
4. When it shows a green tick, open the run and download **CMU-Database-APK** under *Artifacts*. Unzip it to get
   `CMU-Database-1.0.N-test.apk`.

Every time you upload changed files, a new APK is built with a higher version number, and it installs over the old one.

## Step 3 — Install on staff phones

1. Send the APK via WhatsApp, Google Drive or USB.
2. On the phone, tap the file → allow **Install unknown apps** for that app (WhatsApp/Files/Drive) → **Install**.
3. Open **CMU Database**, paste the server URL, enter staff ID and PIN.
4. Allow **Location** and **Camera** when asked (needed for inspections).

The *Offline only* option lets someone try the app without the server; they can connect later in Settings
and their records upload on the first sync.

## Step 4 (before full rollout) — Permanent release key

Test APKs are signed with a test key that is stored in this repository. For the final version, create a private
release key once and keep it safe — **if it is lost, phones can't receive updates**.

1. Install [Java (Temurin 21)](https://adoptium.net) and run (choose your own passwords):

   ```bash
   keytool -genkeypair -v -keystore cmu-release.jks -alias cmu -keyalg RSA -keysize 2048 -validity 10000
   ```
2. Convert it to text: Windows PowerShell `[Convert]::ToBase64String([IO.File]::ReadAllBytes("cmu-release.jks")) > key.txt`;
   Mac/Linux `base64 -i cmu-release.jks > key.txt`.
3. In GitHub: **Settings → Secrets and variables → Actions → New repository secret**, add:
   `CMU_KEYSTORE_BASE64` (content of key.txt), `CMU_KEYSTORE_PASSWORD`, `CMU_KEY_ALIAS` (`cmu`), `CMU_KEY_PASSWORD`.
4. Re-run the workflow. You now get `CMU-Database-1.0.N.apk` (release) and an `.aab` for Google Play.
   Staff must uninstall the test version once before installing the release version (different key).

Back up `cmu-release.jks` and the passwords in two safe places.

## Changing the app

- **Add or change a field:** edit `src/schema.js` (and the matching list in `TABLES` at the top of `Code.gs`
  so `setup` creates the column; new fields also create their column automatically on first sync).
- **Run it in a browser while editing:** install [Node.js 22](https://nodejs.org), then `npm install` and `npm run dev`.
- **Build locally with Android Studio instead of GitHub:** `npm install`, `npm run android:sync`, `npx cap open android`, then *Run*.

## How sync works

- Every save goes to the phone's database first and into an *outbox*. Nothing is lost without network.
- Sync runs at app start, when the network comes back, and with the **Sync now** button.
- Each record carries a `version`. The server accepts a change only if it is newer than its copy; otherwise the
  server copy is kept and the officer is told. Every accepted change is written to the **Audit Log** sheet.
- Rows typed directly into the Google Sheet need an `id` (any unique text), `version` (1) and
  `server_updated_at` (e.g. `2026-10-07T10:00:00Z`) to reach the phones.
- Apps Script handles a CMU team of 10–30 phones comfortably. If the data grows very large, the same app can be
  pointed at a hosted database later.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| "Server did not return JSON" | URL must end in `/exec`; deployment access must be **Anyone**. |
| "Wrong staff ID or PIN" | Check the Users sheet; `active` must be TRUE. |
| "Session expired" | The token was reset or the user disabled — sign out and sign in again. |
| GitHub run fails | Open the failed step's log; most often a file (e.g. `package-lock.json` or `.github/…`) was not uploaded. |
| "App not installed" on update | The new APK was signed with a different key — uninstall once, then install. |
| GPS slow or inaccurate | Step outside, wait for the accuracy figure to drop below ~20 m, tap *Re-capture*. |
