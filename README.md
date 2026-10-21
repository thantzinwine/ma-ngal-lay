# Ma Ngal Lay — mini mart POS

Private point-of-sale app for the shop owner, plus a separate public page for
customers. Data is stored locally in IndexedDB and synced to Firebase Firestore
when the owner is signed in.

## Pages

| Page | Link | Who sees it |
| --- | --- | --- |
| Owner app | `index.html` | Owner only (Firebase login + `owner: true` claim) |
| Public page | `shop.html` | Anyone — product names, categories, prices, availability and voucher verification. **No stock quantities are shown.** |

## Features

- Products with photos, categories, prices, barcodes and optional stock.
- Bill builder with typeable quantities, Cancel / Complete Sale confirmation,
  and a signed voucher with a QR code.
- Voucher verification on the public page by **QR scan** or by typing the code.
- History: sales revenue, change log and **costs**.
- Costs: record stock purchases, electric meter bills, gas bills, rent,
  transport and other expenses with a date. The Costs tab shows costs and
  **real revenue (sales − costs)** for today, this week, this month and all time.
- JSON backup / restore.
- Works offline after the first online sign-in (PWA). Sales, costs and edits
  are saved on the device and upload when the phone reconnects.
- **Pause cloud sync / Sync now** in Settings:
  - pause is per device and survives reloads;
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

Pause is saved on the device where you tap it. If the owner account is signed in
on another phone or PC, that device keeps syncing unless it is paused too.

## Documentation

| Document | Contents |
| --- | --- |
| [PROJECT.md](PROJECT.md) | Full architecture, data model, security, free-tier limits, drawbacks and future improvements |
| [FIREBASE_SETUP.md](FIREBASE_SETUP.md) | Firebase configuration, owner login, Firestore rules, deployment and troubleshooting |

## Setup

See [FIREBASE_SETUP.md](FIREBASE_SETUP.md) for Firebase configuration, owner
login, Firestore rules and deployment notes.

## To do later

- [ ] 👁 Show / hide password toggle on the owner login screen and in the
      change-password dialog.
