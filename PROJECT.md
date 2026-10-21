# Ma Ngal Lay — Full Project Documentation

Last updated: 2026-10-22

This is the main technical and operational document for the Ma Ngal Lay mini
mart app. It covers what the app does, how the parts fit together, what happens
when Firebase or the host reaches a limit, the known drawbacks, and suggested
future work.

---

## 1. Project at a glance

| Item | Detail |
| --- | --- |
| Name | Ma Ngal Lay mini mart |
| Type | Private owner POS + public product/voucher page |
| Owner app | <https://thantzinwine.github.io/ma-ngal-lay/> |
| Public page | <https://thantzinwine.github.io/ma-ngal-lay/shop.html> |
| Repository | `thantzinwine/ma-ngal-lay`, branch `main` |
| Firebase project | `ma-ngal-lay-shop-2026` (Firestore Native, `asia-southeast1`) |
| Primary host | GitHub Pages |
| Optional host | Firebase Hosting (`https://ma-ngal-lay-shop-2026.web.app`) |
| Front end | Plain HTML, CSS and JavaScript. No build step. |
| Local database | IndexedDB (`ma-ngal-lay-app`, version 2) |
| Cloud | Firebase Authentication + Cloud Firestore |
| PWA | Service worker cache (`ma-ngal-lay-v15`), installable |
| Currency | Myanmar Kyat (MMK, shown as `K`) |

The app is designed for one shop owner and a small shop phone. It is not a
multi-staff ERP, a full accounting package, or an online ordering system.

---

## 2. Users, goals and non-goals

### Users

1. **Owner / shopkeeper**
   - Signs in with the Firebase owner account.
   - Manages products, sells items, records costs, checks revenue and prints
     vouchers.
   - Is the only role that can read or write the private Firestore collections.

2. **Customer**
   - Opens the public page without signing in.
   - Sees product names, categories, prices, photos and whether an item is
     available.
   - Verifies one voucher at a time by scanning its QR code or typing its code.
   - Never sees stock quantities, stock value, costs, sales history or change
     log.

### Goals

- Fast enough to use on a phone at the counter.
- Work all day without internet after the first online sign-in.
- Keep an accurate local copy so a weak connection never blocks a sale.
- Sync to the cloud when the owner chooses, including once-a-day usage.
- Publish a customer-safe price list without exposing shop secrets.
- Give customers a simple way to check that a printed voucher matches a real
  purchase.
- Show sales, costs and "real revenue" (sales minus recorded costs).

### Non-goals

- Online ordering, delivery, payment collection or customer accounts.
- Multi-shop or franchise management.
- Supplier purchase orders, batch/lot tracking or expiry-date management.
- Full double-entry accounting, tax reports or payroll.
- Staff accounts with different permissions.
- Cryptographic proof of payment to a third party.
- Offline access to the public customer page.

---

## 3. Feature guide

### 3.1 Products

- Add and edit products with:
  - name, category, price (MMK),
  - optional stock quantity,
  - optional photo,
  - optional barcode.
- Stock is optional:
  - blank = untracked; the item is always treated as available,
  - `0` = out of stock,
  - a number = tracked stock; sales reduce it and deleting a sale restores it.
- Product photos are resized/compressed in the browser before saving. The
  public catalog receives a copy of the photo, so the same image can exist twice
  in Firestore.
- Search works by text, barcode scan and image search.
  - Barcode/QR scanning uses the vendored `html5-qrcode` library and works
    offline.
  - Image search uses TensorFlow.js + MobileNet loaded from jsDelivr. It needs
    internet the first time and is not part of the offline core.
- Deleting a product removes it locally, removes its public catalog record, and
  writes a change-log entry.

### 3.2 Bill / point of sale

- Add products to the bill from the product grid.
- Quantities can be typed directly into the bill, not only tapped with `+`/`−`.
- Quantities are clamped to tracked stock; typing `0` removes the line.
- Checkout shows the total and an optional "amount received" field. If entered,
  the app calculates change and refuses an amount below the total.
- Completing a sale:
  1. creates a sale record with line items, total, count and timestamp,
  2. decrements tracked stock,
  3. creates a voucher code and HMAC signature,
  4. writes a change-log entry,
  5. updates the public catalog/voucher projection,
  6. saves everything locally first and queues cloud writes.
- A sale is not final until the owner confirms it in the checkout dialog.

### 3.3 Voucher and QR verification

- Each sale gets a code in this shape:

  ```text
  MNL-YYMMDD-XXXX-XXXX-XXXX-XXXX
  ```

  The four `XXXX` groups are random characters from a 32-character alphabet
  (about 80 bits of randomness). The date prefix makes the code easy to read.
- The QR code opens:

  ```text
  shop.html#voucher=CODE
  ```

  Older printed QRs that point to `index.html#voucher=CODE` are redirected to
  the public page.
- The owner app signs the voucher with HMAC-SHA-256. The signing key is generated
  on the device and stored in `localStorage`; it is not a customer-facing secret.
- The public page verifies a voucher by fetching exactly one
  `vouchers/{code}` document from Firestore. It does **not** verify the HMAC and
  does not know whether the voucher was already used.
