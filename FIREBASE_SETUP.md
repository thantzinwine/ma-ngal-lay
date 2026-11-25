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
4. Published `firestore.rules` for multi-shop data: each shop reads/writes only
   `shops/{shopId}/…`; the old single-shop collections remain only for the
   legacy owner migration.
5. Enabled Firebase Authentication (Email/Password). New shops can sign up;
   the original owner account still has the `owner: true` claim for migration.
6. Deployed the site to Firebase Hosting.
7. Published a copy to GitHub Pages and verified real cross-device sync.
8. Vendored the Firebase Auth/Firestore SDK under `vendor/firebase/` so the
   owner app can start offline without loading the SDK from Google's CDN.

The owner login, Firestore rules and the public customer page are already
configured. No further Firebase console work is required.

## Accounts, shops and the public page

| Page | URL | Who uses it |
| --- | --- | --- |
| Shop manager | `https://thantzinwine.github.io/ma-ngal-lay/` | Shop owners. Shows sign-in until the account logs in. |
| Public shop page | `https://thantzinwine.github.io/ma-ngal-lay/shop.html?shop=<slug>` | Customers. Shows that shop's catalog and verifies one voucher at a time. |

- **New shops** tap **Create an account**, then name the shop and choose a
  public slug (for example `my-shop`). Every shop gets its own data under
  `shops/{shopId}/…` and its own public link.
- **One owner account per shop.** The account email/password is the owner login.
- The old single-shop owner account keeps the `owner: true` claim, but only so
  it can copy its existing data into a new shop. That claim can be removed from
  Firebase Auth once the migration is finished.
- The public page never reads `products`, `sales`, `changes` or `costs`. It
  reads `shops/{shopId}/public/info`, a sanitized `shops/{shopId}/catalog`
  collection (no stock quantities and no stock value) and individual
  `shops/{shopId}/vouchers/{code}` documents.
- Customers can verify a voucher by scanning its QR code with the camera or by
  typing the code. Both methods check the same voucher document.
- New voucher QRs open `shop.html?shop=<slug>#voucher=CODE`.
- Customers cannot list vouchers: rules allow a single `get` by code but deny
  `list`.
- If an owner forgets the password, use **Forgot password?** on the login
  screen. The reset email works because `thantzinwine.github.io` is in the
  Firebase Auth authorized domains list.
- `shopSlugs/{slug}` maps the public slug to a shop id. It is public read.

## Day-to-day use

- Open either live URL on the shop phone and PC.
- On first connect, local products/sales/changes/costs are uploaded to
  Firestore if the cloud copy is empty.
- Every add/edit/delete, sale, cost and change-log entry is saved to IndexedDB
  first, then synced to Firestore.
- Offline use is fully supported. Pending writes are queued and sent when the
  connection returns.
- The app can run offline all day. Sign in online once on each device; after
  that, reopening the app offline works because the login session and app files
  are cached on the device.
- Use **Settings → Cloud sync** to control syncing:
  - **Pause cloud sync** stops Firestore uploads and detaches the listeners on
    this device. Changes stay in the local outbox.
  - **Sync now** (or **Resume & sync now** when paused) reconnects, uploads the
    outbox, restarts the listeners and records the last sync time.
- Pause is **per device** and survives a reload. If the same owner account is
  signed in on a PC or a second phone, pause those devices too.
- The app must be open to sync. Reconnecting the phone in the evening is not
  enough; open the app and tap **Sync now**. There is no background sync while
  the app is closed.
- Vouchers created while offline or paused exist on the device immediately, but
  the public verification page can verify them only after the device syncs. If a
  customer needs to verify a voucher right away, connect once before handing it
  over.
- Do not sign out or clear the browser/site data while offline — signing in
  again needs an internet connection, and clearing site data can delete
  unsynced changes.
- Use **Settings → Backup & Restore** for a JSON backup before big changes.
- **History → 🧾 Costs** records stock purchases, the electric meter bill, gas
  bill and other expenses with a date. The same tab shows costs and real
  revenue (sales − costs) for today, this week, this month and all time.

### Sync status

| Status | Meaning |
| --- | --- |
| Green dot / "Synced with Firebase" | All four owner collections have a server snapshot on this device |
| Blue dot / connecting | Starting, uploading or waiting for Firestore |
| Amber dot / offline or limit reached | Local data is safe; sync will retry |
| Violet dot / paused | This device is not syncing until you tap **Sync now** |
| Red dot / sync blocked | Usually Firestore rules; redeploy `firestore.rules` and reload |

