/* Ma Ngal Lay — public shop page
 * Reads only the customer-safe `catalog` collection (no stock quantities)
 * and one voucher document at a time from `vouchers` (get only, no list).
 */

const FB_VERSION = '11.0.1';
const cfg = window.FIREBASE_CONFIG || {};

const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

let db = null;
let fs = null;
let allProducts = [];
let activeCategory = 'all';
let searchTerm = '';
let verifyToken = 0;

const $ = (id) => document.getElementById(id);

function money(value) {
  const n = Number(value);
  return `${numberFormat.format(Number.isFinite(n) ? Math.round(n) : 0)} K`;
}

function formatDateTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function extractCode(value) {
  let raw = String(value || '').trim();
  const urlMatch = raw.match(/[#&?]voucher=([^&\s]+)/i) || raw.match(/^voucher=(.+)$/i);
  if (urlMatch) raw = decodeURIComponent(urlMatch[1]);
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function setStatus(message) {
  const node = $('catalogStatus');
  if (node) node.textContent = message;
}

function renderChips() {
  const wrap = $('categoryChips');
  if (!wrap) return;
  const categories = [...new Set(allProducts.map((product) => product.category).filter(Boolean))]
    .sort((a, b) => String(a).localeCompare(String(b)));
  const values = ['all', ...categories];

  wrap.replaceChildren(...values.map((value) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `chip${value === activeCategory ? ' active' : ''}`;
    button.textContent = value === 'all' ? 'All products' : value;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', value === activeCategory ? 'true' : 'false');
    button.addEventListener('click', () => {
      activeCategory = value;
      renderChips();
      renderProducts();
    });
    return button;
  }));
}

function makeProductCard(product) {
  const card = document.createElement('article');
  card.className = 'product-card';

  const photoWrap = document.createElement('div');
  photoWrap.className = 'product-photo';
  const photo = typeof product.photo === 'string' ? product.photo.trim() : '';
  if (photo && (/^data:image\//i.test(photo) || /^https?:\/\//i.test(photo))) {
    const image = document.createElement('img');
    image.src = photo;
    image.alt = '';
    image.loading = 'lazy';
    image.addEventListener('error', () => {
      image.remove();
      const initial = document.createElement('span');
      initial.className = 'initial';
      initial.textContent = String(product.name || '?').trim().charAt(0).toUpperCase() || '?';
      photoWrap.append(initial);
    });
    photoWrap.append(image);
  } else {
    const initial = document.createElement('span');
    initial.className = 'initial';
    initial.textContent = String(product.name || '?').trim().charAt(0).toUpperCase() || '?';
    photoWrap.append(initial);
  }

  const info = document.createElement('div');
  info.className = 'product-info';

  const name = document.createElement('h3');
  name.textContent = product.name || 'Unnamed product';

  const category = document.createElement('p');
  category.className = 'product-cat';
  category.textContent = product.category || 'Uncategorized';

  const bottom = document.createElement('div');
  bottom.className = 'product-bottom';

  const price = document.createElement('span');
  price.className = 'product-price';
  price.textContent = money(product.price);

  const stock = document.createElement('span');
  const available = product.available !== false;
  stock.className = `stock-pill${available ? '' : ' out'}`;
  stock.textContent = available ? 'Available' : 'Sold out';

  bottom.append(price, stock);
  info.append(name, category, bottom);
  card.append(photoWrap, info);
  return card;
}

function renderProducts() {
  const grid = $('catalogGrid');
  const empty = $('catalogEmpty');
  if (!grid) return;

  const query = searchTerm.trim().toLowerCase();
  const filtered = allProducts.filter((product) => {
    if (activeCategory !== 'all' && product.category !== activeCategory) return false;
    if (!query) return true;
    return `${product.name || ''} ${product.category || ''}`.toLowerCase().includes(query);
  });

  grid.replaceChildren(...filtered.map(makeProductCard));
  const hasAny = allProducts.length > 0;
  if (empty) empty.hidden = filtered.length > 0 || !hasAny;

  if (!hasAny) setStatus('The catalog is being prepared. Please check back soon.');
  else if (!filtered.length) setStatus('No matching products.');
  else setStatus(`${filtered.length} product${filtered.length === 1 ? '' : 's'} shown`);
}

function bindCatalogControls() {
  const input = $('catalogSearch');
  const clear = $('catalogClear');
  if (input) {
    input.addEventListener('input', () => {
      searchTerm = input.value;
      if (clear) clear.hidden = !searchTerm;
      renderProducts();
    });
  }
  if (clear) {
    clear.addEventListener('click', () => {
      searchTerm = '';
      if (input) {
        input.value = '';
        input.focus();
      }
      clear.hidden = true;
      renderProducts();
    });
  }
}

function listenCatalog() {
  fs.onSnapshot(
    fs.collection(db, 'catalog'),
    (snapshot) => {
      allProducts = snapshot.docs
        .map((entry) => ({ id: entry.id, ...entry.data() }))
        .sort((a, b) => {
          const categoryCompare = String(a.category || '').localeCompare(String(b.category || ''));
          if (categoryCompare) return categoryCompare;
          return String(a.name || '').localeCompare(String(b.name || ''));
        });
      renderChips();
      renderProducts();
    },
    (err) => {
      console.warn('[public] catalog unavailable', err);
      setStatus('The catalog is temporarily unavailable. Please try again later.');
    }
  );
}

/* ------------------------------------------------------------------ */
/* Voucher verification                                                */
/* ------------------------------------------------------------------ */

function setVerifyBusy(busy) {
  const button = $('verifySubmit');
  if (!button) return;
  button.disabled = busy;
  button.textContent = busy ? 'Checking…' : 'Verify voucher';
}

function clearVerifyResult() {
  const error = $('verifyError');
  if (error) {
    error.hidden = true;
    error.textContent = '';
  }
  const result = $('verifyResult');
  if (result) result.hidden = true;
}

function renderVoucher(data, fallbackCode) {
  const result = $('verifyResult');
  if (!result) return;

  $('resultCode').textContent = data.code || fallbackCode || '';
  const count = Number(data.count) || 0;
  const when = formatDateTime(data.createdAt);
  $('resultMeta').textContent = [when, `${count} item${count === 1 ? '' : 's'}`]
    .filter(Boolean)
    .join(' · ');

  const lines = (Array.isArray(data.items) ? data.items : []).map((item) => {
    const row = document.createElement('div');
    row.className = 'result-line';
    const label = document.createElement('span');
    label.textContent = `${Number(item.qty) || 0}× ${item.name || 'Item'}`;
    const amount = document.createElement('span');
    amount.textContent = money((Number(item.qty) || 0) * (Number(item.price) || 0));
    row.append(label, amount);
    return row;
  });
  $('resultLines').replaceChildren(...lines);
  $('resultTotal').textContent = money(data.total);

  result.hidden = false;
}

async function verifyVoucher(raw) {
  const error = $('verifyError');
  clearVerifyResult();
  const code = extractCode(raw);
  if (!code) {
    if (error) {
      error.textContent = 'Enter the voucher code printed on the voucher.';
      error.hidden = false;
    }
    return;
  }
  if (!db || !fs) {
    if (error) {
      error.textContent = 'Voucher verification is not available right now.';
      error.hidden = false;
    }
    return;
  }

  const token = ++verifyToken;
  setVerifyBusy(true);
  try {
    const snapshot = await fs.getDoc(fs.doc(db, 'vouchers', code));
    if (token !== verifyToken) return;
    if (!snapshot.exists()) {
      error.textContent = 'No voucher found with that code. Check the code and try again.';
      error.hidden = false;
      return;
    }
    renderVoucher(snapshot.data() || {}, code);
  } catch (err) {
    if (token !== verifyToken) return;
    console.warn('[public] voucher lookup failed', err);
    error.textContent = navigator.onLine
      ? 'Could not check that voucher right now. Please try again.'
      : 'You need an internet connection to verify a voucher.';
    error.hidden = false;
  } finally {
    if (token === verifyToken) setVerifyBusy(false);
  }
}

function openVerify(prefill = '') {
  const modal = $('verifyModal');
  if (!modal) return;
  clearVerifyResult();
  modal.hidden = false;
  const input = $('voucherInput');
  if (input && prefill) input.value = prefill;
  setTimeout(() => input && input.focus(), 80);
  if (prefill) verifyVoucher(prefill);
}

function closeVerify() {
  const modal = $('verifyModal');
  if (modal) modal.hidden = true;
  verifyToken += 1;
  if (location.hash.includes('voucher=')) {
    history.replaceState(null, '', location.pathname + location.search);
  }
}

function readHashCode() {
  const hash = location.hash.replace(/^#/, '');
  if (!hash) return '';
  try {
    const params = new URLSearchParams(hash);
    return params.get('voucher') || '';
  } catch {
    return '';
  }
}

function bindVerifyControls() {
  $('openVerifyBtn').addEventListener('click', () => openVerify(''));
  $('closeVerifyBtn').addEventListener('click', closeVerify);
  $('verifyModal').addEventListener('click', (event) => {
    if (event.target === $('verifyModal')) closeVerify();
  });
  $('verifyForm').addEventListener('submit', (event) => {
    event.preventDefault();
    verifyVoucher($('voucherInput').value);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('verifyModal').hidden) closeVerify();
  });
  window.addEventListener('hashchange', () => {
    const code = readHashCode();
    if (code) openVerify(code);
  });
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function init() {
  bindCatalogControls();
  bindVerifyControls();

  if (typeof cfg.apiKey !== 'string' || cfg.apiKey.length < 20 || !cfg.projectId) {
    setStatus('The catalog is not configured yet.');
    return;
  }

  try {
    const base = `https://www.gstatic.com/firebasejs/${FB_VERSION}/`;
    const [appModule, firestoreModule] = await Promise.all([
      import(`${base}firebase-app.js`),
      import(`${base}firebase-firestore.js`)
    ]);
    const app = appModule.getApps().length ? appModule.getApp() : appModule.initializeApp(cfg);
    db = firestoreModule.getFirestore(app);
    fs = firestoreModule;
    if (cfg.useEmulators) {
      try {
        firestoreModule.connectFirestoreEmulator(db, '127.0.0.1', 8080);
      } catch (emulatorError) {
        console.warn('[public] could not connect to the Firestore emulator', emulatorError);
      }
    }
    listenCatalog();
  } catch (err) {
    console.warn('[public] Firebase failed to start', err);
    setStatus('The catalog is temporarily unavailable. Check your connection and reload.');
    return;
  }

  const hashCode = readHashCode();
  if (hashCode) openVerify(hashCode);
}

init();