- Public verification is therefore a convenience check that the voucher matches
  a purchase recorded by the shop. It is not proof of payment and it is not a
  one-time redemption system.

### 3.4 History, revenue and costs

- **Sales history** lists completed sales and their vouchers.
- Revenue summaries are calculated for today, this week, this month and all
  time, using the device's local calendar boundaries.
- **Change log** records product changes, sales, deletions and other shop
  activity. It is an operational log, not a tamper-proof audit trail.
- **Costs** records shop expenses:
  - stock/goods purchase,
  - electric meter bill,
  - gas bill,
  - rent,
  - transport,
  - other.
- Costs have a title, category, amount, date and optional note.
- **Real revenue** = recorded sales totals − recorded costs in the selected
  period. This is a cash-style shop figure, not gross profit:
  - stock purchases are counted when entered as a cost, not when the stock is
    sold,
  - there is no per-product cost price or margin,
  - refunds, discounts and unpaid credit are not modelled.
- Deleting a sale restores tracked stock and removes its public voucher.
- Clearing **all** sales history does **not** restore stock.
- History removal is protected by the optional owner PIN (when configured).

### 3.5 Settings and local owner PIN

- Owner account status, change password and sign-out.
- Cloud sync controls:
  - **Pause cloud sync**
  - **Sync now** / **Resume & sync now**
  - last successful sync time
  - current sync state and error text
- Optional local owner PIN:
  - 4–12 digits,
  - stored as a PBKDF2-SHA-256 hash,
  - locks after 10 minutes of inactivity and on reload,
  - gates destructive history actions, not the whole app.
- Backup and restore:
  - export all local products, sales, changes and costs as JSON,
  - import a backup to replace local data,
  - if cloud sync is paused, the restore stays local and is uploaded on the next
    **Sync now**.

### 3.6 Public page

- Product catalog with search and category filters.
- Shows name, category, price, photo and availability.
- Hides exact stock quantities and stock value.
- Voucher verification by camera QR scan or manual code entry, one at a time.
- Requires internet; Firestore responses are not cached for offline use.
- Does not expose costs, sales, changes, owner information or voucher lists.

### 3.7 PWA and printing

- The owner app and public page are installable PWAs.
- The service worker pre-caches the app shell, fonts, icons, vendored Firebase
  SDK, QR libraries and images.
- The core owner app works offline after the first online sign-in and first
  successful asset cache.
- Voucher printing uses the browser print dialog with a dedicated print layout.

---

## 4. Architecture

### 4.1 High-level shape

```text
Owner phone / PC
  ├─ IndexedDB (source of truth on the device)
  ├─ Outbox (pending cloud operations)
  ├─ Firebase Auth session
  └─ Firestore SDK
        │  (when online and not paused)
        ▼
  Cloud Firestore
    ├─ products, sales, changes, costs  (owner-only)
    ├─ catalog                           (public read)
    ├─ vouchers/{code}                   (single public get)
    └─ publicMeta                        (owner-only)

Customer phone
  └─ shop.html + public.js
        └─ reads catalog and one voucher at a time from Firestore
```

There is no custom backend server. Firebase Authentication and Firestore are
the backend. Static files are served by GitHub Pages (and optionally Firebase
Hosting).

### 4.2 Storage layers

| Layer | What it stores | Lifetime |
| --- | --- | --- |
| IndexedDB | Products, sales, changes, costs and the outbox | Until site data is cleared or the browser evicts it |
| `localStorage` | Small flags, last sync time, voucher HMAC key, owner PIN hash, cart | Until site data is cleared |
| Firestore | Shared cloud copy and public projections | Until deleted in the app/Firebase |
| Service worker cache | App shell and vendored assets | Until a new cache version activates |
| JSON backup | Manual full export | Wherever the owner saves it |

IndexedDB is the local source of truth. Firestore is the shared copy. The app
does not wait for Firestore to save a sale; it writes locally and queues the
cloud operation.

### 4.3 Local write path

1. A UI action validates input.
2. The record is normalized.
3. The record is written to the relevant IndexedDB store.
4. A matching outbox entry is added:
   - `set` with the full record,
   - `delete` for a deletion,
   - `clear` for "delete every document in a collection".
5. The UI re-renders immediately.
6. `scheduleFlush()` is called. If sync is ready, online and not paused, the
   outbox is sent to Firestore. If not, the entry waits.

Outbox entries are processed in sequence order. A successful Firestore write
removes that outbox entry. A failed write remains queued.

### 4.4 Cloud sync path

When the owner signs in online, `initFirebase()`:

1. loads the vendored Firebase modules,
2. initializes Firebase Auth and Firestore with persistent local cache,
3. if sync is paused, disables the Firestore network and stops there,
4. otherwise flushes the outbox,
5. starts real-time listeners for `products`, `sales`, `changes` and `costs`,
6. mirrors incoming snapshots into IndexedDB and the UI.

The first server snapshot for each collection triggers a one-time seed check.
If local data exists and the cloud collection is empty, the local records are
queued for upload so a new Firebase project does not lose the shop's data.