## Owner controls and history removal

Owner-only history actions live in **Settings**:

1. Sign in with the owner email and password. The app stays locked behind the
   sign-in screen until the owner account is authenticated.
2. Optionally set a 4–12 digit local owner PIN as an extra gate for history
   removal. It locks again after 10 minutes of inactivity and on reload.
3. In **History → Sales**, delete a sale with the 🗑️ button. Removing a sale
   also adds the sold quantities back to tracked stock and writes an audit entry
   to the change log.
4. **Clear all sales history** removes every sale and its public voucher without
   restoring stock. **Clear change log** removes old audit entries and leaves
   one entry recording the clear.

Removals sync to every device through Firestore, so they cannot be undone
without a backup. Export a backup first.

The owner password lives in Firebase Authentication. The optional PIN is stored
only on the device where it was set (PBKDF2-SHA256 hash in local storage) and is
a convenience lock for staff, not the main access control. The main access
control is the Firebase Auth login plus the `owner: true` claim in the rules.

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

The deployed rules give each shop owner full access to their own shop and the
public page read-only access to that shop's sanitized collections:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function signedIn() { return request.auth != null; }

    function isShopOwner(shopId) {
      return signedIn()
        && get(/databases/$(database)/documents/shops/$(shopId)).data.ownerUid == request.auth.uid;
    }

    function isLegacyOwner() {
      return signedIn() && request.auth.token.owner == true;
    }

    match /users/{uid} {
      allow read, write: if signedIn() && request.auth.uid == uid;
    }

    match /shopSlugs/{slug} {
      allow read: if true;
      allow create: if signedIn()
        && request.resource.data.ownerUid == request.auth.uid
        && getAfter(/databases/$(database)/documents/shops/$(request.resource.data.shopId)).data.ownerUid == request.auth.uid;
      allow update, delete: if signedIn()
        && get(/databases/$(database)/documents/shopSlugs/$(slug)).data.ownerUid == request.auth.uid;
    }

    match /shops/{shopId} {
      allow get: if isShopOwner(shopId);
      allow create: if signedIn() && request.resource.data.ownerUid == request.auth.uid;
      allow update, delete: if isShopOwner(shopId);

      match /products/{id}  { allow read, write: if isShopOwner(shopId); }
      match /sales/{id}     { allow read, write: if isShopOwner(shopId); }
      match /changes/{id}   { allow read, write: if isShopOwner(shopId); }
      match /costs/{id}     { allow read, write: if isShopOwner(shopId); }
      match /publicMeta/{id} { allow read, write: if isShopOwner(shopId); }
      match /catalog/{id}   { allow read: if true; allow write: if isShopOwner(shopId); }
      match /public/{id}    { allow get: if true; allow write: if isShopOwner(shopId); }
      match /vouchers/{code} {
        allow get: if true;
        allow list: if isShopOwner(shopId);
        allow write: if isShopOwner(shopId);
      }
    }

    // Temporary legacy access for the original single-shop data.
    match /products/{id} { allow read, write: if isLegacyOwner(); }
    match /sales/{id}    { allow read, write: if isLegacyOwner(); }
    match /changes/{id}  { allow read, write: if isLegacyOwner(); }
    match /costs/{id}    { allow read, write: if isLegacyOwner(); }
    match /catalog/{id}  { allow read: if true; allow write: if isLegacyOwner(); }
    match /vouchers/{code} {
      allow get: if true;
      allow list, write: if isLegacyOwner();
    }

    match /{document=**} { allow read, write: if false; }
  }
}
```

Redeploy after editing `firestore.rules`:

```powershell
firebase deploy --only firestore:rules
```

## Security notes

- Each shop's private collections live under `shops/{shopId}/…` and require the
  shop owner account (the account recorded in `shops/{shopId}.ownerUid`).
- A signed-in account that does not own a shop cannot read or change that
  shop's data. It can only create its own shop and its own `users/{uid}` row.
- `shops/{shopId}/catalog` and `shops/{shopId}/public/info` are public read:
  they contain product name, category, price, photo and availability only.
  Stock quantities are never written there.
- `shops/{shopId}/vouchers/{code}` contains the code, date, items and total for
  one purchase. Anyone with the code can fetch that single document; nobody
  can list all vouchers. Voucher codes are random and were not designed to be
  secret, so treat the public verification page as a convenience check, not as
  proof of payment.
- The original single-shop data is readable only by the legacy owner claim, so
  the old app keeps working until its data is migrated.
- The owner app can sign a voucher with an HMAC key stored on that device. The
  public page does **not** verify this signature; it only checks that the
  voucher document exists. Vouchers are also not marked as redeemed,
  so a copied QR/code can be checked repeatedly.
- The Firebase web config (API key, project ID) is public by design. Access is
  controlled by Authentication and the rules.
- Do not store customer names, phone numbers or other sensitive data in this
  project.

## Testing with the Firebase emulators

Use the emulators to test authentication, rules and the public page without
touching live shop data.

```powershell
firebase emulators:start --only auth,firestore --project ma-ngal-lay-shop-2026
```

The emulators listen on `127.0.0.1:9099` (Auth) and `127.0.0.1:8080`
(Firestore). The test harnesses in the temp folder serve a `firebase-config.js`
override containing `useEmulators: true`, which makes the app connect to these
local ports. The production config has no such flag, so the live site always
uses the real project.

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
| Login screen says "Could not start the login service" | Reload. The Auth SDK is bundled locally, but sign-in still needs to reach Google/Firebase. Check the connection or try another network. |
| "This account is not the shop owner" | Sign in with the owner email, not another account. The owner account has the `owner: true` custom claim. |
| "Wrong email or password" | Use **Forgot password?** on the login screen to reset the owner password by email. |
| Dot stays grey / "Local only" | `firebase-config.js` is missing or invalid. |
| Dot is red / "Sync blocked by Firestore rules" | Run `firebase deploy --only firestore:rules`, then reload. Also make sure you are signed in as the owner. |
| Public page says catalog unavailable | Check that Firestore rules allow public read on `catalog`, then reload. |
| Old QR code opens the login screen | It should redirect to `shop.html#voucher=...` automatically. If not, open `shop.html` and type the code. |
| "Firebase sync error" | Check the connection; local data is safe. Reload to reconnect. |
| "Firestore limit reached" | The free daily quota or the 1 GiB storage limit is full. Data is safe locally. Wait for the daily reset (around 1:30–2:30 PM Myanmar time), free storage, or upgrade to Blaze. Then tap **Sync now**. |
| Sync dot is violet / "Sync paused" | This device is paused. Open **Settings → Cloud sync** and tap **Resume & sync now**. Other devices may still be syncing. |
| **Sync now** does nothing | It needs internet. Reconnect first; the button stays paused if the phone is offline. |
| New voucher cannot be verified | The device has not synced the public `vouchers/{code}` document yet. Connect and tap **Sync now**; vouchers created while paused are not public until then. |
| GitHub Pages shows an old version | Wait for the Pages build, then hard-reload. The service worker may serve a cached copy until `CACHE` is bumped. |
| Firebase Hosting URL times out | Use the GitHub Pages URL instead. |
| Barcode or voucher QR scan fails | Barcode and QR scanning use bundled libraries and work offline, but need camera permission. Image search is the part that needs internet: TensorFlow.js/MobileNet load from jsDelivr. |
| Data appears twice | Export a backup, clear site data, then import the backup. |

