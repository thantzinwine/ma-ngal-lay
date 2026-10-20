/* Ma Ngal Lay — mini mart product book + POS
 * Local-first: IndexedDB is the source of truth on the device.
 * Optional cloud: Firebase Firestore syncs products / sales / changes.
 */
'use strict';

const APP_ID = 'ma-ngal-lay';
const FB_VERSION = '11.0.1';
const CART_KEY = 'mnl-cart-v1';
const META_PREFIX = 'mnl-meta-';
const DB_NAME = 'ma-ngal-lay-app';
const DB_VERSION = 1;
const STORE_NAMES = ['products', 'sales', 'changes', 'outbox'];

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const state = {
  products: [],
  sales: [],
  changes: [],
  cart: new Map(),
  search: '',
  cartSearch: '',
  filterCat: 'all',
  cartFilterCat: 'all',
  screen: 'products',
  historyTab: 'sales',
  editingId: null,
  photoData: '',
  scanMode: null
};

const sync = {
  ready: false,
  initializing: false,
  flushing: false,
  importing: false,
  seeded: false,
  serverSnapshots: new Set(),
  meta: {},
  status: 'local',
  fatal: false,
  announced: false,
  errorShown: false,
  fs: null,
  db: null
};

let started = false;
let bodyLocks = 0;
let confirmResolve = null;
let scanner = null;
let scannerRunning = false;
let scanToken = 0;
let outboxCounter = 0;
const mirrorQueues = new Map();
let imageModelPromise = null;
let toastTimer = null;

/* ------------------------------------------------------------------ */
/* Tiny helpers                                                        */
/* ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const cleaned = String(value == null ? '' : value).replace(/,/g, '').trim();
  if (!cleaned) return NaN;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

function money(n) {
  const value = Number(n);
  return `${numberFormat.format(Number.isFinite(value) ? Math.round(value) : 0)} K`;
}

function uid() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function nowISO() {
  return new Date().toISOString();
}

function timeValue(iso) {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}

function startOfDay(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfWeek(date = new Date()) {
  const d = startOfDay(date);
  const day = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - day);
  return d;
}

function startOfMonth(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function dayKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function formatDay(key) {
  const parts = String(key).split('-').map(Number);
  const d = new Date(parts[0], (parts[1] || 1) - 1, parts[2] || 1);
  if (Number.isNaN(d.getTime())) return key;
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function categoryEmoji(category) {
  const c = String(category || '').toLowerCase();
  const map = [
    ['water', '💧'], ['drink', '🥤'], ['beverage', '🥤'], ['juice', '🧃'],
    ['snack', '🍪'], ['biscuit', '🍪'], ['food', '🍜'], ['noodle', '🍜'],
    ['grocery', '🛒'], ['fruit', '🍎'], ['vegetable', '🥬'],
    ['dairy', '🥛'], ['milk', '🥛'], ['bread', '🍞'], ['meat', '🥩'],
    ['fish', '🐟'], ['clean', '🧼'], ['soap', '🧼'], ['care', '🧴'],
    ['stationery', '✏️'], ['toy', '🧸'], ['phone', '📱'], ['mobile', '📱']
  ];
  for (const [key, emoji] of map) {
    if (c.includes(key)) return emoji;
  }
  return '📦';
}

function cssUrl(url) {
  return String(url).replace(/["\\\n\r]/g, (ch) => encodeURIComponent(ch));
}

function toast(message) {
  const node = $('toast');
  if (!node) return;
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 2600);
}

function showModal(id) {
  const node = $(id);
  if (!node || !node.hidden) return;
  node.hidden = false;
  bodyLocks += 1;
  document.body.style.overflow = 'hidden';
}

function hideModal(id) {
  const node = $(id);
  if (!node || node.hidden) return;
  node.hidden = true;
  bodyLocks = Math.max(0, bodyLocks - 1);
  if (bodyLocks === 0) document.body.style.overflow = '';
}

/* ------------------------------------------------------------------ */
/* IndexedDB + local fallback                                          */
/* ------------------------------------------------------------------ */

let idbPromise = null;

function openIDB() {
  if (idbPromise) return idbPromise;
  const promise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB is not available'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORE_NAMES) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
  });
  promise.catch(() => {
    if (idbPromise === promise) idbPromise = null;
  });
  idbPromise = promise;
  return promise;
}

function idbAll(name) {
  return openIDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(name, 'readonly');
    const req = tx.objectStore(name).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error || new Error('IndexedDB read failed'));
  }));
}

function idbPut(name, record) {
  return openIDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(name, 'readwrite');
    tx.objectStore(name).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB write failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB write aborted'));
  }));
}

function idbDelete(name, id) {
  return openIDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(name, 'readwrite');
    tx.objectStore(name).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB delete failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB delete aborted'));
  }));
}

function idbClear(name) {
  return openIDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(name, 'readwrite');
    tx.objectStore(name).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB clear failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB clear aborted'));
  }));
}

function idbReplace(name, records) {
  return openIDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(name, 'readwrite');
    const store = tx.objectStore(name);
    store.clear();
    for (const record of records) store.put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB replace failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB replace aborted'));
  }));
}

function lsKey(name) {
  return `mnl-${name}-v1`;
}