Each write to Firestore is a normal document write. There is no custom merge
protocol; the last write wins at document level.

### 4.5 Pause cloud sync / Sync now

Pausing is a **per-device** setting stored in `localStorage` as `syncPaused`.

**Pause cloud sync**

1. Set `syncPaused = true` on this device.
2. Save the flag so it survives reloads.
3. Detach all Firestore listeners.
4. Clear the in-memory snapshot metadata.
5. Call Firestore `disableNetwork(db)`.
6. Keep the outbox intact. New sales, costs, product edits and public
   catalog/voucher changes are still saved locally and queued.
7. Show "Sync paused — changes stay on this phone until you tap Sync now."

**Sync now / Resume & sync now**

1. Require internet. If offline, the app refuses and stays paused.
2. Clear `syncPaused`.
3. Call Firestore `enableNetwork(db)`.
4. If a backup restore is pending, replay the full local data to the cloud.
   Otherwise, flush the outbox.
5. Restart the Firestore listeners.
6. Wait until all four owner collections have a server snapshot.
7. Save `lastSyncAt` and show "Synced with Firebase".

Important details:

- Pausing one device does not pause another device signed into the same owner
  account. The other device can still upload its own changes.
- An in-flight Firestore write may finish just as pause is pressed. The outbox
  still guarantees that anything not acknowledged stays queued.
- Pausing does not stop Firebase Auth from refreshing its login token. That is a
  small amount of network traffic compared with Firestore sync.
- The public page is not affected by the owner's pause setting; it reads
  whatever is already in Firestore. If the owner has not synced yet, customers
  cannot see the new catalog items or vouchers.
- If the app is closed while offline or paused, queued changes do not upload in
  the background. Open the app and use **Sync now** when internet is available.

### 4.6 Offline cold start and login fallback

- The first sign-in on each device must be online.
- Later, the Firebase Auth session is restored from local storage.
- If the saved session token has expired and the device is offline, the app has
  an owner fallback that checks the previously stored owner UID. This allows the
  shop to open offline instead of being locked out.
- Firestore uses persistent local cache so previously mirrored documents are
  available offline.
- Local data and the outbox remain usable even if Firebase cannot be reached.
- Signing out or clearing site data while offline removes the local session and
  can make it impossible to sign in until internet returns.

### 4.7 Public data projection

The public page never reads the private collections. Instead, the owner app
maintains sanitized copies:

- `catalog/{productId}`:
  `name`, `category`, `price`, `photo`, `available`, `updatedAt`.
  No stock quantity, stock value or cost.
- `vouchers/{code}`:
  `code`, `createdAt`, `total`, `count`, `items`, and optional `paid`/`change`.
  No customer identity and no HMAC signature.
- `publicMeta`: a version marker used to trigger a one-time public-data rebuild
  when the projection format changes.

When a product, stock level, sale or voucher changes, the app diffs the public
projection and queues only the changed records. This keeps public writes small.

### 4.8 PWA and service worker

- `sw.js` pre-caches the app shell and vendored libraries.
- Navigation requests use network-first with a cached fallback.
- Static assets are cache-first with a background refresh.
- `firebase-config.js` is network-first so configuration changes take effect on
  the next reload.
- Cross-origin requests (Firebase network calls and the TensorFlow CDN) are not
  cached by the service worker.
- When changing app files, bump `CACHE` in `sw.js` (currently
  `ma-ngal-lay-v15`) before deploying.

### 4.9 Printing

- Vouchers are rendered as HTML and printed through the browser print dialog.
- The print layout includes the shop name, voucher code, QR code, line items,
  total, paid/change and timestamp.
- QR generation uses the vendored `qrcode` library and does not need a network.

---

## 5. Data model

### 5.1 IndexedDB stores

Database: `ma-ngal-lay-app`, version `2`.

| Store | Purpose | Key fields |
| --- | --- | --- |
| `products` | Owner product records | `id`, `name`, `category`, `price`, `stock`, `photo`, `barcode`, `createdAt`, `updatedAt` |
| `sales` | Completed sales | `id`, `items[]`, `total`, `count`, `createdAt`, `paid`, `change`, `voucherCode`, `voucherKeyId`, `voucherSig` |
| `changes` | History / audit log | `id`, `type`, `productId`, `name`, `detail`, `amount`, `createdAt` |
| `costs` | Shop expenses | `id`, `title`, `category`, `amount`, `date`, `note`, `createdAt`, `updatedAt` |
| `outbox` | Pending cloud operations | `id`, `seq`, `collection`, `docId`, `op`, `data`, `createdAt` |

Sale line items contain `productId`, `name`, `price` and `qty`. Keeping the name
and price on the sale means old receipts do not change when a product is edited
later.

### 5.2 Firestore collections

| Collection | Access | Contents |
| --- | --- | --- |
| `products` | Owner only | Full product records, including stock and photo |
| `sales` | Owner only | Full sale records and voucher signatures |
| `changes` | Owner only | Change-log entries |
| `costs` | Owner only | Cost records |
| `catalog` | Public read; owner write | Sanitized product cards |
| `vouchers` | Single public get by code; owner list/write | Public voucher details |
| `publicMeta` | Owner only | Public projection version |

