# Firebase Setup for Ma Ngal Lay

**Status: configured and live.**

- Firebase project: `ma-ngal-lay-shop-2026`
- Firestore database: `(default)`, Firestore Native
- Web app: `ministore`
- Rules: deployed from `firestore.rules`
- Config: filled in `firebase-config.js`

## Live URLs

| Host | URL | Notes |
| --- | --- | --- |
| **GitHub Pages** | https://thantzinwine.github.io/ma-ngal-lay/ | **Recommended.** Works on networks that block Firebase Hosting. |
| Firebase Hosting | https://ma-ngal-lay-shop-2026.web.app | Same app and same data. Currently times out on this PC's network. |

Both URLs share the same Firestore data, so a product added on one is visible on
the other. Either URL can be installed as a PWA: open it in Chrome → menu →
**Add to Home screen**.

> **Why two hosts?** The current network cannot reach Firebase Hosting's IP
> (`199.36.158.100`), although the site itself is live. GitHub Pages is
> reachable, so it is the primary URL. The Firebase deployment still works on
> other networks.

## What is already done

1. Created the Firebase project `ma-ngal-lay-shop-2026`.
2. Created the Firestore database in `asia-southeast1` (Singapore).
3. Registered the web app `ministore` and copied its config into
   `firebase-config.js`.
4. Published `firestore.rules` (only `products`, `sales`, `changes` are
   accessible).
5. Deployed the site to Firebase Hosting.
6. Published a copy to GitHub Pages and verified real cross-device sync.

No further Firebase console work is required.

## Day-to-day use

- Open either live URL on the shop phone and PC.
- On first connect, local products/sales/changes are uploaded to Firestore if
  the cloud copy is empty.
- Every add/edit/delete, sale, and change-log entry is saved to IndexedDB
  first, then synced to Firestore.
- Offline use is fully supported. Pending writes are queued and sent when the
  connection returns.
- Use **Settings → Backup & Restore** for a JSON backup before big changes.

## Updating the app

GitHub Pages (primary host) rebuilds automatically from `main`:

```powershell
cd D:\majortest\minimart2
git add .
git commit -m "Describe the change"
git push
```

Firebase Hosting (optional, for other networks):

```powershell
firebase deploy --only hosting
```

After changing `sw.js`, bump `CACHE` in that file so installed clients fetch
the new assets.

## Firestore rules

The deployed rules allow read/write only on the three collections the app uses:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /products/{productId} { allow read, write: if true; }
    match /sales/{saleId}       { allow read, write: if true; }
    match /changes/{changeId}   { allow read, write: if true; }
    match /{document=**}       { allow read, write: if false; }
  }
}
```

Redeploy after editing `firestore.rules`:

```powershell
firebase deploy --only firestore:rules
```

## Security note

These rules allow anyone who has the site URL to read and write the shop data.
That is acceptable for a small trusted shop, but:

- Keep the live URL private; do not post it publicly.
- Do not store sensitive customer information in this project.
- For stronger protection, add Firebase Authentication (anonymous or email)
  and change the rules to require `request.auth != null`.
- The Firebase web config (API key, project ID) is public by design. Access is
  controlled by the rules, not by hiding the config.

## Rebuilding from scratch (reference)

Only needed if the Firebase project is ever deleted.

1. Create a project at https://console.firebase.google.com/.
2. **Build → Firestore Database → Create database**.
   Choose a permanent location (for Myanmar, `asia-southeast1`).
3. **Project settings → Your apps → Web `</>`**, register the app, and copy the
   `firebaseConfig` values into `firebase-config.js`.
4. Publish the rules with `firebase deploy --only firestore:rules`.
5. Deploy with `firebase deploy --only hosting`.
6. Commit and push to `main` for the GitHub Pages copy.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Dot stays grey / "Local only" | `firebase-config.js` is missing or invalid. |
| Dot is red / "Sync blocked by Firestore rules" | Run `firebase deploy --only firestore:rules`, then reload. |
| "Firebase sync error" | Check the connection; local data is safe. Reload to reconnect. |
| GitHub Pages shows an old version | Wait for the Pages build, then hard-reload. The service worker may serve a cached copy until `CACHE` is bumped. |
| Firebase Hosting URL times out | Use the GitHub Pages URL instead. |
| Barcode scan or image search fails | Those libraries load from a CDN, so the first use needs a connection. |
| Data appears twice | Export a backup, clear site data, then import the backup. |

## Free tier

Firestore Spark plan: 50,000 reads/day, 20,000 writes/day, 1 GB stored. More
than enough for a small shop. There are no automatic charges on Spark.
