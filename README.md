# Ma Ngal Lay — multi-shop POS

Point-of-sale and product catalog for small shops. Any shop can create an
account, name its shop and manage its own products, sales, costs and public
page. Data is stored locally in IndexedDB and synced to Firebase Firestore.

## Pages

| Page | Link | Who sees it |
| --- | --- | --- |
| Shop manager | `index.html` | One owner account per shop (Firebase email/password) |
| Public page | `shop.html?shop=<slug>` | Anyone — products, categories, prices, availability and voucher verification. **No stock quantities are shown.** |

## How accounts work

- **Create account** on the sign-in screen, then **name your shop** and choose
  its public link (slug), e.g. `shop.html?shop=my-shop`.
- One account owns one shop. The account email and password are the owner login.
- Every shop's data is isolated under `shops/{shopId}/…` in Firestore and on the
  device. Signing out and into another account uses a separate local database,
  cart, sync queue and signing key.
- Shop name and currency can be changed later in **Settings → Shop profile**.
- The public link is shown in Settings with a **Copy public link** button.
- The original `ma-ngal-lay` shop can be migrated: the old owner account sees a
  **Copy my existing data** option when creating its shop.

## Features

- Products with photos, categories, prices, barcodes and optional stock.
- Bill builder with typeable quantities, Cancel / Complete Sale confirmation,
  and a signed voucher with a QR code.
- Voucher verification on the public page by **QR scan** or by typing the code.
- History: sales revenue, change log and **costs**.
- Costs: record stock purchases, electric meter bills, gas bills, rent,
  transport and other expenses with a date. The Costs tab shows costs and
  **real revenue (sales − costs)** for today, this week, this month and all time.
- JSON backup / restore (per shop).
- Works offline after the first online sign-in (PWA). Sales, costs and edits
  are saved on the device and upload when the phone reconnects.
- **Pause cloud sync / Sync now** in Settings:
  - pause is per device and per shop, and survives reloads;
  - while paused, changes stay in the local outbox;
  - **Sync now** resumes the network, uploads the outbox and refreshes the
    cloud listeners;
  - the last successful sync time is shown on the device;
  - vouchers created while paused cannot be verified by customers until the
    next sync.

## Daily use

- Online day: use the app normally; changes sync automatically.
- Once-a-day sync: tap **Pause cloud sync** in Settings in the morning. At the
  end of the day, connect to the internet and tap **Resume & sync now**.
- If the phone is already offline, changes queue automatically. Reconnect,
  open the app and tap **Sync now**; the app does not upload while closed.
- Vouchers created offline or while paused become verifiable on the public page
  only after that sync.

## Documentation

| Document | Contents |
| --- | --- |
| [PROJECT.md](PROJECT.md) | Architecture, data model, security, free-tier limits, drawbacks and future improvements |
| [FIREBASE_SETUP.md](FIREBASE_SETUP.md) | Firebase configuration, owner login, Firestore rules, deployment and troubleshooting |

## Setup

See [FIREBASE_SETUP.md](FIREBASE_SETUP.md) for Firebase configuration, owner
login, Firestore rules and deployment notes.

Important: the new rules and the new shop-scoped collections must be published
before other shops can use the app. Deploy `firestore.rules`, then push the
site.

## To do later

- [ ] 👁 Show / hide password toggle on the login screen and in the
      change-password dialog.
- [ ] Staff accounts per shop (cashier role).
- [ ] Shop logo upload.
- [ ] Custom domains instead of `shop.html?shop=<slug>`.
- [ ] Plans and limits once usage grows.