The rules also deny every other document path.

### 5.3 Local metadata keys

All app metadata uses the `mnl-meta-` prefix in `localStorage`.

| Key | Meaning |
| --- | --- |
| `syncPaused` | `true` when this device is paused |
| `lastSyncAt` | ISO timestamp of the last successful full sync on this device |
| `fbSeeded` | Whether the one-time cloud seed check has run |
| `fbSeededProject` | Firebase project ID associated with the seed flag |
| `pendingCloudRestore` | A local backup restore still needs to be uploaded |
| `voucherHmacKey` | Per-device voucher signing key (base64/hex encoding) |
| `voucherHmacKeyId` | Short ID derived from the signing key |
| `ownerAuth` | Local owner PIN hash and settings |
| `ownerUid` | Previously authenticated owner UID for offline fallback |

The cart uses the separate `mnl-cart-v1` key.

### 5.4 Voucher format and signing

- Code: `MNL-YYMMDD-XXXX-XXXX-XXXX-XXXX`.
- Random alphabet: `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (ambiguous characters
  removed).
- HMAC payload includes the code, sale ID, timestamp, total, count, paid,
  change, key ID and line items.
- The signature and key ID are saved on the sale (owner-only), not in the public
  voucher.
- A new device generates its own key. Old vouchers can still be verified from
  their public `vouchers/{code}` document, but the local HMAC status may show
  "signed on another device" or "record only".

---

## 6. Security and privacy

### 6.1 Access control

- The owner app is gated by Firebase Authentication (email/password).
- The owner account has the custom claim `owner: true`.
- Firestore rules require that claim for all private collections.
- A signed-in account without the claim can authenticate but cannot read or
  write shop data.
- The public page can read `catalog` and can `get` a single voucher if it knows
  the code. It cannot list vouchers or read private collections.
- The Firebase web config is public by design. The API key identifies the
  project; it is not a server secret.

### 6.2 What the app protects

- Shop costs, sales history, stock quantities and stock value are not exposed to
  the public page.
- A normal Firebase user cannot access the owner data.
- The optional local PIN makes casual history deletion harder on a shared phone.
- Public voucher documents contain only the purchase details needed for
  verification.

### 6.3 What the app does not protect against

- A compromised owner device, malicious browser extension or someone who knows
  the owner password.
- A shared unlocked phone. Once the owner is signed in, the app data is visible;
  the PIN only gates destructive history actions.
- Data at rest on the device. IndexedDB and `localStorage` are not encrypted by
  this app.
- A public voucher code that has been photographed or shared. Verification does
  not mark a voucher as used, so the same voucher can be checked repeatedly.
- A malicious owner or tampered browser data. The change log is not
  cryptographically tamper-proof.
- Public catalog scraping or abusive traffic. There is no App Check, rate limit
  or bot protection.
- Third-party scripts used for image search (TensorFlow.js/MobileNet from
  jsDelivr). The core POS does not depend on them, but they are loaded on the
  owner page.

### 6.4 Privacy notes

- Do not store customer names, phone numbers, addresses or payment-card data in
  product names, notes or vouchers.
- The public catalog intentionally exposes product names, categories, prices,
  photos and availability.
- JSON backups can contain the full shop history and photos. Store them safely.

---

## 7. Free-tier limits and what happens when a limit is full

This is the part to read before relying on the free Firebase/GitHub setup.

### 7.1 Current free quotas

| Service | Free quota | Scope / reset |
| --- | --- | --- |
| Firestore stored data | 1 GiB | Per project; one free database |
| Firestore document reads | 50,000 per day | Project-wide; resets around midnight Pacific Time |
| Firestore document writes | 20,000 per day | Project-wide; resets around midnight Pacific Time |
| Firestore document deletes | 20,000 per day | Project-wide; resets around midnight Pacific Time |
| Firestore outbound transfer | 10 GiB per month | Project-wide; monthly |
| Firebase Auth email/password | Free | Spark plan |
| Firebase Auth daily active users | 3,000 per day | Identity Platform Spark limit |
| Password-reset emails | About 150 per day | Spark email limit |
| GitHub Pages site size | 1 GiB recommended | Source/site |
| GitHub Pages bandwidth | 100 GB per month, soft limit | Usage policy |
| GitHub Pages builds | 10 per hour, soft limit | Usage policy |
| Browser local storage | Browser-dependent | Device |

Firestore's daily quotas reset at **midnight Pacific Time**, which is roughly
**1:30 PM Myanmar time during US daylight saving** and **2:30 PM Myanmar time
otherwise**. It is not midnight in Myanmar.

Firebase's Spark plan has no automatic charges. If billing is not enabled,
usage over the free quota is blocked rather than charged.

### 7.2 What counts against the Firestore quota

- Opening the public catalog reads every document in `catalog` (currently one
  read per product). The public page does not cache Firestore responses.
- Verifying one voucher is one document read.
- Opening the owner app and starting listeners reads the existing documents in
  `products`, `sales`, `changes` and `costs`.
- Each product, sale, cost or change written is one write. Each public catalog
  or voucher update is another write.
- Each deletion is a delete, not a write. "Clear" operations delete documents
  one by one.
- Photos are stored as base64 strings inside documents, so they count toward the
  1 GiB stored-data quota and toward document reads/egress.

### 7.3 What happens when each limit is full

#### Daily reads exhausted

- Firestore read operations fail with `resource-exhausted` / "quota exceeded".
- The owner app can still open and read its local IndexedDB data.
- New local sales and edits still work and queue in the outbox.
- Owner listeners may stop updating; the sync status shows a Firebase error.
- The public catalog and voucher verification show "temporarily unavailable".
- Data is **not** deleted. Reads work again after the daily reset.

#### Daily writes exhausted

- Local saves still succeed on the phone.
- Cloud writes fail and remain in the outbox.
- Public catalog/voucher updates wait, so customers cannot verify brand-new
  vouchers until the write quota resets or the plan is upgraded.
- The owner app shows "Firestore limit reached — working offline" and keeps the
  data safe locally.
- Nothing is lost unless the local browser data is cleared before a successful
  sync.

#### Daily deletes exhausted

- Local deletion succeeds; the UI hides the record.
- The cloud deletion fails and stays queued.
- A deleted product or voucher may remain visible on the public page until the
  delete retries after the quota resets.
- Avoid bulk cleanup while the delete quota is exhausted.

#### 1 GiB stored data full

- New writes fail once Firestore cannot store more data.
- Reads generally continue, so the existing catalog and history remain visible.
- The owner app continues locally and queues writes.
- To recover:
  - delete old products or product photos,
  - remove old vouchers by deleting old sales carefully,
  - reduce photo size/quality,
  - export a backup and archive old data outside Firestore,
  - or upgrade to a paid plan with more storage.
- Photos are duplicated in `products` and `catalog`, so each product photo can
  consume roughly twice its file size.

#### 10 GiB monthly outbound transfer exhausted

- On the Spark plan, Firebase's monthly no-cost quota can shut off the affected
  product for the rest of the month.
- Firestore reads (including the public catalog and voucher verification) may
  fail until the next month or until billing is enabled.
- The owner app still works from local data.
- This is the quota most likely to be reached first if the public page has many
  visitors and large photos, because every catalog visit downloads all catalog
  photos.

#### Firebase Auth limits

- Email/password sign-in is free on Spark, but Identity Platform has a 3,000
  daily-active-user limit and email-sending limits.
- For one owner, this is effectively irrelevant.
- If a limit is reached, new sign-ins or password-reset emails can fail. An
  already signed-in device may continue offline.
- If the owner is locked out, use the Firebase console or another signed-in
  device; password reset needs access to the owner email.

#### GitHub Pages limits

- The site is far below the 1 GiB size limit (under 2 MB of runtime files).
- The 100 GB/month bandwidth limit is soft. At roughly 1.5–2 MB per uncached
  first load, that is tens of thousands of full loads per month.
- GitHub Pages policy says it is not intended for running an online business or
  e-commerce site. This app is a private shop tool plus a catalog with no online
  transactions, but the policy is still a business risk.
- If GitHub throttles or blocks the site, the installed PWA may keep working
  from cache, but new visitors cannot load it. Move to Cloudflare Pages, Firebase
  Hosting, Netlify or another host if the shop depends on it.

#### Device/browser storage full

- IndexedDB or `localStorage` writes can fail.
- A sale or edit may not be saved locally, which is more serious than a cloud
  quota failure.
- Export a JSON backup, delete old photos/data, and keep free space on the
  phone.
- Browsers can evict site data under storage pressure. Install the PWA and keep
  regular backups.

### 7.4 Does "full" delete data?

No. Firestore quota exhaustion does not delete stored data. It blocks the
operation. Data is only removed when:

- the owner deletes it in the app,
- the owner clears site data/browser storage,
- the browser evicts local storage,
- someone with console/API access deletes it.

The most realistic data-loss scenario is unsynced local data on a phone whose
site data is cleared, browser storage is evicted, or the phone is lost.

### 7.5 Capacity estimates for this shop

These are rough estimates, not guarantees.

| Resource | Estimate |
| --- | --- |
| Public catalog visits | With 8 products, the read quota allows about 6,250 catalog loads/day (8 reads each). |
| Public catalog egress | With 8 photos at 30–120 KB each, a visit downloads roughly 0.24–0.96 MB, so the 10 GiB/month egress cap allows roughly 350–1,400 visits/day. |
| Sales writes | A sale with tracked products can use about 5–9 writes (sale, voucher, change, product, catalog, etc.). 20,000/day is roughly 2,000–4,000 sales/day. |
| Storage | At 60–240 KB per product after photo duplication, 1 GiB is roughly 4,000–17,000 products before sales/vouchers and overhead. A small minimart is far below this. |
| Owner reads | Small. Opening one device reads the existing owner documents; each change reads only the changed documents. |
| Costs/history | Small text documents; not a meaningful share of storage. |

A typical day for this shop is far below the free limits. The limits become
relevant with heavy public traffic, very large photos, bulk imports/clears, or
many devices.

### 7.6 What to do when a limit is full

1. **Do not clear site data.** Export a JSON backup if the app still opens.
2. Tap **Pause cloud sync** to stop noisy retries on that device.
3. Check **Firebase Console → Firestore → Usage** to see which quota is full.
4. For daily reads/writes/deletes: wait for the reset (around 1:30–2:30 PM
   Myanmar time), then tap **Sync now**.
5. For storage full: delete old photos/products or archive old data, then sync.
6. For monthly egress or a hard monthly limit: wait for the next month or
   upgrade to Blaze.
7. For GitHub Pages problems: use Firebase Hosting (on a network that can reach
   it) or move to another static host.
8. If the shop cannot tolerate downtime, upgrade to Blaze and set budget alerts.
   Remember: Firebase budgets are alerts, not hard spending caps.

### 7.7 About upgrading to Blaze

- Blaze is pay-as-you-go. The free daily allowances still apply; you pay for
  usage above them.
- Typical overage prices in US pricing are on the order of:
  - reads: $0.03 per 100,000,
  - writes: $0.09 per 100,000,
  - deletes: $0.01 per 100,000,
  - storage: a few cents per GiB-month.
- Small-shop overage is usually cents, but prices vary by region and change over
  time. Check the current Firebase pricing page.
- A billing budget alert only sends a notification. It does not stop spending.
  Set alerts and review usage.
- Upgrading does not fix a bad sync design or a full device; it only removes the
  free-tier ceiling.

---

## 8. Known drawbacks and limitations

This section is intentionally honest. These are the things to understand before
treating the app as a complete business system.

### 8.1 Sync and offline limitations

1. **Pause is per device.**
   - Pausing the shop phone does not pause the PC or a second phone signed into
     the same owner account.
   - If the goal is "nothing syncs until evening", pause every device (or keep
     them offline).

2. **Sync requires the app to be open.**
   - There is no background sync when the app is closed.
   - Reconnecting the phone in the evening is not enough; open the app and tap
     **Sync now** (or let it auto-sync while open).

3. **Last-write-wins conflicts.**
   - Two devices editing the same product or selling the last units can
     overwrite each other at the document level.
   - There is no conflict prompt, merge UI or reservation system.
   - Offline stock is a local guess; two offline devices can oversell the same
     item.

4. **Deletions can reappear.**
   - If a device has stale local data or a pending write, it can re-create a
     record that another device deleted.
   - Public catalog/voucher deletions can lag when the delete quota is full.

5. **No automatic retry timer.**
   - The outbox is retried on app actions, reconnection, reload and **Sync now**.
   - After a quota reset, the app may sit idle until something triggers a sync.

6. **Local data is fragile.**
   - Clearing site data, uninstalling the PWA, browser eviction or losing the
     phone can remove unsynced changes.
   - Backups are manual.

7. **The public page is online-only.**
   - Customers cannot browse or verify vouchers without a connection to
     Firestore.

8. **The owner app is not a real-time multi-user POS.**
   - It is designed for one owner, not several cashiers working at the same
     second.

### 8.2 Security limitations

1. **One owner account, no MFA.**
   - Anyone with the owner email/password can read and change everything.
   - There are no staff accounts, roles or per-user audit identity.

2. **The local PIN is not encryption.**
   - It gates destructive history actions, not reading the app.
   - Someone with the unlocked phone/browser profile can read IndexedDB data.

3. **Voucher verification is not payment proof.**
   - The public page checks that a voucher document exists.
   - It does not mark the voucher used, check an expiration, or prove who paid.
   - A copied QR/code can be verified repeatedly.

4. **The HMAC signature is device-local.**
   - It provides tamper evidence on the device that created the voucher.
   - It is not published or independently verifiable by customers.
   - Clearing local data generates a new key; old vouchers still verify by
     document lookup but may show "other device" locally.

5. **No App Check or rate limiting.**
   - Someone can repeatedly load the public catalog and consume reads/egress.
   - Voucher codes have high entropy, but a leaked code is reusable.

6. **Third-party CDN dependency.**
   - Image search loads TensorFlow.js and MobileNet from jsDelivr without a
     local fallback; a CDN outage or supply-chain issue affects that feature.

### 8.3 Accounting limitations

1. **Real revenue is not gross profit.**
   - It subtracts recorded costs from sales, with no per-item cost of goods sold.
   - Stock purchases count when entered, not when the stock is sold.

2. **No refunds, discounts, partial payments, credit sales or payment methods.**
   - A mistake is corrected by deleting a sale, not by a proper return/refund
     flow.

3. **No supplier or purchase-order tracking.**
   - Costs are manual expense records.

4. **No low-stock automation.**
   - Stock is displayed, but there are no reorder alerts or automatic purchase
     suggestions.

5. **Clock/timezone dependence.**
   - Revenue periods and cost dates use the device's local calendar.
   - A wrong phone clock produces wrong reports.

6. **Clearing sales does not restore stock.**
   - This is deliberate but dangerous if the owner expects a full reset.

### 8.4 Hosting and limit limitations

1. **GitHub Pages policy.**
   - GitHub says Pages is not intended for commercial/e-commerce sites. The app
     is a shop tool with a public catalog; this is a policy risk, not just a
     technical one.

2. **Free quotas.**
   - Firestore daily/monthly limits can block customer verification and cloud
     updates.
   - There is no in-app quota meter; the owner sees an error only after a limit
     is hit.

3. **No monitoring or budget alerts configured.**
   - The owner must check the Firebase console manually.

4. **No custom domain.**
   - The site uses the GitHub Pages URL; changing hosts/domains requires updating
     Firebase Auth authorized domains.

### 8.5 Product and UX limitations

1. **Public page loads all catalog documents and photos.**
   - There is no pagination, lazy loading by network, or image CDN.
   - Large catalogs/photos make the page heavy and consume egress quickly.
   - It is client-rendered, so per-product SEO/social previews are weak.

2. **No offline public catalog.**
   - The customer page does not cache Firestore catalog data.

3. **Monolithic front end.**
   - `app.js` is a large vanilla JavaScript file with no build step, modules,
     type checking or automated test suite in the repository.
   - Changes rely on manual/live testing.

4. **Service worker update behavior.**
   - Static assets are cache-first with a background refresh.
   - After a deploy, an installed client may show the previous version for one
     load, and `CACHE` must be bumped manually.

5. **Accessibility and internationalization.**
   - The UI is English-first with Myanmar font support; there is no language
     toggle.
   - Some controls use emoji-only labels or rely on color/size.
   - Camera permission is required for QR scanning.

6. **Backups are manual and can be large.**
   - Photos are embedded in JSON; exporting after every busy day may be
     impractical.
   - Import replaces local data and can overwrite cloud data; use with care.

7. **Browser/iOS coverage is not formally tested.**
   - Chrome/Android is the primary target. Camera, storage limits and PWA
     behavior vary on iOS and other browsers.

### 8.6 Operational limitations

1. **Password reset depends on email access.**
   - If the owner loses access to the email account, recovery is harder.

2. **Change log is not tamper-proof.**
   - It records normal app actions but can be deleted by an owner with the PIN.

3. **Two hosts, one database.**
   - GitHub Pages and Firebase Hosting serve the same app/data. A deploy must be
     repeated for both if both are used.

4. **Manual rules deployment.**
   - `firestore.rules` is not deployed automatically by the GitHub Pages push.

---

## 9. Future improvements

### Priority 0 — protect the business and the data

1. **Automatic cloud backup**
   - Scheduled export of owner collections to a separate bucket/Drive.
   - Retention policy and a one-tap restore path.
   - This is the single highest-value reliability improvement.

2. **Quota monitoring and auto-pause**
   - Show Firestore usage in Settings.
   - Warn at 80% of reads/writes/storage/egress.
   - Automatically pause sync before a limit is hit; queue everything locally.

3. **Background sync / retry timer**
   - Retry the outbox periodically with exponential backoff when the app is
     open.
   - Investigate Background Sync where supported; a native wrapper may be needed
     for reliable closed-app sync.

4. **Conflict handling**
   - Per-record `updatedAt`/version checks.
   - Conflict prompt when a remote document changed while local changes are
     pending.
   - Stock reservations for multi-device selling.

5. **Cost of goods sold and profit**
   - Cost price per product/batch.
   - Gross margin per item and per sale.
   - Supplier purchases, stock intake and wastage.

6. **Refunds, discounts and payment methods**
   - Partial refunds and returns that restore stock correctly.
   - Discounts, credit sales and cash/transfer/other payment tracking.

7. **Voucher redemption**
   - `redeemedAt` / `redeemedBy` and a "mark used" action.
   - Expiration and one-time verification.
   - Server-side signing/public-key verification if customer-facing proof is
     required.

8. **Security hardening**
   - MFA/passkeys for the owner.
   - Firebase App Check.
   - Staff accounts with limited permissions and per-user audit identity.
   - Encrypted local storage or a device-level app lock.

### Priority 1 — scale and usability

9. **Move images out of Firestore**
   - Firebase Storage or another object store + CDN.
   - Thumbnails and responsive images.
   - This removes photo duplication and protects the 1 GiB Firestore quota.

10. **Public catalog improvements**
    - Pagination/lazy loading.
    - Server-side rendering or static generation for SEO.
    - Offline catalog cache and a graceful stale copy.
    - Custom domain.

11. **Better hosting**
    - Cloudflare Pages, Firebase Hosting (with a reachable network) or another
      static host that permits a business catalog.
    - Deploy rules and hosting from CI.

12. **Testing and CI**
    - Playwright end-to-end tests for sale, voucher, pause/resume and restore.
    - Firestore emulator + rules unit tests.
    - Lint/type checking (for example, TypeScript or JSDoc + `tsc --checkJs`).
    - Automated deploy workflow with cache-version checks.

13. **Modularize the front end**
    - Split `app.js` into modules for storage, sync, auth, POS, vouchers and
      public projection.
    - Keep the no-build PWA if desired, but make the boundaries explicit.

14. **Low-stock and purchasing**
    - Reorder thresholds and a shopping list.
    - Link costs to stock intake and supplier records.

### Priority 2 — polish and reach

15. **Internationalization and accessibility**
    - English/Myanmar UI toggle.
    - Screen-reader labels, focus management, larger tap targets, reduced
      reliance on color.

16. **Offline image search**
    - Vendor the TensorFlow model or remove the feature from the offline
      promise; make the network requirement explicit in the UI.

17. **Voucher/customer features**
    - Optional customer phone/name on the private sale only.
    - Shareable digital receipt.
    - "Already used" state and verification history.

18. **Multi-shop support**
    - Shop IDs, per-shop rules and separate public catalogs.

19. **Reporting and exports**
    - CSV/PDF sales and cost exports for accounting.
    - Daily/weekly/monthly summaries with profit and payment-method breakdown.

20. **Data retention**
    - Archive old sales/vouchers to cold storage.
    - Automatic pruning of photos and old public projections.

---

## 10. Operations runbook

### Daily

1. Open the owner app.
2. If the phone was offline during the day, reconnect and tap **Sync now**.
3. Check that the sync dot is green and the last-sync time is recent.
4. If a customer needs to verify a new voucher immediately, sync before handing
   it over.
5. If the shop wants no cloud traffic, tap **Pause cloud sync**; remember it is
   per device.

### Weekly

1. Export a JSON backup.
2. Open the public page and verify one recent voucher.
3. Check Firebase Console → Firestore → Usage.
4. Check the app's sync status and change log.
5. Confirm the owner PIN is set if the phone is shared.

### Before a risky change

1. Export a backup.
2. Test with the Firebase emulators or a separate Firebase project.
3. Bump `CACHE` in `sw.js` if any cached asset changed.
4. Deploy, hard-reload, and verify:
   - owner sign-in,
   - product add/edit,
   - sale + voucher,
   - public catalog and voucher verification,
   - pause → local change → reload → sync now.

### When quota is full

1. Export a backup if possible.
2. Pause sync.
3. Identify the exhausted quota in the Firebase console.
4. Wait for a daily reset or free space/upgrade for a hard limit.
5. Tap **Sync now** after the reset.
6. If public verification is critical, consider Blaze with budget alerts or a
   second project for the public catalog.

### Recovering a lost/replaced phone

1. Install the app on a new phone and sign in online.
2. Firestore restores the last synced data.
3. Any changes that existed only on the lost phone and were never synced are
   gone; restore them from the latest JSON backup if available.
4. Do not clear the old device remotely until you are sure its unsynced changes
   are not needed.

### Changing the owner password

1. Sign in as the owner.
2. Settings → Change password.
3. If locked out, use **Forgot password?** on the login screen; the owner email
   must be accessible.
4. After a password change, other devices may need to sign in again.

---

## 11. File map

| File | Role |
| --- | --- |
| `index.html` | Owner app shell and dialogs |
| `app.js` | Owner app logic: storage, sync, auth, POS, vouchers, costs, UI |
| `styles.css` | Owner app styles |
| `shop.html` | Public catalog/voucher page shell |
| `public.js` | Public catalog and voucher verification |
| `shop.css` | Public page styles |
| `sw.js` | Service worker and cache list |
| `manifest.json` | PWA manifest |
| `firebase-config.js` | Public Firebase web config |
| `firestore.rules` | Firestore security rules |
| `firebase.json` | Firebase Hosting/emulator configuration |
| `vendor/` | Vendored Firebase SDK, QR libraries |
| `fonts/` | Local Noto Sans Myanmar fonts |
| `icons/` | PWA icons |
| `image.png` | Shop logo |
| `README.md` | Short project overview |
| `FIREBASE_SETUP.md` | Firebase setup, deployment and troubleshooting |
| `PROJECT.md` | This document |

---

## 12. Glossary

| Term | Meaning |
| --- | --- |
| IndexedDB | Browser database used as the local source of truth |
| Outbox | Queue of local operations waiting to be written to Firestore |
| Projection | Sanitized public copy of products/vouchers |
| Pause | Per-device setting that stops Firestore network sync |
| Sync now | Manual resume + outbox flush + listener restart |
| Last sync | Last time all owner collections had a server snapshot on this device |
| Spark | Firebase's no-cost plan |
| Blaze | Firebase's pay-as-you-go plan |
| DAU | Daily active users (Firebase Auth/Identity Platform metric) |
| COGS | Cost of goods sold; not currently tracked per item |
| LWW | Last-write-wins conflict behavior |
| HMAC | Keyed hash used for local voucher tamper evidence |

---

## 13. Bottom line

Ma Ngal Lay is a practical, low-cost, offline-first shop tool. It is strongest
for a single owner on one or two devices who sells during the day and syncs when
convenient. It is not a substitute for proper accounting, multi-cashier
coordination, mandatory customer-facing payment verification, or a hosted
business platform with guaranteed availability.

The most important safeguards are:

1. keep regular JSON backups,
2. sync before relying on a voucher publicly,
3. pause sync on **every** device if the shop wants a full sync blackout,
4. watch the Firestore free-tier usage,
5. move off GitHub Pages if the public catalog becomes business-critical.