## Free tier and limits

Firestore Spark plan, project-wide and shared by the owner app and public page:

| Resource | Free quota |
| --- | --- |
| Stored data | 1 GiB |
| Document reads | 50,000 / day |
| Document writes | 20,000 / day |
| Document deletes | 20,000 / day |
| Outbound transfer | 10 GiB / month |

Daily Firestore quotas reset around **midnight Pacific Time** — roughly
**1:30 PM Myanmar time during US daylight saving**, otherwise about **2:30 PM**.
They do not reset at Myanmar midnight.

When a quota is full, Firestore does **not** delete data. Requests fail with
`resource-exhausted`; the app keeps working locally and keeps writes in the
outbox. The public catalog or voucher verification may be unavailable until the
quota resets. The 1 GiB storage cap blocks new writes but generally still allows
reads.

Also relevant:

- Firebase Auth email/password is free, with a 3,000 daily-active-user limit and
  about 150 password-reset emails/day on Spark. For one owner this is not a
  practical limit.
- GitHub Pages has a 1 GiB site limit and a 100 GB/month soft bandwidth limit,
  and its policy says it is not intended for commercial/e-commerce sites. This
  site's runtime files are under 2 MB.
- A phone with no free storage can fail to save local data. Export backups.

For the full explanation, capacity estimates, upgrade notes and a recovery
checklist, see [PROJECT.md §7](PROJECT.md#7-free-tier-limits-and-what-happens-when-a-limit-is-full).

There are no automatic charges on Spark. Blaze is pay-as-you-go; budget alerts
notify you but do not stop spending.
