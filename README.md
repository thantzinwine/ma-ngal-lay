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

- Products with photos, categories, prices and optional stock.
- Bill builder with typeable quantities, Cancel / Complete Sale confirmation,
  and a signed voucher with a QR code.
- Voucher verification on the public page by **QR scan** or by typing the code.
- History: sales revenue, change log and **costs**.
- Costs: record stock purchases, electric meter bills, gas bills, rent,
  transport and other expenses with a date. The Costs tab shows costs and
  **real revenue (sales − costs)** for today, this week, this month and all time.
- JSON backup / restore.
- Works offline (PWA) and syncs across devices.

## Setup

See [FIREBASE_SETUP.md](FIREBASE_SETUP.md) for Firebase configuration, owner
login, Firestore rules and deployment notes.

## To do later

- [ ] 👁 Show / hide password toggle on the owner login screen and in the
      change-password dialog.