function lsRead(name) {
  try {
    const parsed = JSON.parse(localStorage.getItem(lsKey(name)) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function lsWrite(name, records) {
  try {
    localStorage.setItem(lsKey(name), JSON.stringify(records));
    return true;
  } catch {
    return false;
  }
}

function lsPut(name, record) {
  const records = lsRead(name).filter((row) => row && row.id !== record.id);
  records.push(record);
  return lsWrite(name, records);
}

function lsDelete(name, id) {
  return lsWrite(name, lsRead(name).filter((row) => row && row.id !== id));
}

async function storeAll(name) {
  try {
    return await idbAll(name);
  } catch {
    return lsRead(name);
  }
}

async function storePut(name, record) {
  try {
    await idbPut(name, record);
  } catch {
    lsPut(name, record);
  }
}

async function storeDelete(name, id) {
  try {
    await idbDelete(name, id);
  } catch {
    lsDelete(name, id);
  }
}

async function storeClear(name) {
  try {
    await idbClear(name);
  } catch {
    lsWrite(name, []);
  }
}

async function storeReplace(name, records) {
  try {
    await idbReplace(name, records);
  } catch {
    lsWrite(name, records);
  }
}

function metaGet(key) {
  try {
    const raw = localStorage.getItem(META_PREFIX + key);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function metaSet(key, value) {
  try {
    localStorage.setItem(META_PREFIX + key, JSON.stringify(value));
  } catch {
    /* meta flags are a convenience, not a requirement */
  }
}

/* ------------------------------------------------------------------ */
/* Data normalization                                                  */
/* ------------------------------------------------------------------ */

function normalizeProduct(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const price = typeof raw.price === 'number' ? raw.price : parseNumber(raw.price);
  const stockRaw = raw.stock;
  let stock = null;
  if (stockRaw !== null && stockRaw !== undefined && stockRaw !== '') {
    const n = parseNumber(stockRaw);
    stock = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  }
  return {
    id: raw.id ? String(raw.id) : uid(),
    name: String(raw.name || 'Unnamed product').trim().slice(0, 160) || 'Unnamed product',
    category: String(raw.category || 'Uncategorized').trim().slice(0, 80) || 'Uncategorized',
    barcode: String(raw.barcode || '').trim().slice(0, 160),
    price: Number.isFinite(price) ? Math.max(0, price) : 0,
    stock,
    photo: typeof raw.photo === 'string' ? raw.photo : '',
    createdAt: raw.createdAt || raw.updatedAt || nowISO(),
    updatedAt: raw.updatedAt || raw.createdAt || nowISO()
  };
}

function normalizeSale(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const items = (Array.isArray(raw.items) ? raw.items : [])
    .map((item) => ({
      productId: String(item && (item.productId || item.id) || ''),
      name: String(item && item.name || 'Item'),
      price: Math.max(0, parseNumber(item && item.price) || 0),
      qty: Math.max(1, Math.floor(parseNumber(item && item.qty) || 1))
    }))
    .filter((item) => item.qty > 0);
  const computed = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  const total = parseNumber(raw.total);
  return {
    id: raw.id ? String(raw.id) : uid(),
    items,
    total: Number.isFinite(total) ? Math.max(0, total) : computed,
    count: Number.isFinite(Number(raw.count))
      ? Math.max(0, Math.floor(Number(raw.count)))
      : items.reduce((sum, item) => sum + item.qty, 0),
    createdAt: raw.createdAt || nowISO()
  };
}

function normalizeChange(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const change = {
    id: raw.id ? String(raw.id) : uid(),
    type: String(raw.type || 'edit'),
    productId: String(raw.productId || ''),
    name: String(raw.name || 'Change'),
    detail: String(raw.detail || ''),
    createdAt: raw.createdAt || nowISO()
  };
  const amount = parseNumber(raw.amount);
  if (Number.isFinite(amount)) change.amount = amount;
  return change;
}

function normalizeCollection(name, rows) {
  const map = new Map();
  for (const raw of Array.isArray(rows) ? rows : []) {
    let record = null;
    if (name === 'products') record = normalizeProduct(raw);
    else if (name === 'sales') record = normalizeSale(raw);
    else if (name === 'changes') record = normalizeChange(raw);
    if (record) map.set(record.id, record);
  }
  const list = [...map.values()];
  if (name === 'products') {
    list.sort((a, b) => timeValue(a.createdAt) - timeValue(b.createdAt) || a.name.localeCompare(b.name));
  } else {
    list.sort((a, b) => timeValue(b.createdAt) - timeValue(a.createdAt));
  }
  return list;
}

/* ------------------------------------------------------------------ */
/* Cart                                                                */
/* ------------------------------------------------------------------ */

function restoreCart() {
  try {
    const raw = JSON.parse(localStorage.getItem(CART_KEY) || '{}');
    state.cart = new Map();
    if (raw && typeof raw === 'object') {
      for (const [id, qty] of Object.entries(raw)) {
        const n = Math.floor(Number(qty));
        if (id && n > 0) state.cart.set(id, n);
      }
    }
  } catch {
    state.cart = new Map();
  }
}

function saveCart() {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(Object.fromEntries(state.cart)));
  } catch {
    /* cart is still kept in memory */
  }
}

function cartEntries() {
  const entries = [];
  for (const [id, qty] of state.cart.entries()) {
    const product = state.products.find((p) => p.id === id);
    if (product && qty > 0) entries.push({ product, qty });
  }
  return entries;
}

function pruneCart() {
  let changed = false;
  for (const [id, qty] of [...state.cart.entries()]) {
    const product = state.products.find((p) => p.id === id);
    if (!product) {
      state.cart.delete(id);
      changed = true;
      continue;
    }
    if (product.stock !== null && qty > product.stock) {
      if (product.stock <= 0) state.cart.delete(id);
      else state.cart.set(id, product.stock);
      changed = true;
    }
  }
  if (changed) saveCart();
}

function addToCart(id, announce = false) {
  const product = state.products.find((p) => p.id === id);
  if (!product) return;
  const current = state.cart.get(id) || 0;
  if (product.stock !== null && current >= product.stock) {
    toast(product.stock <= 0 ? `${product.name} is out of stock` : `Only ${product.stock} left of ${product.name}`);
    return;
  }
  state.cart.set(id, current + 1);
  saveCart();
  renderPOS();
  renderCart();
  if (announce) toast(`Added ${product.name} to the bill`);
}

function stepQty(id, delta) {
  const product = state.products.find((p) => p.id === id);
  if (!product) return;
  const current = state.cart.get(id) || 0;
  const max = product.stock === null ? Infinity : product.stock;
  const next = Math.max(0, Math.min(max, current + delta));
  if (delta > 0 && current >= max) {
    toast(product.stock === 0 ? `${product.name} is out of stock` : `Only ${product.stock} left`);
    return;
  }
  if (next <= 0) state.cart.delete(id);
  else state.cart.set(id, next);
  saveCart();
  renderPOS();
  renderCart();
}

/* ------------------------------------------------------------------ */
/* Local + cloud persistence                                           */
/* ------------------------------------------------------------------ */

function cloudRecord(record) {
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

async function enqueueOutbox(collection, docId, op, data) {
  // If Firebase was configured before, keep local edits queued even while the
  // config is missing or the SDK failed to load, so they can sync later.
  if (!firebaseConfigured() && !metaGet('fbSeeded')) return;
  const entry = {
    id: uid(),
    collection,
    docId,
    op,
    data: op === 'set' ? cloudRecord(data || {}) : null,
    createdAt: nowISO(),
    seq: Date.now() * 1000 + (outboxCounter++ % 1000)
  };
  await storePut('outbox', entry);
}

async function persistRecord(collection, record) {
  await storePut(collection, record);
  await enqueueOutbox(collection, record.id, 'set', record);
}

async function persistDelete(collection, id) {
  await storeDelete(collection, id);
  await enqueueOutbox(collection, id, 'delete', null);
}

async function addChange(type, name, detail, extra = {}) {
  const change = {
    id: uid(),
    type,
    productId: extra.productId || '',
    name,
    detail: detail || '',
    createdAt: nowISO()
  };
  if (Number.isFinite(Number(extra.amount))) change.amount = Number(extra.amount);
  state.changes.push(change);
  await persistRecord('changes', change);
  return change;
}

function scheduleFlush() {
  if (!sync.ready || sync.importing) return;
  if (sync.flushing) return;
  sync.flushing = true;
  flushOutbox()
    .catch((err) => handleSyncError(err))
    .finally(() => { sync.flushing = false; });
}

async function flushOutbox() {
  if (!sync.ready || !sync.fs || !sync.db) return;
  // Loop so writes queued while a flush is in flight are picked up too.
  for (let pass = 0; pass < 20; pass += 1) {
    const entries = await storeAll('outbox');
    if (!entries.length) return;
    entries.sort((a, b) => {
      const aSeq = Number.isFinite(Number(a && a.seq)) ? Number(a.seq) : timeValue(a && a.createdAt);
      const bSeq = Number.isFinite(Number(b && b.seq)) ? Number(b.seq) : timeValue(b && b.createdAt);
      return aSeq - bSeq;
    });
    for (const entry of entries) {
      if (!entry || !entry.collection || !entry.docId) {
        if (entry && entry.id) await storeDelete('outbox', entry.id);
        continue;
      }
      const docRef = sync.fs.doc(sync.db, entry.collection, entry.docId);
      if (entry.op === 'delete') {
        await sync.fs.deleteDoc(docRef);
      } else {
        await sync.fs.setDoc(docRef, cloudRecord(entry.data || {}), { merge: true });
      }
      await storeDelete('outbox', entry.id);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Firebase (Firestore) sync                                           */
/* ------------------------------------------------------------------ */

function firebaseConfigured() {
  const cfg = window.FIREBASE_CONFIG;
  if (!cfg || typeof cfg !== 'object') return false;
  if (typeof cfg.apiKey !== 'string' || cfg.apiKey.trim().length < 20) return false;
  if (typeof cfg.projectId !== 'string' || !cfg.projectId.trim()) return false;
  if (typeof cfg.appId !== 'string' || !cfg.appId.trim()) return false;
  if (/(paste|replace|your[-_ ]?project|example|xxx)/i.test(`${cfg.apiKey} ${cfg.projectId} ${cfg.appId}`)) {
    return false;
  }
  return true;
}

function updateSyncStatus(status, text) {
  sync.status = status;
  const dot = $('syncDot');
  if (dot) {
    dot.className = `sync-dot ${status}`;
    dot.title = text;
    dot.setAttribute('aria-label', `Cloud sync: ${text}`);
  }
  const statusText = $('syncStatusText');
  if (statusText) statusText.textContent = text;
  const projectText = $('syncProjectText');
  if (projectText) {
    const cfg = window.FIREBASE_CONFIG;
    if (firebaseConfigured() && cfg) projectText.textContent = `Firestore project: ${cfg.projectId}`;
    else projectText.textContent = 'No Firebase project configured. Add firebase-config.js to sync across devices.';
  }
}

function updateSyncFromMeta() {
  if (!sync.ready || sync.fatal) return;
  if (!navigator.onLine) {
    updateSyncStatus('offline', 'Offline — changes are saved locally and will sync when online.');
    return;
  }
  const metas = Object.values(sync.meta);
  if (metas.some((m) => m.pending)) {
    updateSyncStatus('connecting', 'Saving changes to Firebase…');
    return;
  }
  if (metas.some((m) => m.fromCache)) {
    updateSyncStatus('connecting', 'Loading from the Firebase offline cache…');
    return;
  }
  if (metas.length >= 3) {
    updateSyncStatus('synced', 'Synced with Firebase — products, sales and changes are shared.');
    if (!sync.announced) {
      sync.announced = true;
      toast('Cloud sync connected');
    }
    return;
  }
  updateSyncStatus('connecting', 'Connecting to Firestore…');
}

function handleSyncError(err, fatal = false) {
  const code = err && err.code;
  console.warn('[Firebase] sync error:', code || (err && err.message) || err);
  if (fatal || code === 'permission-denied' || code === 'failed-precondition') {
    sync.fatal = true;
  }
  const message = code === 'permission-denied'
    ? 'Sync blocked by Firestore rules. Publish firestore.rules, then reload.'
    : navigator.onLine
      ? 'Firebase sync error — data is safe on this device.'
      : 'Offline — changes are saved locally and will sync when online.';
  updateSyncStatus(sync.fatal ? 'error' : 'offline', message);
  if (!sync.errorShown) {
    sync.errorShown = true;
    toast(sync.fatal ? 'Cloud sync blocked — check Firestore rules' : 'Cloud sync unavailable — working offline');
  }
}

function handleSnapshot(name, snapshot) {
  if (sync.importing) return;
  sync.meta[name] = {
    fromCache: Boolean(snapshot.metadata.fromCache),
    pending: Boolean(snapshot.metadata.hasPendingWrites)
  };

  const docs = snapshot.docs.map((doc) => ({ ...doc.data(), id: doc.id }));
  const local = state[name] || [];
  const firstServer = !snapshot.metadata.fromCache && !sync.serverSnapshots.has(name);

  if (snapshot.metadata.fromCache && docs.length === 0 && local.length && !sync.serverSnapshots.has(name)) {
    // Before the first server response, an empty cache must not wipe local data.
    updateSyncFromMeta();
    return;
  }

  let next = docs;
  if (firstServer) {
    sync.serverSnapshots.add(name);
    if (!sync.seeded && local.length) {
      const remoteIds = new Set(docs.map((row) => row.id));
      const missing = local.filter((row) => row && row.id && !remoteIds.has(row.id));
      if (missing.length) {
        next = docs.concat(missing);
        const queued = missing.map((record) =>
          enqueueOutbox(name, record.id, 'set', record).catch(() => {})
        );
        Promise.all(queued).then(() => scheduleFlush());
      }
    }
    if (!sync.seeded && sync.serverSnapshots.size >= 3) {
      sync.seeded = true;
      metaSet('fbSeeded', true);
      metaSet('fbSeededProject', window.FIREBASE_CONFIG.projectId);
    }
  }

  state[name] = normalizeCollection(name, next);
  mirrorStore(name, state[name]);
  renderForCollection(name);
  updateSyncFromMeta();
}

function mirrorStore(name, records) {
  const previous = mirrorQueues.get(name) || Promise.resolve();
  const task = previous.catch(() => {}).then(() => storeReplace(name, records));
  mirrorQueues.set(name, task);
  task.catch((err) => {
    console.warn('[local] could not mirror', name, err);
  });
}

function renderForCollection(name) {
  if (name === 'products') {
    pruneCart();
    renderCategoryDatalist();
    renderProducts();
    renderPOS();
    renderCart();
    renderInvValue();
  } else {
    renderHistory();
  }
}

async function initFirebase() {
  if (sync.ready || sync.initializing) return;
  if (!firebaseConfigured()) {
    updateSyncStatus('local', 'Local only — data stays on this device.');
    return;
  }

  sync.initializing = true;
  sync.fatal = false;
  updateSyncStatus('connecting', 'Connecting to Firebase…');

  try {
    const base = `https://www.gstatic.com/firebasejs/${FB_VERSION}/`;
    const [appModule, firestoreModule] = await Promise.all([
      import(`${base}firebase-app.js`),
      import(`${base}firebase-firestore.js`)
    ]);

    const app = appModule.getApps().length
      ? appModule.getApp()
      : appModule.initializeApp(window.FIREBASE_CONFIG);
    let db;
    try {
      db = firestoreModule.initializeFirestore(app, {
        localCache: firestoreModule.persistentLocalCache({
          tabManager: firestoreModule.persistentMultipleTabManager()
        }),
        ignoreUndefinedProperties: true
      });
    } catch (cacheError) {
      console.warn('[Firebase] persistent cache unavailable, using in-memory cache', cacheError);
      db = firestoreModule.getFirestore(app);
    }

    sync.fs = firestoreModule;
    sync.db = db;
    sync.ready = true;
    sync.seeded = Boolean(metaGet('fbSeeded')) && metaGet('fbSeededProject') === window.FIREBASE_CONFIG.projectId;

    updateSyncStatus('connecting', 'Connecting to Firestore…');

    // A backup restore made while Firebase was unavailable must win over the cloud.
    if (metaGet('pendingCloudRestore')) {
      await replaceCloudData();
      await storeClear('outbox');
      metaSet('pendingCloudRestore', false);
      sync.seeded = true;
      metaSet('fbSeeded', true);
      metaSet('fbSeededProject', window.FIREBASE_CONFIG.projectId);
    } else {
      await flushOutbox();
    }

    startFirebaseListeners();
    updateSyncStatus('connecting', 'Waiting for Firestore…');
  } catch (err) {
    sync.ready = false;
    sync.initializing = false;
    console.warn('[Firebase] could not start', err);
    handleSyncError(err);
    return;
  }
  sync.initializing = false;
}

function startFirebaseListeners() {
  for (const name of ['products', 'sales', 'changes']) {
    sync.fs.onSnapshot(
      sync.fs.collection(sync.db, name),
      { includeMetadataChanges: true },
      (snapshot) => handleSnapshot(name, snapshot),
      (err) => handleSyncError(err, true)
    );
  }
}

async function replaceCloudData() {
  if (!sync.ready || !sync.fs || !sync.db) return;
  sync.importing = true;
  try {
    for (const name of ['products', 'sales', 'changes']) {
      const records = state[name] || [];
      const keep = new Set(records.map((record) => record.id));
      const existing = await sync.fs.getDocs(sync.fs.collection(sync.db, name));
      const stale = existing.docs.map((doc) => doc.id).filter((id) => !keep.has(id));

      for (let i = 0; i < records.length; i += 400) {
        const batch = sync.fs.writeBatch(sync.db);
        for (const record of records.slice(i, i + 400)) {
          batch.set(sync.fs.doc(sync.db, name, record.id), cloudRecord(record));
        }
        await batch.commit();
      }
      for (let i = 0; i < stale.length; i += 400) {
        const batch = sync.fs.writeBatch(sync.db);
        for (const id of stale.slice(i, i + 400)) {
          batch.delete(sync.fs.doc(sync.db, name, id));
        }
        await batch.commit();
      }
    }
  } finally {
    sync.importing = false;
  }
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function matchesSearch(product, query) {
  if (!query) return true;
  const haystack = `${product.name} ${product.category} ${product.barcode}`.toLowerCase();
  return haystack.includes(query);
}

function stockBadge(product) {
  const badge = document.createElement('span');
  badge.className = 'stock';
  if (product.stock === null) {
    badge.classList.add('ok');
    badge.textContent = 'In stock';
  } else if (product.stock <= 0) {
    badge.classList.add('out');
    badge.textContent = 'Out';
  } else if (product.stock <= 5) {
    badge.classList.add('low');
    badge.textContent = `${product.stock} left`;
  } else {
    badge.classList.add('ok');
    badge.textContent = `${product.stock} left`;
  }
  return badge;
}

function createButton(text, className, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = text;
  if (label) button.setAttribute('aria-label', label);
  return button;
}

function productCard(product, mode) {
  const tracked = product.stock !== null;
  const out = tracked && product.stock <= 0;
  const card = document.createElement('article');
  card.className = `card${mode === 'pos' ? ' pos-card' : ''}${out ? ' dim' : ''}`;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `${product.name}, ${money(product.price)}`);

  const photo = document.createElement('div');
  photo.className = 'photo';
  if (product.photo) photo.style.backgroundImage = `url("${cssUrl(product.photo)}")`;
  else photo.textContent = categoryEmoji(product.category);
  card.append(photo);

  if (mode === 'products') {
    const edit = createButton('✏️', 'edit-btn', `Edit ${product.name}`);
    edit.addEventListener('click', (event) => {
      event.stopPropagation();
      openProductSheet(product.id);
    });
    card.append(edit);
  } else {
    const qty = state.cart.get(product.id) || 0;
    if (qty > 0) {
      const badge = document.createElement('span');
      badge.className = 'qty-badge';
      badge.textContent = String(qty);
      card.append(badge);
    }
  }

  const body = document.createElement('div');
  body.className = 'body';

  const price = document.createElement('div');
  price.className = 'price';
  price.textContent = money(product.price);

  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = product.name;

  const category = document.createElement('div');
  category.className = 'cat';
  category.textContent = product.category;

  const row = document.createElement('div');
  row.className = 'row';
  row.append(stockBadge(product));

  if (mode === 'products') {
    const add = createButton(out ? 'Out' : 'Add', 'add-btn', `Add ${product.name} to the bill`);
    add.disabled = out;
    add.addEventListener('click', (event) => {
      event.stopPropagation();
      addToCart(product.id, true);
    });
    row.append(add);
  } else {
    const hint = document.createElement('span');
    hint.className = 'tap-hint';
    hint.textContent = out ? 'Out of stock' : 'Tap to add';
    row.append(hint);
  }

  body.append(price, name, category, row);
  card.append(body);

  card.addEventListener('click', () => {
    if (mode === 'products') openProductSheet(product.id);
    else addToCart(product.id);
  });
  card.addEventListener('keydown', (event) => {
    if (event.target !== card) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      card.click();
    }
  });

  return card;
}

function renderChips(container, selected, screenMode) {
  if (!container) return;
  const query = (screenMode === 'cart' ? state.cartSearch : state.search).trim().toLowerCase();
  const categories = [...new Set(state.products.map((p) => p.category))].sort((a, b) => a.localeCompare(b));
  const counts = new Map();
  for (const product of state.products) {
    if (!matchesSearch(product, query)) continue;
    counts.set(product.category, (counts.get(product.category) || 0) + 1);
  }

  const chips = [];
  const allChip = createButton('', 'chip');
  allChip.append(document.createTextNode('All '));
  const allCount = document.createElement('span');
  allCount.className = 'chip-count';
  allCount.textContent = String(state.products.filter((p) => matchesSearch(p, query)).length);
  allChip.append(allCount);
  if (selected === 'all') allChip.classList.add('active');
  allChip.addEventListener('click', () => {
    if (screenMode === 'cart') state.cartFilterCat = 'all';
    else state.filterCat = 'all';
    if (screenMode === 'cart') renderPOS();
    else renderProducts();
  });
  chips.push(allChip);

  for (const category of categories) {
    const chip = createButton('', 'chip');
    chip.append(document.createTextNode(`${category} `));
    const count = document.createElement('span');
    count.className = 'chip-count';
    count.textContent = String(counts.get(category) || 0);
    chip.append(count);
    if (selected === category) chip.classList.add('active');
    chip.addEventListener('click', () => {
      if (screenMode === 'cart') state.cartFilterCat = category;
      else state.filterCat = category;
      if (screenMode === 'cart') renderPOS();
      else renderProducts();
    });
    chips.push(chip);
  }

  container.replaceChildren(...chips);
}

function renderProducts() {
  const query = state.search.trim().toLowerCase();
  if (state.filterCat !== 'all' && !state.products.some((product) => product.category === state.filterCat)) {
    state.filterCat = 'all';
  }
  const filtered = state.products.filter((product) =>
    matchesSearch(product, query) &&
    (state.filterCat === 'all' || product.category === state.filterCat)
  );
  $('productGrid').replaceChildren(...filtered.map((product) => productCard(product, 'products')));
  $('emptyState').hidden = filtered.length > 0;
  $('emptyText').textContent = state.products.length === 0
    ? 'No products yet'
    : 'No products match your search';
  renderChips($('chips'), state.filterCat, 'products');
}

function renderPOS() {
  const query = state.cartSearch.trim().toLowerCase();
  if (state.cartFilterCat !== 'all' && !state.products.some((product) => product.category === state.cartFilterCat)) {
    state.cartFilterCat = 'all';
  }
  const filtered = state.products.filter((product) =>
    matchesSearch(product, query) &&
    (state.cartFilterCat === 'all' || product.category === state.cartFilterCat)
  );
  $('posGrid').replaceChildren(...filtered.map((product) => productCard(product, 'pos')));
  $('posEmpty').hidden = filtered.length > 0;
  $('posEmptyText').textContent = state.products.length === 0
    ? 'No products yet'
    : 'No products match your search';
  renderChips($('cartChips'), state.cartFilterCat, 'cart');
}

function renderCart() {
  const entries = cartEntries();
  const count = entries.reduce((sum, entry) => sum + entry.qty, 0);
  const total = entries.reduce((sum, entry) => sum + entry.product.price * entry.qty, 0);

  $('cartList').replaceChildren(...entries.map(({ product, qty }) => {
    const item = document.createElement('div');
    item.className = 'cart-item';

    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    if (product.photo) thumb.style.backgroundImage = `url("${cssUrl(product.photo)}")`;
    else thumb.textContent = categoryEmoji(product.category);

    const info = document.createElement('div');
    info.className = 'info';
    const name = document.createElement('div');
    name.className = 'nm';
    name.textContent = product.name;
    const unit = document.createElement('div');
    unit.className = 'up';
    unit.textContent = `${money(product.price)} each`;
    info.append(name, unit);

    const stepper = document.createElement('div');
    stepper.className = 'stepper';
    const minus = createButton('−', '', `Remove one ${product.name}`);
    const qtyNode = document.createElement('span');
    qtyNode.className = 'qty';
    qtyNode.textContent = String(qty);
    const plus = createButton('+', '', `Add one ${product.name}`);
    minus.addEventListener('click', () => stepQty(product.id, -1));
    plus.addEventListener('click', () => stepQty(product.id, 1));
    stepper.append(minus, qtyNode, plus);

    const lineTotal = document.createElement('div');
    lineTotal.className = 'lt';
    lineTotal.textContent = money(product.price * qty);

    item.append(thumb, info, stepper, lineTotal);
    return item;
  }));

  $('cartFooter').hidden = count === 0 || state.screen !== 'cart';
  $('cartEmpty').hidden = count > 0;
  document.body.classList.toggle('cart-has-items', count > 0 && state.screen === 'cart');
  $('cartCount').textContent = `${count} item${count === 1 ? '' : 's'}`;
  $('cartTotal').textContent = money(total);

  const badge = $('cartBadge');
  badge.hidden = count === 0;
  badge.textContent = count > 99 ? '99+' : String(count);
}

function renderInvValue() {
  const tracked = state.products.filter((product) => product.stock !== null);
  const worth = tracked.reduce((sum, product) => sum + product.price * product.stock, 0);
  const node = $('invValue');
  node.textContent = `Stock worth ${money(worth)}`;
  node.title = `${state.products.length} product${state.products.length === 1 ? '' : 's'} · ${tracked.length} stock-tracked`;
}

function renderCategoryDatalist() {
  const categories = [...new Set(state.products.map((product) => product.category))].sort((a, b) => a.localeCompare(b));
  $('categoryList').replaceChildren(...categories.map((category) => {
    const option = document.createElement('option');
    option.value = category;
    return option;
  }));
}

function sumSalesSince(date) {
  const from = date.getTime();
  return state.sales.reduce((sum, sale) => {
    const t = timeValue(sale.createdAt);
    return t >= from ? sum + sale.total : sum;
  }, 0);
}

function makeLogCard(title, subtitle, rightText, rightClass = '') {
  const card = document.createElement('div');
  card.className = 'log-card';

  const left = document.createElement('div');
  left.className = 'l';
  const t = document.createElement('div');
  t.className = 't';
  t.textContent = title;
  const s = document.createElement('div');
  s.className = 's';
  s.textContent = subtitle;
  left.append(t, s);

  const right = document.createElement('div');
  right.className = `amt${rightClass ? ` ${rightClass}` : ''}`;
  right.textContent = rightText;

  card.append(left, right);
  return card;
}

function renderHistory() {
  const now = new Date();
  $('revToday').textContent = money(sumSalesSince(startOfDay(now)));
  $('revWeek').textContent = money(sumSalesSince(startOfWeek(now)));
  $('revMonth').textContent = money(sumSalesSince(startOfMonth(now)));
  $('revAll').textContent = money(state.sales.reduce((sum, sale) => sum + sale.total, 0));

  const days = new Map();
  for (const sale of state.sales) {
    const date = new Date(sale.createdAt);
    if (Number.isNaN(date.getTime())) continue;
    const key = dayKey(date);
    const entry = days.get(key) || { total: 0, count: 0 };
    entry.total += sale.total;
    entry.count += sale.count || 0;
    days.set(key, entry);
  }
  const daily = [...days.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 14);
  $('dailyList').replaceChildren(...(daily.length
    ? daily.map(([key, entry]) => makeLogCard(
      formatDay(key),
      `${entry.count} item${entry.count === 1 ? '' : 's'} sold`,
      money(entry.total)
    ))
    : [makeLogCard('No sales yet', 'Revenue will appear here after the first sale.', '')]
  ));

  const sales = state.sales.slice().sort((a, b) => timeValue(b.createdAt) - timeValue(a.createdAt)).slice(0, 100);
  $('salesList').replaceChildren(...(sales.length
    ? sales.map((sale) => {
      const itemNames = sale.items.map((item) => `${item.qty}× ${item.name}`).join(', ');
      const title = `${sale.count || sale.items.reduce((sum, item) => sum + item.qty, 0)} item${(sale.count || 0) === 1 ? '' : 's'}`;
      return makeLogCard(title, `${formatDateTime(sale.createdAt)}${itemNames ? ` · ${itemNames}` : ''}`, money(sale.total));
    })
    : [makeLogCard('No sales yet', 'Complete a sale from the Bill tab.', '')]
  ));

  const changes = state.changes.slice().sort((a, b) => timeValue(b.createdAt) - timeValue(a.createdAt)).slice(0, 100);
  const icons = { add: '➕', edit: '✏️', delete: '🗑️', sale: '💰', import: '⬆️' };
  $('changesList').replaceChildren(...(changes.length
    ? changes.map((change) => makeLogCard(
      `${icons[change.type] || '•'} ${change.name}`,
      `${formatDateTime(change.createdAt)}${change.detail ? ` · ${change.detail}` : ''}`,
      Number.isFinite(change.amount) ? money(change.amount) : '',
      Number.isFinite(change.amount) ? '' : 'count'
    ))
    : [makeLogCard('No changes yet', 'Add, edit or delete a product to see it here.', '')]
  ));
}

function renderAll() {
  renderCategoryDatalist();
  renderProducts();
  renderPOS();
  renderCart();
  renderHistory();
  renderInvValue();
}

/* ------------------------------------------------------------------ */
/* Product sheet                                                       */
/* ------------------------------------------------------------------ */

function setPhotoPreview(data) {
  const image = $('photoPreview');
  const placeholder = $('photoPlaceholder');
  if (data) {
    image.src = data;
    image.hidden = false;
    placeholder.hidden = true;
  } else {
    image.removeAttribute('src');
    image.hidden = true;
    placeholder.hidden = false;
  }
}

function showFormError(message) {
  const node = $('formError');
  if (!message) {
    node.hidden = true;
    node.textContent = '';
    return;
  }
  node.textContent = message;
  node.hidden = false;
}

function openProductSheet(id = null) {
  const product = id ? state.products.find((row) => row.id === id) : null;
  state.editingId = product ? product.id : null;
  state.photoData = product ? product.photo || '' : '';

  $('sheetTitle').textContent = product ? 'Edit Product' : 'Add Product';
  $('fName').value = product ? product.name : '';
  $('fCategory').value = product ? product.category : '';
  $('fBarcode').value = product ? product.barcode : '';
  $('fPrice').value = product ? String(product.price) : '';
  $('fStock').value = product && product.stock !== null ? String(product.stock) : '';
  $('deleteBtn').hidden = !product;
  $('photoInput').value = '';
  showFormError('');
  setPhotoPreview(state.photoData);
  renderCategoryDatalist();
  showModal('productSheet');
}

function closeProductSheet() {
  hideModal('productSheet');
  state.editingId = null;
  state.photoData = '';
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read image'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not load image'));
    image.src = src;
  });
}

async function resizeImage(file, maxSize = 640, quality = 0.78) {
  const dataUrl = await readFileAsDataURL(file);
  const image = await loadImage(dataUrl);
  const scale = Math.min(1, maxSize / Math.max(image.naturalWidth || 1, image.naturalHeight || 1));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round((image.naturalWidth || 1) * scale));
  canvas.height = Math.max(1, Math.round((image.naturalHeight || 1) * scale));
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  let result = canvas.toDataURL('image/jpeg', quality);
  if (result.length > 800000) {
    const smaller = Math.min(1, 420 / Math.max(canvas.width, canvas.height));
    canvas.width = Math.max(1, Math.round(canvas.width * smaller));
    canvas.height = Math.max(1, Math.round(canvas.height * smaller));
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    result = canvas.toDataURL('image/jpeg', 0.68);
  }
  return result;
}

function describeProductChange(before, after) {
  if (!before) {
    return `Price ${money(after.price)}${after.stock !== null ? ` · Stock ${after.stock}` : ''}`;
  }
  const bits = [];
  if (before.name !== after.name) bits.push(`Name "${before.name}" → "${after.name}"`);
  if (before.category !== after.category) bits.push(`Category ${before.category} → ${after.category}`);
  if (before.price !== after.price) bits.push(`Price ${money(before.price)} → ${money(after.price)}`);
  if (before.stock !== after.stock) {
    const from = before.stock === null ? 'untracked' : before.stock;
    const to = after.stock === null ? 'untracked' : after.stock;
    bits.push(`Stock ${from} → ${to}`);
  }
  if (before.barcode !== after.barcode) bits.push('Barcode updated');
  if (before.photo !== after.photo) bits.push('Photo updated');
  return bits.length ? bits.join(' · ') : 'Saved with no field changes';
}

async function saveProductFromForm() {
  const name = $('fName').value.trim();
  const category = $('fCategory').value.trim() || 'Uncategorized';
  const barcode = $('fBarcode').value.trim();
  const priceRaw = $('fPrice').value.trim();
  const stockRaw = $('fStock').value.trim();
  const price = parseNumber(priceRaw);
  const stock = stockRaw === '' ? null : parseNumber(stockRaw);

  if (!name) {
    showFormError('Please enter a product name.');
    $('fName').focus();
    return;
  }
  if (!priceRaw || !Number.isFinite(price) || price < 0) {
    showFormError('Please enter a valid price (0 or more).');
    $('fPrice').focus();
    return;
  }
  if (stockRaw !== '' && (!Number.isFinite(stock) || stock < 0)) {
    showFormError('Stock must be 0 or more, or left blank.');
    $('fStock').focus();
    return;
  }
  if (barcode) {
    const duplicate = state.products.find((product) => product.barcode === barcode && product.id !== state.editingId);
    if (duplicate) {
      showFormError(`That barcode is already used by "${duplicate.name}".`);
      return;
    }
  }

  const existing = state.editingId ? state.products.find((product) => product.id === state.editingId) : null;
  const product = {
    id: existing ? existing.id : uid(),
    name: name.slice(0, 160),
    category: category.slice(0, 80),
    barcode: barcode.slice(0, 160),
    price: Math.max(0, price),
    stock: stock === null ? null : Math.max(0, Math.floor(stock)),
    photo: state.photoData || '',
    createdAt: existing ? existing.createdAt : nowISO(),
    updatedAt: nowISO()
  };

  const saveButton = $('saveBtn');
  saveButton.disabled = true;
  saveButton.textContent = 'Saving…';
  showFormError('');

  try {
    const index = state.products.findIndex((row) => row.id === product.id);
    if (index >= 0) state.products[index] = product;
    else state.products.push(product);
    state.products = normalizeCollection('products', state.products);

    await persistRecord('products', product);
    await addChange(existing ? 'edit' : 'add', product.name, describeProductChange(existing, product), { productId: product.id });
    scheduleFlush();

    if (state.filterCat !== 'all' && state.filterCat !== product.category) state.filterCat = 'all';
    closeProductSheet();
    renderForCollection('products');
    renderHistory();
    toast(existing ? 'Product updated' : 'Product added');
  } catch (err) {
    console.error(err);
    showFormError('Could not save the product. Please try again.');
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = 'Save';
  }
}

async function deleteEditingProduct() {
  const product = state.products.find((row) => row.id === state.editingId);
  if (!product) return;
  const confirmed = await askConfirm(`Delete "${product.name}"? This cannot be undone.`);
  if (!confirmed) return;

  state.products = state.products.filter((row) => row.id !== product.id);
  state.cart.delete(product.id);
  saveCart();

  await persistDelete('products', product.id);
  await addChange('delete', product.name, `Deleted product · was ${money(product.price)}`, { productId: product.id });
  scheduleFlush();

  closeProductSheet();
  renderAll();
  toast('Product deleted');
}

/* ------------------------------------------------------------------ */
/* Checkout                                                            */
/* ------------------------------------------------------------------ */

async function checkout() {
  const entries = cartEntries();
  if (!entries.length) {
    toast('The bill is empty');
    return;
  }

  const items = entries.map(({ product, qty }) => ({
    productId: product.id,
    name: product.name,
    price: product.price,
    qty
  }));
  const total = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  const count = items.reduce((sum, item) => sum + item.qty, 0);
  const sale = { id: uid(), items, total, count, createdAt: nowISO() };

  const button = $('checkoutBtn');
  button.disabled = true;
  button.textContent = 'Saving…';

  try {
    state.sales.push(sale);
    await persistRecord('sales', sale);

    const updatedProducts = [];
    for (const { product, qty } of entries) {
      if (product.stock === null) continue;
      product.stock = Math.max(0, product.stock - qty);
      product.updatedAt = nowISO();
      updatedProducts.push(product);
    }
    for (const product of updatedProducts) await persistRecord('products', product);

    await addChange(
      'sale',
      `Sale · ${count} item${count === 1 ? '' : 's'}`,
      items.map((item) => `${item.qty}× ${item.name}`).join(', '),
      { amount: total }
    );
    scheduleFlush();

    state.cart.clear();
    saveCart();
    renderAll();
    toast(`Sale saved · ${money(total)}`);
  } catch (err) {
    console.error(err);
    toast('Could not complete the sale — please try again');
  } finally {
    button.disabled = false;
    button.textContent = 'Complete Sale';
  }
}

/* ------------------------------------------------------------------ */
/* Backup / restore                                                    */
/* ------------------------------------------------------------------ */

function exportBackup() {
  const payload = {
    app: APP_ID,
    version: 1,
    exportedAt: nowISO(),
    products: state.products,
    sales: state.sales,
    changes: state.changes
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `ma-ngal-lay-backup-${dayKey(new Date())}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('Backup exported');
}

async function importBackupFile(file) {
  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch {
    toast('That file is not valid JSON');
    return;
  }
  if (!payload || !Array.isArray(payload.products)) {
    toast('That does not look like a Ma Ngal Lay backup');
    return;
  }

  const products = normalizeCollection('products', payload.products);
  const sales = normalizeCollection('sales', Array.isArray(payload.sales) ? payload.sales : []);
  const changes = normalizeCollection('changes', Array.isArray(payload.changes) ? payload.changes : []);
  const confirmed = await askConfirm(
    `Replace all current data with this backup? ${products.length} product${products.length === 1 ? '' : 's'} and ${sales.length} sale${sales.length === 1 ? '' : 's'} will be restored.`
  );
  if (!confirmed) return;

  state.products = products;
  state.sales = sales;
  state.changes = changes;
  state.cart.clear();
  state.search = '';
  state.cartSearch = '';
  state.filterCat = 'all';
  state.cartFilterCat = 'all';
  $('searchInput').value = '';
  $('cartSearchInput').value = '';
  $('searchClear').hidden = true;
  $('cartSearchClear').hidden = true;
  saveCart();

  await storeReplace('products', products);
  await storeReplace('sales', sales);
  await storeReplace('changes', changes);
  await storeClear('outbox');

  const importChange = {
    id: uid(),
    type: 'import',
    productId: '',
    name: 'Backup restored',
    detail: `${products.length} products · ${sales.length} sales`,
    createdAt: nowISO()
  };
  state.changes.push(importChange);
  await persistRecord('changes', importChange);

  if (sync.ready) {
    try {
      await replaceCloudData();
      await storeClear('outbox');
      metaSet('pendingCloudRestore', false);
      metaSet('fbSeeded', true);
      metaSet('fbSeededProject', window.FIREBASE_CONFIG.projectId);
      sync.seeded = true;
    } catch (err) {
      metaSet('pendingCloudRestore', true);
      handleSyncError(err);
      toast('Restored locally — cloud restore will retry later');
    }
  } else if (firebaseConfigured() || metaGet('fbSeeded')) {
    metaSet('pendingCloudRestore', true);
  }

  renderAll();
  toast(`Backup restored · ${products.length} products`);
}

/* ------------------------------------------------------------------ */
/* Barcode scanner                                                     */
/* ------------------------------------------------------------------ */

function stopScanner() {
  const instance = scanner;
  const wasRunning = scannerRunning;
  scanner = null;
  scannerRunning = false;
  if (!instance) return;
  try {
    if (wasRunning) {
      instance.stop().then(() => {
        try { instance.clear(); } catch { /* already cleared */ }
      }).catch(() => {
        try { instance.clear(); } catch { /* already cleared */ }
      });
    } else {
      instance.clear();
    }
  } catch {
    /* ignore teardown errors */
  }
}

async function openScanner(mode) {
  const token = ++scanToken;
  state.scanMode = mode;
  showModal('scanModal');
  const holder = $('scanner');
  holder.replaceChildren();
  if (!window.Html5Qrcode) {
    toast('Scanner library did not load — check your connection');
    closeScanner();
    return;
  }
  try {
    const instance = new window.Html5Qrcode('scanner', { verbose: false });
    scanner = instance;
    await instance.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 240, height: 200 } },
      (decodedText) => handleScanResult(decodedText),
      () => { /* per-frame decode errors are normal */ }
    );
    if (token !== scanToken) {
      // The sheet was closed while the camera was starting.
      try { await instance.stop(); } catch { /* ignore */ }
      try { instance.clear(); } catch { /* ignore */ }
      return;
    }
    scannerRunning = true;
  } catch (err) {
    console.warn('[scanner]', err);
    if (token === scanToken) toast('Could not start the camera');
    closeScanner();
  }
}

function closeScanner() {
  scanToken += 1;
  stopScanner();
  hideModal('scanModal');
  state.scanMode = null;
}

function handleScanResult(text) {
  const code = String(text || '').trim();
  if (!code) return;
  const mode = state.scanMode;
  closeScanner();
  if (!mode) return;

  if (mode === 'field') {
    $('fBarcode').value = code;
    toast('Barcode captured');
    return;
  }
  if (mode === 'cart') {
    $('cartSearchInput').value = code;
    state.cartSearch = code;
    $('cartSearchClear').hidden = false;
    renderPOS();
    toast('Searching scanned code');
    return;
  }
  $('searchInput').value = code;
  state.search = code;
  $('searchClear').hidden = false;
  renderProducts();
  toast('Searching scanned code');
}

/* ------------------------------------------------------------------ */
/* Image search                                                        */
/* ------------------------------------------------------------------ */

function resetImageSearch() {
  $('imgPredictions').replaceChildren();
  const image = $('imgPreview');
  image.removeAttribute('src');
  image.hidden = true;
  $('imageSearchInput').value = '';
  $('imgSearchPickBtn').textContent = 'Pick Photo';
}

function openImageSearch() {
  resetImageSearch();
  showModal('imageSearchModal');
}

function closeImageSearch() {
  hideModal('imageSearchModal');
  resetImageSearch();
}

function productMatchesLabel(label) {
  const words = String(label || '').toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2);
  if (!words.length) return [];
  return state.products.filter((product) => {
    const haystack = `${product.name} ${product.category}`.toLowerCase();
    return words.some((word) => haystack.includes(word));
  });
}

async function handleImageSearchFile(file) {
  const predictionsNode = $('imgPredictions');
  predictionsNode.replaceChildren();
  const image = $('imgPreview');

  try {
    image.src = await readFileAsDataURL(file);
    image.hidden = false;
    if (typeof image.decode === 'function') await image.decode().catch(() => {});
    $('imgSearchPickBtn').textContent = 'Choose Another';

    if (!window.mobilenet || !window.tf) {
      throw new Error('image model not available');
    }
    if (!imageModelPromise) imageModelPromise = window.mobilenet.load();
    const model = await imageModelPromise;
    const predictions = await model.classify(image, 3);

    if (!predictions.length) {
      predictionsNode.textContent = 'No image predictions available.';
      return;
    }

    const heading = document.createElement('p');
    heading.style.fontWeight = '700';
    heading.style.marginBottom = '8px';
    heading.textContent = 'Tap a guess to search your products:';
    predictionsNode.append(heading);

    for (const prediction of predictions) {
      const label = String(prediction.className || '').split(',')[0].trim();
      const matches = productMatchesLabel(prediction.className);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn block';
      button.style.marginTop = '6px';
      button.textContent = `${label} · ${Math.round(Number(prediction.probability || 0) * 100)}%${matches.length ? ` (${matches.length} match${matches.length === 1 ? '' : 'es'})` : ''}`;
      button.addEventListener('click', () => {
        const term = label;
        $('searchInput').value = term;
        state.search = term;
        $('searchClear').hidden = false;
        closeImageSearch();
        switchTab('products');
        renderProducts();
        toast(`Showing matches for “${term}”`);
      });
      predictionsNode.append(button);
    }

    const anyMatches = predictions.reduce((sum, prediction) => sum + productMatchesLabel(prediction.className).length, 0);
    if (!anyMatches) {
      const hint = document.createElement('p');
      hint.className = 'empty-hint';
      hint.style.marginTop = '10px';
      hint.textContent = 'No direct product names matched. Pick a guess to search anyway.';
      predictionsNode.append(hint);
    }
  } catch (err) {
    console.warn('[image search]', err);
    predictionsNode.textContent = navigator.onLine
      ? 'Image search could not run. Please try again.'
      : 'Image search needs a connection the first time the model loads.';
  }
}

/* ------------------------------------------------------------------ */
/* Modals / navigation                                                 */
/* ------------------------------------------------------------------ */

function askConfirm(message) {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    $('confirmText').textContent = message;
    showModal('confirmDialog');
  });
}

function closeConfirm(result) {
  hideModal('confirmDialog');
  const resolve = confirmResolve;
  confirmResolve = null;
  if (resolve) resolve(result);
}

function switchTab(tab) {
  state.screen = tab;
  for (const screen of document.querySelectorAll('.screen')) {
    screen.classList.toggle('active', screen.id === `screen-${tab}`);
  }
  for (const button of document.querySelectorAll('.bottomnav button[data-tab]')) {
    button.classList.toggle('active', button.dataset.tab === tab);
  }
  $('fab').hidden = tab !== 'products';
  if (tab === 'history') renderHistory();
  if (tab === 'products') renderProducts();
  if (tab === 'cart') renderPOS();
  renderCart();
  window.scrollTo({ top: 0, behavior: 'smooth' });}

/* ------------------------------------------------------------------ */
/* Event wiring                                                        */
/* ------------------------------------------------------------------ */

function bindEvents() {
  for (const button of document.querySelectorAll('.bottomnav button[data-tab]')) {
    button.addEventListener('click', () => switchTab(button.dataset.tab));
  }

  $('fab').addEventListener('click', () => openProductSheet());

  $('searchInput').addEventListener('input', (event) => {
    state.search = event.target.value;
    $('searchClear').hidden = !state.search;
    renderProducts();
  });
  $('cartSearchInput').addEventListener('input', (event) => {
    state.cartSearch = event.target.value;
    $('cartSearchClear').hidden = !state.cartSearch;
    renderPOS();
  });
  $('searchClear').addEventListener('click', () => {
    $('searchInput').value = '';
    state.search = '';
    $('searchClear').hidden = true;
    renderProducts();
    $('searchInput').focus();
  });
  $('cartSearchClear').addEventListener('click', () => {
    $('cartSearchInput').value = '';
    state.cartSearch = '';
    $('cartSearchClear').hidden = true;
    renderPOS();
    $('cartSearchInput').focus();
  });

  $('scanBtn').addEventListener('click', () => openScanner('search'));
  $('scanBtnCart').addEventListener('click', () => openScanner('cart'));
  $('scanBarcodeFieldBtn').addEventListener('click', () => openScanner('field'));
  $('scanCloseBtn').addEventListener('click', closeScanner);

  $('imgSearchBtn').addEventListener('click', openImageSearch);
  $('imgSearchBtnCart').addEventListener('click', openImageSearch);
  $('imgSearchPickBtn').addEventListener('click', () => $('imageSearchInput').click());
  $('imageSearchInput').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (file) handleImageSearchFile(file);
  });
  $('imgSearchCloseBtn').addEventListener('click', closeImageSearch);

  $('photoInput').addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    if (file.size > 12 * 1024 * 1024) {
      toast('Please pick an image under 12 MB');
      return;
    }
    try {
      state.photoData = await resizeImage(file);
      setPhotoPreview(state.photoData);
    } catch (err) {
      console.warn(err);
      toast('Could not read that image');
    }
  });

  $('saveBtn').addEventListener('click', saveProductFromForm);
  $('deleteBtn').addEventListener('click', deleteEditingProduct);
  $('sheetClose').addEventListener('click', closeProductSheet);
  $('checkoutBtn').addEventListener('click', checkout);

  $('confirmNo').addEventListener('click', () => closeConfirm(false));
  $('confirmYes').addEventListener('click', () => closeConfirm(true));

  for (const tabButton of document.querySelectorAll('[data-htab]')) {
    tabButton.addEventListener('click', () => {
      state.historyTab = tabButton.dataset.htab;
      for (const button of document.querySelectorAll('[data-htab]')) {
        button.classList.toggle('active', button.dataset.htab === state.historyTab);
      }
      $('history-sales').hidden = state.historyTab !== 'sales';
      $('history-changes').hidden = state.historyTab !== 'changes';
    });
  }

  $('exportBtn').addEventListener('click', exportBackup);
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (file) await importBackupFile(file);
  });

  $('syncDot').addEventListener('click', () => {
    const detail = $('syncStatusText') ? $('syncStatusText').textContent : 'Local only';
    toast(detail);
  });

  // Click outside a sheet/dialog closes it.
  $('productSheet').addEventListener('click', (event) => {
    if (event.target === $('productSheet')) closeProductSheet();
  });
  $('confirmDialog').addEventListener('click', (event) => {
    if (event.target === $('confirmDialog')) closeConfirm(false);
  });
  $('scanModal').addEventListener('click', (event) => {
    if (event.target === $('scanModal')) closeScanner();
  });
  $('imageSearchModal').addEventListener('click', (event) => {
    if (event.target === $('imageSearchModal')) closeImageSearch();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!$('confirmDialog').hidden) closeConfirm(false);
    else if (!$('scanModal').hidden) closeScanner();
    else if (!$('imageSearchModal').hidden) closeImageSearch();
    else if (!$('productSheet').hidden) closeProductSheet();
  });

  window.addEventListener('online', () => {
    if (sync.ready && !sync.fatal) {
      updateSyncStatus('connecting', 'Back online — syncing…');
      scheduleFlush();
      updateSyncFromMeta();
    } else if (!sync.ready && firebaseConfigured()) {
      initFirebase();
    }
  });
  window.addEventListener('offline', () => {
    if (sync.ready) updateSyncStatus('offline', 'Offline — changes are saved locally and will sync when online.');
  });
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function init() {
  if (started) return;
  started = true;

  bindEvents();
  restoreCart();

  try {
    const [products, sales, changes] = await Promise.all([
      storeAll('products'),
      storeAll('sales'),
      storeAll('changes')
    ]);
    state.products = normalizeCollection('products', products);
    state.sales = normalizeCollection('sales', sales);
    state.changes = normalizeCollection('changes', changes);
  } catch (err) {
    console.warn('[local] could not load data', err);
  }

  pruneCart();
  renderAll();

  if (firebaseConfigured()) {
    updateSyncStatus('connecting', 'Starting cloud sync…');
    initFirebase();
  } else {
    updateSyncStatus('local', 'Local only — data stays on this device.');
  }
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('[service worker]', err));
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
