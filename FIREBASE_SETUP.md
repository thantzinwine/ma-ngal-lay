# Firebase Setup for Ma Ngal Lay

The app is local-first. It works completely offline and stores data in IndexedDB.
Firestore is optional and turns on **cross-device sync** for products, sales and
the product change log.

## 1. Create the Firebase project

1. Go to [Firebase Console](https://console.firebase.google.com/) and sign in.
2. Click **Create a project** (for example `ma-ngal-lay`).
3. Google Analytics is optional.

## 2. Enable Firestore

1. Open **Build → Firestore Database**.
2. Click **Create database**.
3. Choose a location close to the shop.
4. Start in **test mode** for now; the rules are published in step 5.

## 3. Get the web app config

1. Open **Project settings** (gear icon) → **General**.
2. Scroll to **Your apps** and click the web icon `</>`.
3. Register the app with a nickname such as `ma-ngal-lay-web`.
4. Copy the `firebaseConfig` values.

## 4. Add the config to the app

Open `firebase-config.js` and replace the placeholders:

```js
window.FIREBASE_CONFIG = {
  apiKey: "AIza...",
  authDomain: "ma-ngal-lay.firebaseapp.com",
  projectId: "ma-ngal-lay",
  storageBucket: "ma-ngal-lay.firebasestorage.app",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abcdef123456"
};
```

Reload the app. The small dot in the top-right corner turns green when sync is
connected. If the config is left as `PASTE_...`, the app stays in local-only mode
and never tries to contact Firebase.

> The Firebase web config is public by design; it is safe to ship in a web app.
> Firestore access is controlled by rules, not by hiding the config.

## 5. Publish the Firestore rules

The rules in this repo only allow the app's three collections and block
everything else:

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

Publish them either by pasting into **Firestore Database → Rules → Publish**, or
with the Firebase CLI:

```bash
firebase login
firebase use --add          # choose your project
firebase deploy --only firestore:rules
```

**Security note:** these rules allow anyone who can load the site to read/write
the shop data. That is acceptable for a small trusted shop, but do not store
sensitive information in this Firebase project.

## 6. Deploy the app (optional)

`firebase.json` is already configured to host this folder:

```bash
npm install -g firebase-tools
firebase login
firebase use --add
firebase deploy
```

The app will be served from `https://<project-id>.web.app/`.

## How sync works

- Every product add/edit/delete, sale, and change-log entry is written to
  IndexedDB first, then queued for Firestore.
- Firestore's persistent cache keeps the app usable offline. Pending writes are
  sent automatically when the connection returns.
- `outbox` in IndexedDB holds writes that could not be handed to Firestore yet
  (for example when the Firebase SDK could not load). It is flushed at startup.
- On the very first connection, local products/sales/changes are uploaded to an
  empty cloud store so existing shop data is not lost.
- Opening the app on another device shows the same products, sales and changes
  in real time.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Dot stays grey / "Local only" | The config in `firebase-config.js` still contains `PASTE_...` or is invalid. |
| Dot is red / "Sync blocked by Firestore rules" | Publish `firestore.rules` (step 5), then reload. |
| "Firebase sync error" | Check the internet connection; local data is safe. Reload to reconnect. |
| Image search or barcode scan fails | Those libraries load from a CDN, so the first use needs a connection. |
| Data appears twice | Export a backup, clear the site data, then import the backup. |

## Free tier

Spark plan: 50,000 reads/day, 20,000 writes/day, 1 GB stored. More than enough
for a small shop. There are no automatic charges on the Spark plan.
