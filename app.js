/* Ma Ngal Lay — mini mart product book + POS
 * Local-first: IndexedDB is the source of truth on the device.
 * Optional cloud: Firebase Firestore syncs products / sales / changes / costs.
 */
'use strict';

const APP_ID = 'ma-ngal-lay';
const CART_KEY = 'mnl-cart-v1';
const META_PREFIX = 'mnl-meta-';
const DB_NAME = 'ma-ngal-lay-app';
const DB_VERSION = 2;
const STORE_NAMES = ['products', 'sales', 'changes', 'costs', 'outbox'];
const SYNC_COLLECTIONS = ['products', 'sales', 'changes', 'costs'];
const COST_CATEGORIES = [
  { value: 'stock', label: 'Stock / goods purchase' },
  { value: 'electric', label: 'Electric meter bill' },
  { value: 'gas', label: 'Gas bill' },
  { value: 'rent', label: 'Rent' },
  { value: 'transport', label: 'Transport' },
  { value: 'other', label: 'Other' }
];
const OWNER_META_KEY = 'ownerAuth';
const OWNER_ITERATIONS = 150000;
const OWNER_LOCK_MS = 10 * 60 * 1000;
const VOUCHER_KEY_META = 'voucherHmacKey';
const VOUCHER_KEY_ID_META = 'voucherHmacKeyId';
const VOUCHER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PUBLIC_CATALOG = 'catalog';
const PUBLIC_VOUCHERS = 'vouchers';
const PUBLIC_META_VERSION = 1;
const OWNER_EMAIL_HINT = 'mnl-owner-email';

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const state = {
  products: [],
  sales: [],
  changes: [],
  costs: [],
  cart: new Map(),
  search: '',
  cartSearch: '',
  filterCat: 'all',
  cartFilterCat: 'all',
  screen: 'products',
  historyTab: 'sales',
  editingId: null,
  editingCostId: null,
  photoData: '',
  scanMode: null,
  ownerUnlocked: false,
  authUser: null,
  firebaseApp: null
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
  db: null,
  auth: null,
  authModule: null,
  unsubs: [],
  publicDataChecked: false
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
let pinResolver = null;
let pinMode = 'unlock';
let pinBusy = false;
let pinFailures = 0;
let pinBlockedUntil = 0;
let ownerLockTimer = null;
let voucherKeyPromise = null;
let currentVoucherSale = null;
let voucherHashTimer = null;
let voucherHashHandled = false;

// Revenue is aggregated once per sales change, never during rendering.
const revenue = {
  dirty: true,
  byDay: new Map(),
  sortedDays: [],
  recentSales: [],
  allTotal: 0,
  todayTotal: 0,
  weekTotal: 0,
  monthTotal: 0
};

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
/* Owner access (local PIN gate)                                       */
/* ------------------------------------------------------------------ */

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(String(value || ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function derivePin(pin, salt, iterations) {
  if (!window.crypto || !window.crypto.subtle) {
    throw new Error('Owner PIN needs HTTPS or localhost.');
  }
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    256
  );
  return bytesToBase64(new Uint8Array(bits));
}

function ownerPinSet() {
  const auth = metaGet(OWNER_META_KEY);
  return Boolean(auth && auth.hash && auth.salt);
}

async function setOwnerPin(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePin(pin, salt, OWNER_ITERATIONS);
  metaSet(OWNER_META_KEY, {
    v: 1,
    salt: bytesToBase64(salt),
    hash,
    iterations: OWNER_ITERATIONS,
    createdAt: nowISO()
  });
}

function sameSecret(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (!left || left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

async function verifyOwnerPin(pin) {
  const auth = metaGet(OWNER_META_KEY);
  if (!auth || !auth.hash || !auth.salt) return false;
  const hash = await derivePin(pin, base64ToBytes(auth.salt), Number(auth.iterations) || OWNER_ITERATIONS);
  return sameSecret(hash, auth.hash);
}

function clearOwnerPin() {
  try {
    localStorage.removeItem(META_PREFIX + OWNER_META_KEY);
  } catch {
    /* ignore */
  }
}

function askPin(mode) {
  if (pinResolver) return Promise.resolve(false);
  return new Promise((resolve) => {
    pinResolver = resolve;
    pinMode = mode;
    pinBusy = false;
    const hasPin = ownerPinSet();

    $('pinTitle').textContent = mode === 'create'
      ? (hasPin ? 'Change owner PIN' : 'Set owner PIN')
      : 'Unlock owner mode';
    $('pinMessage').textContent = mode === 'create'
      ? 'Choose a 4–12 digit PIN. It stays on this device and is needed to remove history.'
      : 'Enter your owner PIN to remove sales history.';
    $('pinInput').value = '';
    $('pinConfirmInput').value = '';
    $('pinConfirmInput').hidden = mode !== 'create';
    $('pinError').hidden = true;
    $('pinError').textContent = '';
    $('pinSubmit').disabled = false;
    $('pinSubmit').textContent = mode === 'create' ? 'Save PIN' : 'Unlock';
    showModal('pinDialog');
    setTimeout(() => $('pinInput').focus(), 60);
  });
}

function closePinDialog(result) {
  if (pinBusy) return;
  hideModal('pinDialog');
  const resolve = pinResolver;
  pinResolver = null;
  $('pinInput').value = '';
  $('pinConfirmInput').value = '';
  if (resolve) resolve(result);
}

async function submitPinDialog() {
  if (pinBusy) return;
  const pin = $('pinInput').value.trim();
  const showError = (message) => {
    const node = $('pinError');
    node.textContent = message;
    node.hidden = false;
  };
  $('pinError').hidden = true;

  if (!/^\d{4,12}$/.test(pin)) {
    showError('Use 4 to 12 digits.');
    return;
  }

  if (pinMode === 'create') {
    if (pin !== $('pinConfirmInput').value.trim()) {
      showError('The PINs do not match.');
      return;
    }
    pinBusy = true;
    $('pinSubmit').disabled = true;
    $('pinSubmit').textContent = 'Saving…';
    try {
      await setOwnerPin(pin);
      pinBusy = false;
      hideModal('pinDialog');
      const resolve = pinResolver;
      pinResolver = null;
      if (resolve) resolve(true);
    } catch (err) {
      pinBusy = false;
      $('pinSubmit').disabled = false;
      $('pinSubmit').textContent = 'Save PIN';
      showError(err && err.message ? err.message : 'Could not save the PIN.');
    }
    return;
  }

  const now = Date.now();
  if (now < pinBlockedUntil) {
    showError(`Too many attempts. Try again in ${Math.ceil((pinBlockedUntil - now) / 1000)}s.`);
    return;
  }

  pinBusy = true;
  $('pinSubmit').disabled = true;
  $('pinSubmit').textContent = 'Checking…';
  try {
    const ok = await verifyOwnerPin(pin);
    pinBusy = false;
    $('pinSubmit').disabled = false;
    $('pinSubmit').textContent = 'Unlock';
    if (!ok) {
      pinFailures += 1;
      if (pinFailures >= 5) {
        pinFailures = 0;
        pinBlockedUntil = Date.now() + 30000;
        showError('Too many attempts. Wait 30 seconds.');
      } else {
        const left = 5 - pinFailures;
        showError(`Wrong PIN. ${left} attempt${left === 1 ? '' : 's'} left.`);
      }
      $('pinInput').value = '';
      $('pinInput').focus();
      return;
    }
    pinFailures = 0;
    hideModal('pinDialog');
    const resolve = pinResolver;
    pinResolver = null;
    if (resolve) resolve(true);
  } catch (err) {
    pinBusy = false;
    $('pinSubmit').disabled = false;
    $('pinSubmit').textContent = 'Unlock';
    showError(err && err.message ? err.message : 'Could not check the PIN.');
  }
}

function armOwnerLock() {
  clearTimeout(ownerLockTimer);
  if (!state.ownerUnlocked) return;
  ownerLockTimer = setTimeout(() => {
    state.ownerUnlocked = false;
    renderOwnerUI();
    renderHistoryIfVisible();
    toast('Owner mode locked');
  }, OWNER_LOCK_MS);
}

function requireOwner() {
  if (!state.ownerUnlocked) {
    toast('Owner mode is locked — unlock it in Settings');
    return false;
  }
  armOwnerLock();
  return true;
}

// Used by history delete buttons: asks for the owner PIN only when one is set.
async function ensureOwnerAccess() {
  if (state.ownerUnlocked) {
    armOwnerLock();
    return true;
  }
  if (!ownerPinSet()) return true;
  const ok = await askPin('unlock');
  if (!ok) return false;
  state.ownerUnlocked = true;
  armOwnerLock();
  renderOwnerUI();
  renderHistoryIfVisible();
  return true;
}

async function setOwnerPinFlow() {
  const ok = await askPin('create');
  if (!ok) return;
  state.ownerUnlocked = true;
  armOwnerLock();
  renderOwnerUI();
  renderHistoryIfVisible();
  toast(ownerPinSet() ? 'Owner PIN saved' : 'Owner PIN set');
}

async function unlockOwnerFlow() {
  const ok = await askPin('unlock');
  if (!ok) return;
  state.ownerUnlocked = true;
  armOwnerLock();
  renderOwnerUI();
  renderHistoryIfVisible();
  toast('Owner mode unlocked');
}

function lockOwnerFlow() {
  state.ownerUnlocked = false;
  clearTimeout(ownerLockTimer);
  renderOwnerUI();
  renderHistoryIfVisible();
  toast('Owner mode locked');
}

async function removeOwnerPinFlow() {
  if (!requireOwner()) return;
  const ok = await askConfirm('Remove the owner PIN? Anyone using this device will be able to remove sales history.');
  if (!ok) return;
  clearOwnerPin();
  state.ownerUnlocked = false;
  clearTimeout(ownerLockTimer);
  renderOwnerUI();
  renderHistoryIfVisible();
  toast('Owner PIN removed');
}

function renderOwnerUI() {
  const setButton = $('ownerSetPinBtn');
  if (!setButton) return;
  const hasPin = ownerPinSet();
  const unlocked = state.ownerUnlocked;

  setButton.hidden = hasPin;
  $('ownerUnlockBtn').hidden = !hasPin || unlocked;
  $('ownerLockBtn').hidden = !unlocked;
  $('ownerChangePinBtn').hidden = !hasPin || !unlocked;
  $('ownerRemovePinBtn').hidden = !hasPin || !unlocked;
  $('ownerDangerZone').hidden = !unlocked;

  $('ownerStatusText').textContent = !hasPin
    ? 'No owner PIN is set. Delete buttons work without a PIN — set one to protect history.'
    : unlocked
      ? 'Owner mode is unlocked on this device. It locks automatically after 10 minutes of inactivity.'
      : 'Owner mode is locked. Enter your PIN when removing history.';

  const hint = $('ownerHint');
  if (hint) {
    hint.textContent = !hasPin
      ? '🗑️ Delete buttons are open. Set a PIN in Settings to protect history.'
      : unlocked
        ? '🔓 Owner mode is on. Tap 🗑️ to remove history entries.'
        : '🔒 Owner mode is locked. Tap 🗑️ to enter your PIN and remove history.';
    hint.classList.toggle('unlocked', unlocked);
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
  const sale = {
    id: raw.id ? String(raw.id) : uid(),
    items,
    total: Number.isFinite(total) ? Math.max(0, total) : computed,
    count: Number.isFinite(Number(raw.count))
      ? Math.max(0, Math.floor(Number(raw.count)))
      : items.reduce((sum, item) => sum + item.qty, 0),
    createdAt: raw.createdAt || nowISO(),
    voucherCode: String(raw.voucherCode || '').trim(),
    voucherSig: String(raw.voucherSig || '').trim(),
    voucherKeyId: String(raw.voucherKeyId || '').trim()
  };
  const paid = parseNumber(raw.paid);
  if (Number.isFinite(paid)) {
    sale.paid = Math.max(0, paid);
    const change = parseNumber(raw.change);
    sale.change = Number.isFinite(change) ? Math.max(0, change) : Math.max(0, sale.paid - sale.total);
  }
  return sale;
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

function normalizeCost(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const createdAt = raw.createdAt || nowISO();
  const category = COST_CATEGORIES.some((item) => item.value === raw.category) ? raw.category : 'other';
  const amount = parseNumber(raw.amount);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(raw.date || ''))
    ? String(raw.date)
    : dayKey(new Date(createdAt));
  return {
    id: raw.id ? String(raw.id) : uid(),
    title: String(raw.title || '').trim() || costCategoryLabel(category),
    category,
    amount: Number.isFinite(amount) ? Math.max(0, amount) : 0,
    date: day,
    note: String(raw.note || '').trim(),
    createdAt,
    updatedAt: raw.updatedAt || createdAt
  };
}

function costCategoryLabel(value) {
  const found = COST_CATEGORIES.find((item) => item.value === value);
  return found ? found.label : 'Other';
}

function normalizeCollection(name, rows) {
  const map = new Map();
  for (const raw of Array.isArray(rows) ? rows : []) {
    let record = null;
    if (name === 'products') record = normalizeProduct(raw);
    else if (name === 'sales') record = normalizeSale(raw);
    else if (name === 'changes') record = normalizeChange(raw);
    else if (name === 'costs') record = normalizeCost(raw);
    if (record) map.set(record.id, record);
  }
  const list = [...map.values()];
  if (name === 'products') {
    list.sort((a, b) => timeValue(a.createdAt) - timeValue(b.createdAt) || a.name.localeCompare(b.name));
  } else if (name === 'costs') {
    list.sort((a, b) => String(b.date).localeCompare(String(a.date)) || timeValue(b.createdAt) - timeValue(a.createdAt));
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

// Type a quantity directly into the bill. Invalid/blank input falls back to
// the previous quantity; 0 removes the line.
function setCartQty(id, raw) {
  const product = state.products.find((p) => p.id === id);
  if (!product) return;
  const typed = Math.floor(parseNumber(raw));
  if (!Number.isFinite(typed) || typed < 0) {
    renderCart();
    return;
  }
  let next = Math.min(typed, 9999);
  const max = product.stock === null ? Infinity : product.stock;
  if (next > max) {
    next = max;
    toast(product.stock <= 0 ? `${product.name} is out of stock` : `Only ${product.stock} left of ${product.name}`);
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
  state.changes.unshift(change);
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
      if (entry.op === 'clear') {
        await deleteCloudCollection(entry.collection);
        await storeDelete('outbox', entry.id);
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
  if (metas.length >= SYNC_COLLECTIONS.length) {
    updateSyncStatus('synced', 'Synced with Firebase — products, sales, costs and changes are shared.');
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
    if (!sync.seeded && sync.serverSnapshots.size >= SYNC_COLLECTIONS.length) {
      sync.seeded = true;
      metaSet('fbSeeded', true);
      metaSet('fbSeededProject', window.FIREBASE_CONFIG.projectId);
    }
  }

  state[name] = normalizeCollection(name, next);
  if (name === 'sales') invalidateRevenue();
  mirrorStore(name, state[name]);
  renderForCollection(name);
  if (!snapshot.metadata.fromCache) queuePublicDataDiff(name, local, state[name]);
  if (firstServer && sync.serverSnapshots.size >= SYNC_COLLECTIONS.length && !sync.publicDataChecked) {
    sync.publicDataChecked = true;
    ensurePublicDataVersion().catch((err) => console.warn('[public] could not publish public data', err));
  }
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
  if (name === 'sales') handleVoucherHash();
  if (name === 'products') {
    pruneCart();
    renderCategoryDatalist();
    renderProducts();
    renderPOS();
    renderCart();
    renderInvValue();
  } else if (state.screen === 'history') {
    renderHistory();
  }
}

/* ------------------------------------------------------------------ */
/* Public (customer-safe) data                                         */
/* ------------------------------------------------------------------ */

// The catalog collection never contains stock quantities or stock value.
function buildPublicCatalogRecord(product) {
  const photo = typeof product.photo === 'string' && product.photo.length <= 150000
    ? product.photo
    : '';
  return {
    name: String(product.name || ''),
    category: String(product.category || 'Uncategorized'),
    price: Number(product.price) || 0,
    photo,
    available: product.stock === null ? true : Number(product.stock) > 0,
    updatedAt: nowISO()
  };
}

function catalogSignature(product) {
  if (!product) return '';
  const availability = product.stock === null ? 'u' : (Number(product.stock) > 0 ? '1' : '0');
  return [
    product.name || '',
    product.category || '',
    Number(product.price) || 0,
    product.photo || '',
    availability
  ].join('|');
}

function buildPublicVoucher(sale) {
  const code = cleanVoucherCode(sale && sale.voucherCode);
  if (!code) return null;
  const record = {
    code: String(sale.voucherCode || code),
    createdAt: sale.createdAt || '',
    total: Number(sale.total) || 0,
    count: Number(sale.count) || 0,
    items: (sale.items || []).map((item) => ({
      name: String(item.name || ''),
      qty: Number(item.qty) || 0,
      price: Number(item.price) || 0
    }))
  };
  if (Number.isFinite(Number(sale.paid))) record.paid = Number(sale.paid);
  if (Number.isFinite(Number(sale.change))) record.change = Number(sale.change);
  return record;
}

function publicVoucherSignature(sale) {
  const record = buildPublicVoucher(sale);
  return record ? JSON.stringify(record) : '';
}

function queuePublicDataDiff(name, previous, next) {
  if (!firebaseConfigured()) return;
  const jobs = [];
  if (name === 'products') {
    const prevMap = new Map(previous.filter(Boolean).map((row) => [row.id, row]));
    const nextIds = new Set();
    for (const product of next) {
      if (!product || !product.id) continue;
      nextIds.add(product.id);
      const old = prevMap.get(product.id);
      if (!old || catalogSignature(old) !== catalogSignature(product)) {
        jobs.push(enqueueOutbox(PUBLIC_CATALOG, product.id, 'set', buildPublicCatalogRecord(product)).catch(() => {}));
      }
    }
    for (const old of previous) {
      if (old && old.id && !nextIds.has(old.id)) {
        jobs.push(enqueueOutbox(PUBLIC_CATALOG, old.id, 'delete', null).catch(() => {}));
      }
    }
  } else if (name === 'sales') {
    const prevMap = new Map();
    for (const sale of previous) {
      const code = cleanVoucherCode(sale && sale.voucherCode);
      if (code) prevMap.set(code, sale);
    }
    const nextCodes = new Set();
    for (const sale of next) {
      const code = cleanVoucherCode(sale && sale.voucherCode);
      if (!code) continue;
      nextCodes.add(code);
      const old = prevMap.get(code);
      if (!old || publicVoucherSignature(old) !== publicVoucherSignature(sale)) {
        jobs.push(enqueueOutbox(PUBLIC_VOUCHERS, code, 'set', buildPublicVoucher(sale)).catch(() => {}));
      }
    }
    for (const code of prevMap.keys()) {
      if (!nextCodes.has(code)) {
        jobs.push(enqueueOutbox(PUBLIC_VOUCHERS, code, 'delete', null).catch(() => {}));
      }
    }
  }
  if (jobs.length) Promise.all(jobs).then(() => scheduleFlush());
}

async function enqueuePublicCatalog(product) {
  if (!product || !product.id || !firebaseConfigured()) return;
  await enqueueOutbox(PUBLIC_CATALOG, product.id, 'set', buildPublicCatalogRecord(product));
  scheduleFlush();
}

async function removePublicCatalog(productId) {
  if (!productId || !firebaseConfigured()) return;
  await enqueueOutbox(PUBLIC_CATALOG, productId, 'delete', null);
  scheduleFlush();
}

async function enqueuePublicVoucher(sale) {
  const code = cleanVoucherCode(sale && sale.voucherCode);
  if (!code || !firebaseConfigured()) return;
  await enqueueOutbox(PUBLIC_VOUCHERS, code, 'set', buildPublicVoucher(sale));
  scheduleFlush();
}

async function removePublicVoucher(code) {
  const clean = cleanVoucherCode(code);
  if (!clean || !firebaseConfigured()) return;
  await enqueueOutbox(PUBLIC_VOUCHERS, clean, 'delete', null);
  scheduleFlush();
}

// Rebuild the public collections from the current local state. Used after a
// backup restore, where many products/sales change at once.
async function rebuildPublicData() {
  if (!sync.ready || !sync.fs || !sync.db) return;
  const fs = sync.fs;
  const db = sync.db;

  const catalogKeep = new Set(state.products.map((product) => product.id));
  const catalogExisting = await fs.getDocs(fs.collection(db, PUBLIC_CATALOG));
  const catalogOps = state.products.map((product) => ({
    type: 'set',
    ref: fs.doc(db, PUBLIC_CATALOG, product.id),
    data: buildPublicCatalogRecord(product)
  }));
  for (const doc of catalogExisting.docs) {
    if (!catalogKeep.has(doc.id)) catalogOps.push({ type: 'delete', ref: doc.ref });
  }
  await commitPublicOps(catalogOps);

  const voucherKeep = new Set();
  const voucherOps = [];
  for (const sale of state.sales) {
    const code = cleanVoucherCode(sale.voucherCode);
    if (!code) continue;
    voucherKeep.add(code);
    voucherOps.push({
      type: 'set',
      ref: fs.doc(db, PUBLIC_VOUCHERS, code),
      data: buildPublicVoucher(sale)
    });
  }
  const voucherExisting = await fs.getDocs(fs.collection(db, PUBLIC_VOUCHERS));
  for (const doc of voucherExisting.docs) {
    if (!voucherKeep.has(doc.id)) voucherOps.push({ type: 'delete', ref: doc.ref });
  }
  await commitPublicOps(voucherOps);
}

async function commitPublicOps(ops) {
  if (!ops.length || !sync.ready || !sync.fs || !sync.db) return;
  for (let i = 0; i < ops.length; i += 400) {
    const batch = sync.fs.writeBatch(sync.db);
    for (const op of ops.slice(i, i + 400)) {
      if (op.type === 'delete') batch.delete(op.ref);
      else batch.set(op.ref, cloudRecord(op.data));
    }
    await batch.commit();
  }
}

// Publish a full snapshot of the sanitized collections the first time this
// device connects after a data-format update. Later changes are written
// individually so we do not rewrite everything on every login.
async function ensurePublicDataVersion() {
  if (!sync.ready || !sync.fs || !sync.db) return;
  const metaRef = sync.fs.doc(sync.db, 'publicMeta', 'data');
  try {
    const snapshot = await sync.fs.getDoc(metaRef);
    if (snapshot.exists() && Number(snapshot.data().version) >= PUBLIC_META_VERSION) return;
  } catch (err) {
    console.warn('[public] could not read the public data version', err);
  }
  await rebuildPublicData();
  await sync.fs.setDoc(metaRef, { version: PUBLIC_META_VERSION, updatedAt: nowISO() });
}

/* ------------------------------------------------------------------ */
/* Owner authentication (Firebase email/password)                      */
/* ------------------------------------------------------------------ */

let ownerAppStarted = false;

function redirectLegacyVoucherLink() {
  if (!/[#&?]voucher=/i.test(location.hash)) return;
  if (/(^|\/)(shop|public|catalog)\.html$/i.test(location.pathname)) return;
  const target = new URL('shop.html', location.href);
  target.hash = location.hash.replace(/^#/, '');
  location.replace(target.href);
}

function authErrorMessage(err) {
  const code = (err && err.code) || '';
  if (code === 'auth/invalid-email') return 'Enter a valid email address.';
  if (code === 'auth/user-disabled') return 'This account has been disabled.';
  if (code === 'auth/user-not-found' || code === 'auth/wrong-password' || code === 'auth/invalid-credential') {
    return 'Wrong email or password.';
  }
  if (code === 'auth/too-many-requests') return 'Too many attempts. Wait a few minutes and try again.';
  if (code === 'auth/network-request-failed') return 'Network error. Check your connection and try again.';
  if (code === 'auth/operation-not-allowed') return 'Email/password sign-in is not enabled for this project.';
  if (code === 'auth/requires-recent-login') return 'Please sign in again before changing your password.';
  if (code === 'auth/weak-password') return 'Choose a stronger password (at least 8 characters).';
  if (code === 'auth/missing-password') return 'Enter your password.';
  return 'Sign-in failed. Please try again.';
}

function showLoginError(message, ok = false) {
  const node = $('loginError');
  if (!node) return;
  node.textContent = message || '';
  node.hidden = !message;
  node.classList.toggle('ok', Boolean(message) && ok);
}

function setLoginBusy(busy, label) {
  const button = $('loginSubmit');
  if (!button) return;
  button.disabled = busy;
  button.textContent = busy ? label || 'Please wait…' : 'Sign in';
}

async function initAuth() {
  try {
    const [appModule, authModule] = await Promise.all([
      import('./vendor/firebase/firebase-app.js'),
      import('./vendor/firebase/firebase-auth.js')
    ]);

    const app = appModule.getApps().length
      ? appModule.getApp()
      : appModule.initializeApp(window.FIREBASE_CONFIG);
    state.firebaseApp = app;

    const auth = authModule.getAuth(app);
    if (window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.useEmulators) {
      try {
        authModule.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
      } catch (emulatorError) {
        console.warn('[auth] could not connect to the Auth emulator', emulatorError);
      }
    }

    sync.authModule = authModule;
    sync.auth = auth;
    try {
      await authModule.setPersistence(auth, authModule.browserLocalPersistence);
    } catch (persistenceError) {
      console.warn('[auth] session persistence unavailable', persistenceError);
    }

    const savedEmail = localStorage.getItem(OWNER_EMAIL_HINT);
    if (savedEmail && !$('loginEmail').value) $('loginEmail').value = savedEmail;

    authModule.onAuthStateChanged(
      auth,
      (user) => {
        handleAuthState(user).catch((err) => {
          console.warn('[auth] state error', err);
          showLoginError(authErrorMessage(err));
        });
      },
      (err) => {
        console.warn('[auth] listener error', err);
        showLoginError('Login is unavailable right now. Check your connection and reload.');
      }
    );
    updateAccountUI();
  } catch (err) {
    console.warn('[auth] could not start', err);
    showLoginError(navigator.onLine
      ? 'Could not start the login service. Reload the page and try again.'
      : 'Connect to the internet once to sign in.');
  }
}

async function handleAuthState(user) {
  if (!user) {
    state.authUser = null;
    lockShop();
    updateAccountUI();
    return;
  }

  let isOwner = false;
  let tokenError = null;
  try {
    let token = await user.getIdTokenResult();
    isOwner = Boolean(token.claims && token.claims.owner === true);
    if (!isOwner && navigator.onLine) {
      token = await user.getIdTokenResult(true);
      isOwner = Boolean(token.claims && token.claims.owner === true);
    }
  } catch (err) {
    tokenError = err;
    console.warn('[auth] could not read the owner claim', err);
  }

  // Offline cold start: a cached token can expire after long offline use.
  // If this device already verified this exact owner account, keep working
  // locally until the network is back instead of locking the shop out.
  if (!isOwner && tokenError && !navigator.onLine) {
    const savedOwnerUid = metaGet('ownerUid');
    if (savedOwnerUid && savedOwnerUid === user.uid) {
      isOwner = true;
      console.warn('[auth] offline owner fallback used for', user.uid);
    }
  }

  if (!isOwner) {
    try { await sync.authModule.signOut(sync.auth); } catch { /* already signed out */ }
    state.authUser = null;
    lockShop();
    updateAccountUI();
    showLoginError('This account is not the shop owner. Sign in with the owner email.');
    return;
  }

  if (user.uid) metaSet('ownerUid', user.uid);
  state.authUser = user;
  showLoginError('');
  await unlockOwnerApp(user);
}

async function unlockOwnerApp(user) {
  state.authUser = user || null;
  document.body.classList.remove('auth-locked');
  updateAccountUI();

  if (!ownerAppStarted) {
    ownerAppStarted = true;
    restoreCart();
    await loadLocalData();
    pruneCart();
    renderAll();
  }

  if (firebaseConfigured() && user) {
    updateSyncStatus('connecting', 'Starting cloud sync…');
    initFirebase();
  } else if (!firebaseConfigured()) {
    updateSyncStatus('local', 'Local only — data stays on this device.');
  }

  maybePromptPasswordChange(user);
}

function lockShop() {
  document.body.classList.add('auth-locked');
  for (const unsubscribe of sync.unsubs) {
    try { unsubscribe(); } catch { /* already detached */ }
  }
  sync.unsubs = [];
  sync.ready = false;
  sync.initializing = false;
  sync.serverSnapshots.clear();
  sync.meta = {};
  state.authUser = null;
  state.products = [];
  state.sales = [];
  state.changes = [];
  state.costs = [];
  state.cart.clear();
  renderAll();
}

async function loadLocalData() {
  try {
    const rows = await Promise.all(SYNC_COLLECTIONS.map((name) => storeAll(name)));
    SYNC_COLLECTIONS.forEach((name, index) => {
      state[name] = normalizeCollection(name, rows[index]);
    });
  } catch (err) {
    console.warn('[local] could not load data', err);
  }
}

function updateAccountUI() {
  const status = $('accountStatusText');
  const changeButton = $('changePasswordBtn');
  const signOutButton = $('signOutBtn');
  if (!status) return;

  if (!firebaseConfigured()) {
    status.textContent = 'Local mode — login is not configured for this copy.';
    if (changeButton) changeButton.hidden = true;
    if (signOutButton) signOutButton.hidden = true;
    return;
  }

  if (state.authUser) {
    status.textContent = `Signed in as ${state.authUser.email}. Only this owner account can read or change the shop data.`;
    if (changeButton) changeButton.hidden = false;
    if (signOutButton) signOutButton.hidden = false;
  } else {
    status.textContent = 'Not signed in.';
    if (changeButton) changeButton.hidden = true;
    if (signOutButton) signOutButton.hidden = true;
  }
}

function maybePromptPasswordChange(user) {
  if (!user || !firebaseConfigured()) return;
  if (metaGet('ownerPasswordAcknowledged')) return;
  metaSet('ownerPasswordAcknowledged', true);
  setTimeout(() => {
    askConfirm('For security, set your own owner password now? The setup password is temporary.')
      .then((ok) => { if (ok) openPasswordDialog(); });
  }, 1400);
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  if (!sync.auth || !sync.authModule) {
    showLoginError('Login is still starting. Wait a moment and try again.');
    return;
  }
  const email = $('loginEmail').value.trim();
  const password = $('loginPassword').value;
  showLoginError('');
  setLoginBusy(true, 'Signing in…');
  try {
    await sync.authModule.signInWithEmailAndPassword(sync.auth, email, password);
    localStorage.setItem(OWNER_EMAIL_HINT, email);
  } catch (err) {
    showLoginError(authErrorMessage(err));
  } finally {
    setLoginBusy(false);
  }
}

async function handleForgotPassword() {
  if (!sync.auth || !sync.authModule) {
    showLoginError('Login is still starting. Wait a moment and try again.');
    return;
  }
  const email = $('loginEmail').value.trim();
  if (!email) {
    showLoginError('Type your owner email above, then tap Forgot password.');
    return;
  }
  try {
    await sync.authModule.sendPasswordResetEmail(sync.auth, email);
    showLoginError(`Password reset email sent to ${email}.`, true);
  } catch (err) {
    showLoginError(authErrorMessage(err));
  }
}

function openPasswordDialog() {
  if (!sync.auth || !sync.auth.currentUser || !sync.authModule) {
    toast('Sign in first');
    return;
  }
  $('currentPassword').value = '';
  $('newPassword').value = '';
  $('confirmPassword').value = '';
  const error = $('passwordError');
  error.hidden = true;
  error.textContent = '';
  showModal('passwordDialog');
  setTimeout(() => $('currentPassword').focus(), 80);
}

function closePasswordDialog() {
  hideModal('passwordDialog');
}

async function submitPasswordChange(event) {
  event.preventDefault();
  const error = $('passwordError');
  const showError = (message) => {
    error.textContent = message;
    error.hidden = false;
  };
  error.hidden = true;
  if (!sync.auth || !sync.auth.currentUser || !sync.authModule) {
    showError('You are not signed in.');
    return;
  }

  const current = $('currentPassword').value;
  const next = $('newPassword').value;
  const confirm = $('confirmPassword').value;
  if (next.length < 8) {
    showError('Use at least 8 characters for the new password.');
    return;
  }
  if (next !== confirm) {
    showError('The new passwords do not match.');
    return;
  }

  const button = $('passwordSubmit');
  button.disabled = true;
  button.textContent = 'Updating…';
  try {
    const credential = sync.authModule.EmailAuthProvider.credential(sync.auth.currentUser.email, current);
    await sync.authModule.reauthenticateWithCredential(sync.auth.currentUser, credential);
    await sync.authModule.updatePassword(sync.auth.currentUser, next);
    metaSet('ownerPasswordAcknowledged', true);
    closePasswordDialog();
    toast('Owner password updated');
  } catch (err) {
    showError(authErrorMessage(err));
  } finally {
    button.disabled = false;
    button.textContent = 'Update password';
  }
}

async function signOutOwner() {
  const ok = await askConfirm('Sign out of the shop manager on this device? Cloud data stays safe.');
  if (!ok) return;
  try {
    if (sync.auth && sync.authModule) await sync.authModule.signOut(sync.auth);
  } catch (err) {
    console.warn('[auth] sign out failed', err);
  }
  location.reload();
}

async function initFirebase() {
  if (sync.ready || sync.initializing) return;
  if (!firebaseConfigured()) {
    updateSyncStatus('local', 'Local only — data stays on this device.');
    return;
  }

  // Firestore was already initialized earlier in this page session (for
  // example after a re-login). Reuse it instead of initializing twice.
  if (sync.fs && sync.db) {
    sync.ready = true;
    try {
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
      handleSyncError(err);
    }
    return;
  }

  sync.initializing = true;
  sync.fatal = false;
  updateSyncStatus('connecting', 'Connecting to Firebase…');

  try {
    const [appModule, firestoreModule] = await Promise.all([
      import('./vendor/firebase/firebase-app.js'),
      import('./vendor/firebase/firebase-firestore.js')
    ]);

    const app = state.firebaseApp
      || (appModule.getApps().length ? appModule.getApp() : appModule.initializeApp(window.FIREBASE_CONFIG));
    state.firebaseApp = app;
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

    if (window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.useEmulators) {
      try {
        firestoreModule.connectFirestoreEmulator(db, '127.0.0.1', 8080);
      } catch (emulatorError) {
        console.warn('[Firebase] could not connect to the Firestore emulator', emulatorError);
      }
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
  for (const unsubscribe of sync.unsubs) {
    try { unsubscribe(); } catch { /* already detached */ }
  }
  sync.unsubs = [];
  for (const name of SYNC_COLLECTIONS) {
    const unsubscribe = sync.fs.onSnapshot(
      sync.fs.collection(sync.db, name),
      { includeMetadataChanges: true },
      (snapshot) => handleSnapshot(name, snapshot),
      (err) => handleSyncError(err, true)
    );
    sync.unsubs.push(unsubscribe);
  }
}

async function replaceCloudData() {
  if (!sync.ready || !sync.fs || !sync.db) return;
  sync.importing = true;
  try {
    for (const name of SYNC_COLLECTIONS) {
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
    await rebuildPublicData();
  } finally {
    sync.importing = false;
  }
}

async function deleteCloudCollection(name) {
  if (!sync.ready || !sync.fs || !sync.db) throw new Error('Firebase is not ready');
  if (!navigator.onLine) throw new Error('Offline');
  const snapshot = await sync.fs.getDocs(sync.fs.collection(sync.db, name));
  const ids = snapshot.docs.map((doc) => doc.id);
  for (let i = 0; i < ids.length; i += 400) {
    const batch = sync.fs.writeBatch(sync.db);
    for (const id of ids.slice(i, i + 400)) {
      batch.delete(sync.fs.doc(sync.db, name, id));
    }
    await batch.commit();
  }
}

async function clearCollection(name) {
  state[name] = [];
  await storeReplace(name, []);
  await enqueueOutbox(name, '*', 'clear', null);
  scheduleFlush();
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
    const qtyInput = document.createElement('input');
    qtyInput.type = 'text';
    qtyInput.setAttribute('inputmode', 'numeric');
    qtyInput.setAttribute('autocomplete', 'off');
    qtyInput.className = 'qty-input';
    qtyInput.value = String(qty);
    qtyInput.title = 'Type the quantity';
    qtyInput.setAttribute('aria-label', `Quantity of ${product.name}`);
    qtyInput.addEventListener('focus', () => qtyInput.select());
    qtyInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        qtyInput.blur();
      }
    });
    qtyInput.addEventListener('change', () => setCartQty(product.id, qtyInput.value));
    const plus = createButton('+', '', `Add one ${product.name}`);
    minus.addEventListener('click', () => stepQty(product.id, -1));
    plus.addEventListener('click', () => stepQty(product.id, 1));
    stepper.append(minus, qtyInput, plus);

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

function invalidateRevenue() {
  revenue.dirty = true;
}

function getRevenue() {
  if (revenue.dirty) rebuildRevenue();
  return revenue;
}

// Single pass over sales. All totals and the daily buckets are produced here
// once; rendering only reads the cached values.
function rebuildRevenue() {
  const now = new Date();
  const todayStart = startOfDay(now).getTime();
  const weekStart = startOfWeek(now).getTime();
  const monthStart = startOfMonth(now).getTime();
  const byDay = new Map();
  let allTotal = 0;
  let todayTotal = 0;
  let weekTotal = 0;
  let monthTotal = 0;

  for (const sale of state.sales) {
    const ts = timeValue(sale.createdAt);
    if (!ts) continue;
    const total = Number(sale.total);
    if (!Number.isFinite(total)) continue;

    allTotal += total;
    if (ts >= monthStart) {
      monthTotal += total;
      if (ts >= weekStart) {
        weekTotal += total;
        if (ts >= todayStart) todayTotal += total;
      }
    }

    const key = dayKey(new Date(ts));
    const count = Number(sale.count) || 0;
    const entry = byDay.get(key);
    if (entry) {
      entry.total += total;
      entry.count += count;
    } else {
      byDay.set(key, { total, count, ts });
    }
  }

  revenue.byDay = byDay;
  revenue.sortedDays = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  // state.sales is kept newest-first by normalizeCollection/unshift.
  revenue.recentSales = state.sales.slice(0, 100);
  revenue.allTotal = allTotal;
  revenue.todayTotal = todayTotal;
  revenue.weekTotal = weekTotal;
  revenue.monthTotal = monthTotal;
  revenue.dirty = false;
}

function renderHistoryIfVisible() {
  if (state.screen === 'history') renderHistory();
}

function makeLogCard(title, subtitle, rightText, rightClass = '', action = null) {
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

  const rightWrap = document.createElement('div');
  rightWrap.className = 'log-right';
  rightWrap.append(right);

  if (action) {
    const actions = Array.isArray(action) ? action : [action];
    for (const item of actions) {
      if (!item) continue;
      const button = createButton(item.label || '🗑️', item.className || 'log-del', item.title || 'Remove');
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        item.onClick();
      });
      rightWrap.append(button);
    }
  }

  card.append(left, rightWrap);
  return card;
}

function saleItemSummary(sale) {
  const items = Array.isArray(sale.items) ? sale.items : [];
  if (!items.length) return `${Number(sale.count) || 0} item${Number(sale.count) === 1 ? '' : 's'}`;
  const names = items.slice(0, 4).map((item) => `${item.qty}× ${item.name}`);
  if (items.length > 4) names.push(`+${items.length - 4} more`);
  return names.join(', ');
}

function renderHistory() {
  const summary = getRevenue();
  $('revToday').textContent = money(summary.todayTotal);
  $('revWeek').textContent = money(summary.weekTotal);
  $('revMonth').textContent = money(summary.monthTotal);
  $('revAll').textContent = money(summary.allTotal);

  const daily = summary.sortedDays.slice(0, 14);
  $('dailyList').replaceChildren(...(daily.length
    ? daily.map(([key, entry]) => makeLogCard(
      formatDay(key),
      `${entry.count} item${entry.count === 1 ? '' : 's'} sold`,
      money(entry.total)
    ))
    : [makeLogCard('No sales yet', 'Revenue will appear here after the first sale.', '')]
  ));

  const sales = summary.recentSales;
  $('salesList').replaceChildren(...(sales.length
    ? sales.map((sale) => {
      const itemNames = saleItemSummary(sale);
      const count = Number(sale.count) || 0;
      const title = `${count} item${count === 1 ? '' : 's'}`;
      const voucherText = sale.voucherCode ? ` · Voucher ${sale.voucherCode}` : '';
      return makeLogCard(
        title,
        `${formatDateTime(sale.createdAt)}${voucherText}${itemNames ? ` · ${itemNames}` : ''}`,
        money(sale.total),
        '',
        [
          sale.voucherCode
            ? {
              label: '🎫',
              className: 'log-del log-view',
              title: `View voucher ${sale.voucherCode}`,
              onClick: () => showVoucher(sale, { mode: 'history' })
            }
            : null,
          {
            label: '🗑️',
            className: 'log-del',
            title: `Remove this sale of ${money(sale.total)}`,
            onClick: () => deleteSaleRecord(sale)
          }
        ]
      );
    })
    : [makeLogCard('No sales yet', 'Complete a sale from the Bill tab.', '')]
  ));

  const changes = state.changes.slice(0, 100);
  const icons = { add: '➕', edit: '✏️', delete: '🗑️', void: '↩️', sale: '💰', import: '⬆️' };
  $('changesList').replaceChildren(...(changes.length
    ? changes.map((change) => makeLogCard(
      `${icons[change.type] || '•'} ${change.name}`,
      `${formatDateTime(change.createdAt)}${change.detail ? ` · ${change.detail}` : ''}`,
      Number.isFinite(change.amount) ? money(change.amount) : '',
      Number.isFinite(change.amount) ? '' : 'count',
      {
        label: '🗑️',
        title: 'Remove this history entry',
        onClick: () => deleteChangeRecord(change)
      }
    ))
    : [makeLogCard('No changes yet', 'Add, edit or delete a product to see it here.', '')]
  ));

  renderCosts();
}

/* ------------------------------------------------------------------ */
/* Costs (stock purchases, bills) and real revenue                     */
/* ------------------------------------------------------------------ */

function costTime(cost) {
  const t = new Date(`${cost.date}T12:00:00`).getTime();
  return Number.isFinite(t) ? t : timeValue(cost.createdAt);
}

function getCostSummary() {
  const now = new Date();
  const todayStart = startOfDay(now).getTime();
  const weekStart = startOfWeek(now).getTime();
  const monthStart = startOfMonth(now).getTime();
  const summary = {
    todayTotal: 0,
    weekTotal: 0,
    monthTotal: 0,
    allTotal: 0,
    todayCount: 0,
    weekCount: 0,
    monthCount: 0,
    allCount: 0
  };
  for (const cost of state.costs) {
    const t = costTime(cost);
    const amount = Number(cost.amount) || 0;
    summary.allTotal += amount;
    summary.allCount += 1;
    if (t >= todayStart) {
      summary.todayTotal += amount;
      summary.todayCount += 1;
    }
    if (t >= weekStart) {
      summary.weekTotal += amount;
      summary.weekCount += 1;
    }
    if (t >= monthStart) {
      summary.monthTotal += amount;
      summary.monthCount += 1;
    }
  }
  return summary;
}

function renderCosts() {
  const costs = getCostSummary();
  const sales = getRevenue();

  $('costToday').textContent = money(costs.todayTotal);
  $('costWeek').textContent = money(costs.weekTotal);
  $('costMonth').textContent = money(costs.monthTotal);
  $('costAll').textContent = money(costs.allTotal);

  const nets = [
    ['netToday', sales.todayTotal - costs.todayTotal],
    ['netWeek', sales.weekTotal - costs.weekTotal],
    ['netMonth', sales.monthTotal - costs.monthTotal],
    ['netAll', sales.allTotal - costs.allTotal]
  ];
  for (const [id, value] of nets) {
    const node = $(id);
    if (!node) continue;
    node.textContent = `Real revenue ${money(value)}`;
    node.classList.toggle('neg', value < 0);
  }

  const list = state.costs.slice(0, 200);
  $('costsList').replaceChildren(...(list.length
    ? list.map((cost) => {
      const card = makeLogCard(
        cost.title,
        `${formatDay(cost.date)} · ${costCategoryLabel(cost.category)}${cost.note ? ` · ${cost.note}` : ''}`,
        `− ${money(cost.amount)}`,
        'cost-amt',
        {
          label: '🗑️',
          title: `Remove ${cost.title}`,
          onClick: () => deleteCostRecord(cost)
        }
      );
      card.addEventListener('click', () => openCostEditor(cost.id));
      return card;
    })
    : [makeLogCard('No costs recorded', 'Add stock purchases, the electric meter bill, gas bill and more to see real revenue.', '')]
  ));
}

function showCostError(message) {
  const node = $('costError');
  if (!node) return;
  node.textContent = message;
  node.hidden = false;
}

function openCostEditor(id = null) {
  const cost = id ? state.costs.find((row) => row.id === id) : null;
  state.editingCostId = cost ? cost.id : null;
  $('costDialogTitle').textContent = cost ? 'Edit cost' : 'Add cost';
  $('costTitleInput').value = cost ? cost.title : '';
  $('costCategory').value = cost ? cost.category : 'stock';
  $('costAmount').value = cost ? String(Math.round(cost.amount)) : '';
  $('costDate').value = cost ? cost.date : dayKey(new Date());
  $('costNote').value = cost ? cost.note : '';
  const error = $('costError');
  error.hidden = true;
  error.textContent = '';
  $('costDeleteBtn').hidden = !cost;
  showModal('costDialog');
  setTimeout(() => $('costTitleInput').focus(), 80);
}

function closeCostDialog() {
  hideModal('costDialog');
  state.editingCostId = null;
}

async function saveCost() {
  const titleInput = $('costTitleInput');
  const title = titleInput.value.trim();
  const category = $('costCategory').value;
  const amount = parseNumber($('costAmount').value);
  const date = $('costDate').value || dayKey(new Date());
  const note = $('costNote').value.trim();

  if (!title) {
    showCostError('Enter what the cost was for.');
    titleInput.focus();
    return;
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    showCostError('Enter the amount in MMK (numbers only).');
    $('costAmount').focus();
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    showCostError('Choose the date of the cost.');
    $('costDate').focus();
    return;
  }

  const editing = state.editingCostId;
  const existing = editing ? state.costs.find((row) => row.id === editing) : null;
  const stamp = nowISO();
  const record = {
    id: existing ? existing.id : uid(),
    title,
    category,
    amount: Math.round(amount),
    date,
    note,
    createdAt: existing ? existing.createdAt : stamp,
    updatedAt: stamp
  };

  if (existing) {
    state.costs = state.costs.map((row) => (row.id === record.id ? record : row));
  } else {
    state.costs.unshift(record);
  }
  state.costs = normalizeCollection('costs', state.costs);
  await persistRecord('costs', record);
  scheduleFlush();
  renderAll();
  closeCostDialog();
  toast(existing ? 'Cost updated' : 'Cost added');
}

async function deleteCostRecord(cost) {
  if (!cost || !state.costs.some((row) => row.id === cost.id)) return;
  const ok = await askConfirm(
    `Remove this cost of ${money(cost.amount)} (${cost.title})? Real revenue will be recalculated.`
  );
  if (!ok) return;

  state.costs = state.costs.filter((row) => row.id !== cost.id);
  await persistDelete('costs', cost.id);
  scheduleFlush();
  renderAll();
  toast('Cost removed');
}

async function deleteSaleRecord(sale) {
  if (!(await ensureOwnerAccess())) return;
  if (!sale || !state.sales.some((row) => row.id === sale.id)) return;

  const ok = await askConfirm(
    `Remove this sale of ${money(sale.total)}? Stock will be added back for tracked products. This syncs to all devices.`
  );
  if (!ok) return;

  state.sales = state.sales.filter((row) => row.id !== sale.id);
  invalidateRevenue();
  await persistDelete('sales', sale.id);
  await removePublicVoucher(sale.voucherCode);

  const restored = [];
  for (const item of sale.items || []) {
    const product = state.products.find((row) => row.id === item.productId);
    if (!product || product.stock === null) continue;
    const current = Number(product.stock);
    if (!Number.isFinite(current)) continue;
    product.stock = Math.max(0, Math.round(current + item.qty));
    product.updatedAt = nowISO();
    await persistRecord('products', product);
    await enqueuePublicCatalog(product);
    restored.push(product.name);
  }

  await addChange(
    'void',
    'Sale removed',
    `${formatDateTime(sale.createdAt)} · ${saleItemSummary(sale)}${restored.length ? ' · stock restored' : ''}`,
    { amount: sale.total }
  );
  scheduleFlush();
  renderAll();
  toast(restored.length ? 'Sale removed · stock restored' : 'Sale removed');
}

async function deleteChangeRecord(change) {
  if (!(await ensureOwnerAccess())) return;
  if (!change || !state.changes.some((row) => row.id === change.id)) return;

  const ok = await askConfirm(`Remove "${change.name}" from the change log? This syncs to all devices.`);
  if (!ok) return;

  state.changes = state.changes.filter((row) => row.id !== change.id);
  await persistDelete('changes', change.id);
  scheduleFlush();
  renderAll();
  toast('History entry removed');
}

async function clearSalesHistory() {
  if (!requireOwner()) return;
  const count = state.sales.length;
  if (!count) {
    toast('There is no sales history to clear');
    return;
  }
  const total = getRevenue().allTotal;
  const ok = await askConfirm(
    `Delete all ${count} sales? Revenue resets to zero. Stock is NOT restored. This syncs to all devices and cannot be undone.`
  );
  if (!ok) return;

  await clearCollection('sales');
  if (firebaseConfigured()) await enqueueOutbox(PUBLIC_VOUCHERS, '*', 'clear', null);
  invalidateRevenue();
  await addChange(
    'void',
    'Sales history cleared',
    `${count} sale${count === 1 ? '' : 's'} removed · ${money(total)}`,
    { amount: total }
  );
  scheduleFlush();
  renderAll();
  toast(`Sales history cleared · ${count} sale${count === 1 ? '' : 's'}`);
}

async function clearChangeLog() {
  if (!requireOwner()) return;
  const count = state.changes.length;
  if (!count) {
    toast('The change log is already empty');
    return;
  }
  const ok = await askConfirm(
    `Delete all ${count} change-log entries? One audit entry will remain to record the clear. This syncs to all devices.`
  );
  if (!ok) return;

  await clearCollection('changes');
  await addChange('delete', 'Change log cleared', `${count} entr${count === 1 ? 'y' : 'ies'} removed`);
  scheduleFlush();
  renderAll();
  toast('Change log cleared');
}

function renderAll() {
  renderCategoryDatalist();
  renderProducts();
  renderPOS();
  renderCart();
  if (state.screen === 'history') renderHistory();
  renderInvValue();
  renderOwnerUI();
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
    await enqueuePublicCatalog(product);
    await addChange(existing ? 'edit' : 'add', product.name, describeProductChange(existing, product), { productId: product.id });
    scheduleFlush();

    if (state.filterCat !== 'all' && state.filterCat !== product.category) state.filterCat = 'all';
    closeProductSheet();
    renderForCollection('products');
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
  await removePublicCatalog(product.id);
  await addChange('delete', product.name, `Deleted product · was ${money(product.price)}`, { productId: product.id });
  scheduleFlush();

  closeProductSheet();
  renderAll();
  toast('Product deleted');
}

/* ------------------------------------------------------------------ */
/* Purchase vouchers                                                   */
/* ------------------------------------------------------------------ */

function secureRandomBytes(length) {
  const bytes = new Uint8Array(length);
  if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
    window.crypto.getRandomValues(bytes);
    return bytes;
  }
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const clean = String(hex || '').replace(/[^0-9a-f]/gi, '');
  if (!clean || clean.length % 2) return new Uint8Array();
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function cleanVoucherCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function makeVoucherCode(when = new Date()) {
  const stamp = dayKey(when).replace(/-/g, '').slice(2);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const bytes = secureRandomBytes(16);
    let token = '';
    for (const byte of bytes) token += VOUCHER_ALPHABET[byte % VOUCHER_ALPHABET.length];
    const code = `MNL-${stamp}-${token.slice(0, 4)}-${token.slice(4, 8)}-${token.slice(8, 12)}-${token.slice(12, 16)}`;
    const cleaned = cleanVoucherCode(code);
    if (!state.sales.some((sale) => cleanVoucherCode(sale.voucherCode) === cleaned)) return code;
  }
  return `MNL-${stamp}-${Date.now().toString(36).toUpperCase()}`;
}

async function getVoucherKey() {
  if (!voucherKeyPromise) {
    voucherKeyPromise = (async () => {
      if (!window.crypto || !window.crypto.subtle) {
        throw new Error('Voucher signing needs HTTPS or localhost');
      }
      let raw = metaGet(VOUCHER_KEY_META);
      let keyBytes;
      if (typeof raw === 'string' && raw) {
        try {
          keyBytes = base64ToBytes(raw);
        } catch {
          keyBytes = null;
        }
      }
      if (!keyBytes || !keyBytes.length) {
        keyBytes = secureRandomBytes(32);
        raw = bytesToBase64(keyBytes);
        metaSet(VOUCHER_KEY_META, raw);
      }
      const key = await crypto.subtle.importKey(
        'raw',
        keyBytes,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign', 'verify']
      );
      const digest = await crypto.subtle.digest('SHA-256', keyBytes);
      const keyId = bytesToHex(new Uint8Array(digest).slice(0, 4));
      metaSet(VOUCHER_KEY_ID_META, keyId);
      return { key, keyId };
    })();
    voucherKeyPromise.catch(() => { voucherKeyPromise = null; });
  }
  return voucherKeyPromise;
}

function voucherPayload(sale) {
  const items = (sale.items || [])
    .map((item) => `${item.productId}|${item.qty}|${item.price}`)
    .join(';');
  return [
    'MNL-VOUCHER-1',
    cleanVoucherCode(sale.voucherCode),
    sale.id || '',
    sale.createdAt || '',
    String(sale.total == null ? 0 : sale.total),
    String(sale.count == null ? 0 : sale.count),
    sale.paid == null ? '' : String(sale.paid),
    sale.change == null ? '' : String(sale.change),
    sale.voucherKeyId || '',
    items
  ].join('|');
}

async function issueVoucher(sale) {
  sale.voucherCode = makeVoucherCode(new Date(sale.createdAt || Date.now()));
  try {
    const { key, keyId } = await getVoucherKey();
    sale.voucherKeyId = keyId;
    const signature = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(voucherPayload(sale))
    );
    sale.voucherSig = bytesToHex(new Uint8Array(signature));
  } catch (err) {
    console.warn('[voucher] could not sign the voucher', err);
    sale.voucherSig = '';
    sale.voucherKeyId = '';
  }
  return sale;
}

async function voucherSignatureStatus(sale) {
  if (!sale || !sale.voucherSig || !sale.voucherKeyId) return 'record';
  if (!window.crypto || !window.crypto.subtle) return 'record';
  const localKeyId = metaGet(VOUCHER_KEY_ID_META);
  if (!localKeyId || localKeyId !== sale.voucherKeyId) return 'other';
  try {
    const { key } = await getVoucherKey();
    const signature = hexToBytes(sale.voucherSig);
    if (!signature.length) return 'bad';
    const ok = await crypto.subtle.verify(
      'HMAC',
      key,
      signature,
      new TextEncoder().encode(voucherPayload(sale))
    );
    return ok ? 'verified' : 'bad';
  } catch {
    return 'record';
  }
}

function findSaleByVoucher(value) {
  const code = cleanVoucherCode(value);
  if (!code) return null;
  return state.sales.find((sale) => sale.voucherCode && cleanVoucherCode(sale.voucherCode) === code) || null;
}

function voucherVerifyUrl(code) {
  if (!code) return '';
  try {
    const target = new URL('shop.html', location.href);
    target.hash = `voucher=${encodeURIComponent(code)}`;
    return target.href;
  } catch {
    return code;
  }
}

function renderVoucherQr(text) {
  const node = $('voucherQr');
  if (!node) return;
  node.replaceChildren();
  if (typeof QRCode === 'undefined') {
    node.hidden = true;
    return;
  }
  node.hidden = false;
  try {
    new QRCode(node, {
      text,
      width: 172,
      height: 172,
      colorDark: '#12211a',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M
    });
  } catch (err) {
    console.warn('[voucher] could not draw the QR code', err);
    node.hidden = true;
  }
}

function voucherQrDataUrl() {
  const node = $('voucherQr');
  if (!node) return '';
  const canvas = node.querySelector('canvas');
  if (canvas) {
    try { return canvas.toDataURL('image/png'); } catch { /* fall through */ }
  }
  const image = node.querySelector('img');
  return image && image.src ? image.src : '';
}

function showVoucher(sale, options = {}) {
  if (!sale || !sale.voucherCode) {
    toast('No voucher for this sale');
    return;
  }
  currentVoucherSale = sale;
  const mode = options.mode || 'sale';

  $('voucherTitle').textContent = mode === 'verify'
    ? 'Voucher verified'
    : mode === 'sale'
      ? 'Sale complete'
      : 'Purchase voucher';
  $('voucherCode').textContent = sale.voucherCode;

  const count = Number(sale.count) || 0;
  $('voucherMeta').textContent = `${formatDateTime(sale.createdAt)} · ${count} item${count === 1 ? '' : 's'}`;

  const lines = (sale.items || []).map((item) => {
    const line = document.createElement('div');
    line.className = 'voucher-line';
    const name = document.createElement('span');
    name.className = 'voucher-line-name';
    name.textContent = `${item.qty}× ${item.name}`;
    const amount = document.createElement('strong');
    amount.textContent = money(item.price * item.qty);
    line.append(name, amount);
    return line;
  });
  $('voucherItems').replaceChildren(...lines);

  $('voucherTotal').textContent = money(sale.total);

  const payment = $('voucherPayment');
  if (Number.isFinite(sale.paid)) {
    const change = Number.isFinite(sale.change) ? sale.change : Math.max(0, sale.paid - sale.total);
    payment.textContent = `Received ${money(sale.paid)} · Change ${money(change)}`;
    payment.hidden = false;
  } else {
    payment.hidden = true;
    payment.textContent = '';
  }

  const statusNode = $('voucherStatus');
  const status = options.status || '';
  statusNode.className = 'voucher-status';
  statusNode.hidden = !status;
  if (status === 'verified') {
    statusNode.textContent = '🔐 Valid — signature verified on this device.';
    statusNode.classList.add('ok');
  } else if (status === 'other') {
    statusNode.textContent = '✅ Valid — found in synced sales (issued on another device).';
    statusNode.classList.add('ok');
  } else if (status === 'record') {
    statusNode.textContent = '✅ Valid — found in sales history.';
    statusNode.classList.add('ok');
  } else if (status === 'signed') {
    statusNode.textContent = '🔐 Signed — unique voucher code issued.';
    statusNode.classList.add('ok');
  } else if (status === 'bad') {
    statusNode.textContent = '⚠ Signature mismatch — check this voucher with the owner.';
    statusNode.classList.add('warn');
  }

  $('voucherNote').textContent = mode === 'verify'
    ? 'This voucher matches the shop sales record.'
    : 'Sale saved. The printed QR opens the public shop page and verifies this voucher.';

  renderVoucherQr(voucherVerifyUrl(sale.voucherCode));
  showModal('voucherDialog');
}

function closeVoucherDialog() {
  currentVoucherSale = null;
  hideModal('voucherDialog');
  if (location.hash.includes('voucher=')) {
    history.replaceState(null, '', location.pathname + location.search);
  }
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[ch]);
}

function printVoucher() {
  const sale = currentVoucherSale;
  if (!sale) return;
  const qr = voucherQrDataUrl();
  const url = voucherVerifyUrl(sale.voucherCode);
  const rows = (sale.items || []).map((item) => `
    <div class="row">
      <span class="name">${item.qty}× ${escapeHtml(item.name)}</span>
      <span>${money(item.price * item.qty)}</span>
    </div>
  `).join('');
  const payment = Number.isFinite(sale.paid)
    ? `<div class="row"><span class="name">Received</span><span>${money(sale.paid)}</span></div>
       <div class="row"><span class="name">Change</span><span>${money(Number.isFinite(sale.change) ? sale.change : Math.max(0, sale.paid - sale.total))}</span></div>`
    : '';

  const win = window.open('', '_blank');
  if (!win) {
    toast('Allow pop-ups to print the voucher');
    return;
  }
  win.document.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(sale.voucherCode)}</title>
  <style>
    @page { margin: 3mm; }
    * { box-sizing: border-box; }
    body { width: 52mm; margin: 0 auto; color: #000; font-family: "Segoe UI", Arial, sans-serif; font-size: 10.5px; }
    .shop { font-size: 17px; font-weight: 800; text-align: center; margin: 2mm 0 1mm; }
    h1 { font-size: 11px; text-align: center; margin: 0 0 2mm; letter-spacing: .5px; text-transform: uppercase; }
    .code { font-family: Consolas, monospace; font-size: 10px; font-weight: 700; text-align: center; word-break: break-all; margin: 1mm 0 2mm; }
    .qr { display: block; width: 38mm; height: 38mm; margin: 1mm auto 2mm; }
    .meta { text-align: center; font-size: 9px; margin: 0 0 2mm; }
    hr { border: 0; border-top: 1px dashed #000; margin: 2mm 0; }
    .row { display: flex; justify-content: space-between; gap: 2mm; margin: 1mm 0; }
    .row .name { flex: 1; }
    .total { display: flex; justify-content: space-between; font-size: 13px; font-weight: 800; margin-top: 2mm; }
    .note { font-size: 8px; text-align: center; margin-top: 2mm; word-break: break-all; }
    .no-print { text-align: center; margin-top: 4mm; }
    @media print { .no-print { display: none; } }
  </style>
</head>
<body>
  <div class="shop">Ma Ngal Lay</div>
  <h1>Purchase Voucher</h1>
  <div class="code">${escapeHtml(sale.voucherCode)}</div>
  ${qr ? `<img class="qr" src="${qr}" alt="Voucher QR">` : ''}
  <div class="meta">${escapeHtml(formatDateTime(sale.createdAt))} · ${Number(sale.count) || 0} item${Number(sale.count) === 1 ? '' : 's'}</div>
  <hr>
  ${rows}
  <hr>
  <div class="total"><span>TOTAL</span><span>${money(sale.total)}</span></div>
  ${payment}
  <div class="note">Scan the QR code to verify this voucher on our public shop page.<br>${escapeHtml(url)}</div>
  <div class="no-print"><button onclick="window.print()">Print again</button></div>
</body>
</html>`);
  win.document.close();
  win.focus();
  win.setTimeout(() => {
    try { win.print(); } catch { /* the Print again button remains available */ }
  }, 400);
}

function openVerifyDialog(prefill = '') {
  const input = $('verifyCodeInput');
  input.value = prefill || '';
  $('verifyError').hidden = true;
  $('verifyError').textContent = '';
  showModal('verifyDialog');
  setTimeout(() => input.focus(), 60);
}

function closeVerifyDialog() {
  hideModal('verifyDialog');
  if (location.hash.includes('voucher=')) {
    history.replaceState(null, '', location.pathname + location.search);
  }
}

async function submitVoucherVerification(event) {
  if (event) event.preventDefault();
  const raw = $('verifyCodeInput').value;
  const sale = findSaleByVoucher(raw);
  const error = $('verifyError');
  if (!sale) {
    error.textContent = cleanVoucherCode(raw)
      ? 'No voucher found with that code. Check it, or try again after cloud sync.'
      : 'Enter the voucher code printed on the voucher.';
    error.hidden = false;
    $('verifyCodeInput').focus();
    return;
  }
  hideModal('verifyDialog');
  const status = await voucherSignatureStatus(sale);
  showVoucher(sale, { mode: 'verify', status });
}

function voucherCodeFromHash() {
  const match = location.hash.match(/[#&]voucher=([^&]+)/i);
  return match ? decodeURIComponent(match[1]) : '';
}

async function handleVoucherHash() {
  const raw = voucherCodeFromHash();
  if (!raw || voucherHashHandled) return;
  const sale = findSaleByVoucher(raw);
  if (sale) {
    voucherHashHandled = true;
    clearTimeout(voucherHashTimer);
    voucherHashTimer = null;
    const status = await voucherSignatureStatus(sale);
    showVoucher(sale, { mode: 'verify', status });
    return;
  }
  if (!voucherHashTimer) {
    voucherHashTimer = setTimeout(() => {
      voucherHashTimer = null;
      if (voucherHashHandled) return;
      voucherHashHandled = true;
      openVerifyDialog(raw);
      const error = $('verifyError');
      error.textContent = 'Voucher not found yet. If cloud sync is on, check again in a moment.';
      error.hidden = false;
    }, 6000);
  }
}

/* ------------------------------------------------------------------ */
/* Checkout                                                            */
/* ------------------------------------------------------------------ */

function checkoutTotal() {
  return cartEntries().reduce((sum, { product, qty }) => sum + product.price * qty, 0);
}

function updateCheckoutChange() {
  const total = checkoutTotal();
  const node = $('checkoutChange');
  const confirm = $('checkoutConfirm');
  const raw = $('checkoutPaid').value.trim();

  if (!raw) {
    node.hidden = true;
    node.classList.remove('short');
    confirm.disabled = false;
    return;
  }

  const paid = parseNumber(raw);
  if (!Number.isFinite(paid)) {
    node.hidden = false;
    node.classList.add('short');
    node.textContent = 'Enter a valid amount';
    confirm.disabled = true;
    return;
  }

  if (paid < total) {
    node.hidden = false;
    node.classList.add('short');
    node.textContent = `Short by ${money(total - paid)}`;
    confirm.disabled = true;
    return;
  }

  node.hidden = false;
  node.classList.remove('short');
  node.textContent = paid > total ? `Change: ${money(paid - total)}` : 'Exact amount';
  confirm.disabled = false;
}

function openCheckoutDialog() {
  const entries = cartEntries();
  if (!entries.length) {
    toast('The bill is empty');
    return;
  }
  const count = entries.reduce((sum, entry) => sum + entry.qty, 0);
  const total = entries.reduce((sum, entry) => sum + entry.product.price * entry.qty, 0);

  $('checkoutSummary').textContent =
    `${count} item${count === 1 ? '' : 's'} · ${entries.length} product${entries.length === 1 ? '' : 's'}`;
  $('checkoutTotal').textContent = money(total);
  const paidInput = $('checkoutPaid');
  paidInput.value = '';
  paidInput.placeholder = `Total ${money(total)}`;
  $('checkoutConfirm').textContent = 'Confirm Purchase';
  updateCheckoutChange();
  showModal('checkoutDialog');
  setTimeout(() => paidInput.focus(), 80);
}

function closeCheckoutDialog() {
  hideModal('checkoutDialog');
}

async function cancelBill() {
  const entries = cartEntries();
  const count = entries.reduce((sum, entry) => sum + entry.qty, 0);
  if (!count) {
    toast('The bill is already empty');
    return;
  }
  const ok = await askConfirm(
    `Discard all ${count} item${count === 1 ? '' : 's'} from this bill? This cannot be undone.`
  );
  if (!ok) return;
  state.cart.clear();
  saveCart();
  renderAll();
  toast('Bill cancelled');
}

async function completeCheckout() {
  const entries = cartEntries();
  if (!entries.length) {
    closeCheckoutDialog();
    toast('The bill is empty');
    return;
  }

  const total = entries.reduce((sum, { product, qty }) => sum + product.price * qty, 0);
  const count = entries.reduce((sum, entry) => sum + entry.qty, 0);
  const paidRaw = $('checkoutPaid').value.trim();
  const paid = paidRaw ? parseNumber(paidRaw) : NaN;

  if (paidRaw && (!Number.isFinite(paid) || paid < total)) {
    updateCheckoutChange();
    toast('Amount received is less than the total');
    return;
  }

  const items = entries.map(({ product, qty }) => ({
    productId: product.id,
    name: product.name,
    price: product.price,
    qty
  }));
  const sale = { id: uid(), items, total, count, createdAt: nowISO() };
  if (Number.isFinite(paid)) {
    sale.paid = paid;
    sale.change = Math.max(0, paid - total);
  }
  await issueVoucher(sale);

  const confirmButton = $('checkoutConfirm');
  const checkoutButton = $('checkoutBtn');
  confirmButton.disabled = true;
  confirmButton.textContent = 'Saving…';
  checkoutButton.disabled = true;

  try {
    state.sales.unshift(sale);
    invalidateRevenue();
    await persistRecord('sales', sale);
    await enqueuePublicVoucher(sale);

    const updatedProducts = [];
    for (const { product, qty } of entries) {
      if (product.stock === null) continue;
      product.stock = Math.max(0, product.stock - qty);
      product.updatedAt = nowISO();
      updatedProducts.push(product);
    }
    for (const product of updatedProducts) {
      await persistRecord('products', product);
      await enqueuePublicCatalog(product);
    }

    await addChange(
      'sale',
      `Sale · ${count} item${count === 1 ? '' : 's'}`,
      items.map((item) => `${item.qty}× ${item.name}`).join(', '),
      { amount: total }
    );
    scheduleFlush();

    state.cart.clear();
    saveCart();
    closeCheckoutDialog();
    renderAll();
    showVoucher(sale, { mode: 'sale', status: sale.voucherSig ? 'signed' : 'record' });
  } catch (err) {
    console.error(err);
    toast('Could not complete the sale — please try again');
  } finally {
    confirmButton.disabled = false;
    confirmButton.textContent = 'Confirm Purchase';
    checkoutButton.disabled = false;
    checkoutButton.textContent = 'Complete Sale';
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
    changes: state.changes,
    costs: state.costs
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
  const costs = normalizeCollection('costs', Array.isArray(payload.costs) ? payload.costs : []);
  const confirmed = await askConfirm(
    `Replace all current data with this backup? ${products.length} product${products.length === 1 ? '' : 's'}, ${sales.length} sale${sales.length === 1 ? '' : 's'} and ${costs.length} cost entr${costs.length === 1 ? 'y' : 'ies'} will be restored.`
  );
  if (!confirmed) return;

  state.products = products;
  state.sales = sales;
  state.changes = changes;
  state.costs = costs;
  invalidateRevenue();
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
  await storeReplace('costs', costs);
  await storeClear('outbox');

  const importChange = {
    id: uid(),
    type: 'import',
    productId: '',
    name: 'Backup restored',
    detail: `${products.length} products · ${sales.length} sales · ${costs.length} costs`,
    createdAt: nowISO()
  };
  state.changes.unshift(importChange);
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
  renderOwnerUI();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ------------------------------------------------------------------ */
/* Event wiring                                                        */
/* ------------------------------------------------------------------ */

function bindEvents() {
  $('loginForm').addEventListener('submit', handleLoginSubmit);
  $('forgotPasswordBtn').addEventListener('click', handleForgotPassword);
  $('changePasswordBtn').addEventListener('click', openPasswordDialog);
  $('signOutBtn').addEventListener('click', signOutOwner);
  $('passwordForm').addEventListener('submit', submitPasswordChange);
  $('passwordCancel').addEventListener('click', closePasswordDialog);
  $('passwordDialog').addEventListener('click', (event) => {
    if (event.target === $('passwordDialog')) closePasswordDialog();
  });

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
  $('checkoutBtn').addEventListener('click', openCheckoutDialog);
  $('checkoutCancel').addEventListener('click', closeCheckoutDialog);
  $('checkoutConfirm').addEventListener('click', completeCheckout);
  $('cancelBillBtn').addEventListener('click', cancelBill);
  $('checkoutPaid').addEventListener('input', updateCheckoutChange);
  $('checkoutPaid').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (!$('checkoutConfirm').disabled) completeCheckout();
    }
  });
  $('voucherCloseBtn').addEventListener('click', closeVoucherDialog);
  $('voucherPrintBtn').addEventListener('click', printVoucher);
  $('verifyVoucherBtn').addEventListener('click', () => openVerifyDialog());
  $('verifyCancel').addEventListener('click', closeVerifyDialog);
  $('verifyForm').addEventListener('submit', submitVoucherVerification);

  $('confirmNo').addEventListener('click', () => closeConfirm(false));
  $('confirmYes').addEventListener('click', () => closeConfirm(true));

  $('ownerSetPinBtn').addEventListener('click', setOwnerPinFlow);
  $('ownerUnlockBtn').addEventListener('click', unlockOwnerFlow);
  $('ownerLockBtn').addEventListener('click', lockOwnerFlow);
  $('ownerChangePinBtn').addEventListener('click', setOwnerPinFlow);
  $('ownerRemovePinBtn').addEventListener('click', removeOwnerPinFlow);
  $('clearSalesBtn').addEventListener('click', clearSalesHistory);
  $('clearChangesBtn').addEventListener('click', clearChangeLog);
  $('pinSubmit').addEventListener('click', submitPinDialog);
  $('pinCancel').addEventListener('click', () => closePinDialog(null));
  $('pinForm').addEventListener('submit', (event) => {
    event.preventDefault();
    submitPinDialog();
  });

  for (const input of [$('pinInput'), $('pinConfirmInput')]) {
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(0, 12);
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submitPinDialog();
      }
    });
  }

  for (const tabButton of document.querySelectorAll('[data-htab]')) {
    tabButton.addEventListener('click', () => {
      state.historyTab = tabButton.dataset.htab;
      for (const button of document.querySelectorAll('[data-htab]')) {
        button.classList.toggle('active', button.dataset.htab === state.historyTab);
      }
      $('history-sales').hidden = state.historyTab !== 'sales';
      $('history-costs').hidden = state.historyTab !== 'costs';
      $('history-changes').hidden = state.historyTab !== 'changes';
      if (state.historyTab === 'costs') renderCosts();
    });
  }

  $('addCostBtn').addEventListener('click', () => openCostEditor());
  $('costSave').addEventListener('click', saveCost);
  $('costCancel').addEventListener('click', closeCostDialog);
  $('costDeleteBtn').addEventListener('click', () => {
    const cost = state.costs.find((row) => row.id === state.editingCostId);
    closeCostDialog();
    if (cost) deleteCostRecord(cost);
  });
  $('costDialog').addEventListener('click', (event) => {
    if (event.target === $('costDialog')) closeCostDialog();
  });

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
  $('checkoutDialog').addEventListener('click', (event) => {
    if (event.target === $('checkoutDialog')) closeCheckoutDialog();
  });
  $('voucherDialog').addEventListener('click', (event) => {
    if (event.target === $('voucherDialog')) closeVoucherDialog();
  });
  $('verifyDialog').addEventListener('click', (event) => {
    if (event.target === $('verifyDialog')) closeVerifyDialog();
  });
  $('pinDialog').addEventListener('click', (event) => {
    if (event.target === $('pinDialog')) closePinDialog(null);
  });
  $('scanModal').addEventListener('click', (event) => {
    if (event.target === $('scanModal')) closeScanner();
  });
  $('imageSearchModal').addEventListener('click', (event) => {
    if (event.target === $('imageSearchModal')) closeImageSearch();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!$('passwordDialog').hidden) closePasswordDialog();
    else if (!$('pinDialog').hidden) closePinDialog(null);
    else if (!$('costDialog').hidden) closeCostDialog();
    else if (!$('voucherDialog').hidden) closeVoucherDialog();
    else if (!$('verifyDialog').hidden) closeVerifyDialog();
    else if (!$('checkoutDialog').hidden) closeCheckoutDialog();
    else if (!$('confirmDialog').hidden) closeConfirm(false);
    else if (!$('scanModal').hidden) closeScanner();
    else if (!$('imageSearchModal').hidden) closeImageSearch();
    else if (!$('productSheet').hidden) closeProductSheet();
  });

  window.addEventListener('hashchange', () => {
    voucherHashHandled = false;
    clearTimeout(voucherHashTimer);
    voucherHashTimer = null;
    handleVoucherHash();
  });

  window.addEventListener('online', () => {
    if (sync.ready && !sync.fatal) {
      updateSyncStatus('connecting', 'Back online — syncing…');
      scheduleFlush();
      updateSyncFromMeta();
    } else if (!sync.ready && firebaseConfigured() && state.authUser) {
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
  redirectLegacyVoucherLink();

  if (firebaseConfigured()) {
    updateSyncStatus('connecting', 'Checking owner sign-in…');
    initAuth();
  } else {
    updateSyncStatus('local', 'Local only — data stays on this device.');
    await unlockOwnerApp(null);
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
