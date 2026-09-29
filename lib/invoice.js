/**
 * The invoice itself: reading the catalog, the price maths, and turning a
 * Tracker row into the numbers that go on the PDF.
 *
 * THE MATHS, copied from the Templates tab (taxRate is per country;
 * 1 means no tax and every division below does nothing)
 *   Product list prices include tax.
 *   Unit price on the invoice = list price / taxRate
 *   Discount (Tracker, tax-inclusive, in the country's currency) is shown
 *   as -discount / taxRate
 *   SUB-TOTAL = sum of the amounts, GST = SUB-TOTAL x (taxRate - 1),
 *   GRAND TOTAL = SUB-TOTAL + GST
 *   Nothing is rounded until it is printed, exactly like the sheet. So the
 *   grand total always equals the list prices minus the discount.
 */
import { CONFIG } from './config.js';
import { parseCountries, countryFor } from './countries.js';
import { readTables, headerIndex, normKey, toDate } from './sheets.js';


/* Catalog ----------------------------------------------------------------- */

let cache = null;             // { at, value }
const CACHE_MS = 60_000;

/** Products and customers, cached for a minute per server instance. */
export async function loadCatalog(fresh = false) {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value;

  const value = catalogFromTables(await readTables([CONFIG.PRODUCTS_SHEET, CONFIG.CUSTOMERS_SHEET, CONFIG.COUNTRIES_SHEET]));
  cache = { at: Date.now(), value };
  return value;
}

export function catalogFromTables(t) {
  const countries = parseCountries(t[CONFIG.COUNTRIES_SHEET]);
  return {
    countries,
    products: parseProducts(t[CONFIG.PRODUCTS_SHEET], countries),
    customers: parseCustomers(t[CONFIG.CUSTOMERS_SHEET], countries),
    customersTable: t[CONFIG.CUSTOMERS_SHEET]
  };
}

export function clearCatalogCache() { cache = null; }


function parseProducts(table, countries) {
  if (!table) throw new Error(`The sheet has no "${CONFIG.PRODUCTS_SHEET}" tab.`);
  const P = CONFIG.PRODUCTS;
  const ni = headerIndex(table.headers, P.name);
  const ci = headerIndex(table.headers, P.code);
  if (ni < 0) throw new Error(`"${CONFIG.PRODUCTS_SHEET}" has no "${P.name}" column.`);
  const priceCols = countries.map((c) => [c.code, headerIndex(table.headers, c.priceColumn)]);

  return table.rows.map((r) => {
    const prices = {};
    priceCols.forEach(([code, i]) => { prices[code] = i >= 0 ? toNumber(r[i]) : null; });
    return { name: String(r[ni]).trim(), code: ci >= 0 ? String(r[ci]).trim() : '', prices };
  }).filter((p) => p.name);
}


function parseCustomers(table, countries) {
  if (!table) return [];
  const C = CONFIG.CUSTOMERS;
  const h = table.headers;
  const idx = {
    id: headerIndex(h, C.id), name: headerIndex(h, C.name), address: headerIndex(h, C.address),
    email: headerIndex(h, C.email), terms: headerIndex(h, C.terms), margin: headerIndex(h, C.margin),
    country: headerIndex(h, C.country)
  };
  const get = (r, k) => (idx[k] >= 0 ? String(r[idx[k]]).trim() : '');

  return table.rows.map((r) => ({
    row: r._row,
    id: get(r, 'id'),
    name: get(r, 'name'),
    address: get(r, 'address'),
    email: get(r, 'email'),
    terms: get(r, 'terms'),
    country: get(r, 'country') ? countryFor(countries, get(r, 'country')).code : '',
    margin: toMargin(idx.margin >= 0 ? r[idx.margin] : '')
  })).filter((c) => c.name);
}


export function findCustomer(customers, name) {
  const want = normKey(name);
  if (!want) return null;
  return customers.find((c) => normKey(c.id) === want) ||
         customers.find((c) => normKey(c.name) === want) || null;
}

export function findProduct(products, { name, code }) {
  if (code) {
    const c = normKey(code);
    const byCode = products.find((p) => p.code && normKey(p.code) === c);
    if (byCode) return byCode;
  }
  const n = normKey(name);
  return products.find((p) => normKey(p.name) === n) || null;
}


/* Numbers ----------------------------------------------------------------- */

export function toNumber(v) {
  if (v === '' || v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? null : n;
}

/** 20, "20%" and 0.2 all mean 0.2. 100% or more is a typo, not a deal. */
export function toMargin(v) {
  let n = toNumber(v);
  if (!n || n <= 0) return 0;
  if (n > 1) n = n / 100;
  return n >= 1 ? 0 : n;
}

export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** The customer's margin as a GST-inclusive dollar discount, like the old bot. */
export function marginDiscount(items, margin) {
  if (!margin) return 0;
  const gross = items.reduce((s, it) => s + (it.price || 0) * it.qty, 0);
  return round2(gross * margin);
}


/* Products column --------------------------------------------------------- */

/** One Tracker line per item, in the format the Templates tab expects. */
export function productsText(items) {
  return items.map((it) => {
    let line = CONFIG.PRODUCT_LINE_FORMAT
      .replace(/\{\{\s*name\s*\}\}/g, it.name)
      .replace(/\{\{\s*code\s*\}\}/g, it.code || '')
      .replace(/\{\{\s*qty\s*\}\}/g, String(it.qty));
    if (!it.code) line = line.replace(/\s*\(\s*\)/g, '');
    return line.trim();
  }).join('\n');
}

/**
 * Reads the Products column back. Accepts what this app writes
 * ("Name (code) x 2") and the looser forms people type by hand
 * ("Name x 2", "2 x Name", or just "Name").
 */
export function parseProductsText(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
    let m = line.match(/^(.*\S)\s+[x×*]\s*(\d+(?:\.\d+)?)$/i);
    let name = line, qty = 1;
    if (m) { name = m[1]; qty = parseFloat(m[2]); }
    else if ((m = line.match(/^(\d+(?:\.\d+)?)\s*[x×*]\s+(.+)$/i))) { qty = parseFloat(m[1]); name = m[2]; }

    let code = '';
    const c = name.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
    if (c) { name = c[1]; code = c[2].trim(); }
    return { name: name.trim(), code, qty };
  });
}


/* Totals ------------------------------------------------------------------ */

/**
 * items: [{ name, qty, price }] with GST-inclusive list prices (price may be
 * null when the product is not on the list). discount: GST-inclusive dollars.
 */
export function computeInvoice(items, discount, taxRate = 1) {
  const lines = items.map((it) => {
    const unit = it.price == null ? null : it.price / taxRate;
    return { description: it.name, qty: it.qty, unit, amount: unit == null ? null : unit * it.qty };
  });
  const d = toNumber(discount) || 0;
  if (d) lines.push({ description: 'Discount', qty: null, unit: null, amount: -d / taxRate, isDiscount: true });

  const subtotal = lines.reduce((s, l) => s + (l.amount || 0), 0);
  const gst = subtotal * (taxRate - 1);
  return { lines, subtotal, gst, total: subtotal + gst };
}


/* A Tracker row, ready to print ------------------------------------------- */

/** Everything the PDF needs for one invoice, read from its Tracker row. */
export async function loadInvoice(invoiceId) {
  const t = await readTables([CONFIG.TRACKER_SHEET, CONFIG.PRODUCTS_SHEET, CONFIG.COUNTRIES_SHEET]);
  const tracker = t[CONFIG.TRACKER_SHEET];
  if (!tracker) throw new Error(`The sheet has no "${CONFIG.TRACKER_SHEET}" tab.`);

  const T = CONFIG.TRACKER;
  const h = tracker.headers;
  const col = (k) => headerIndex(h, T[k]);
  if (col('invoiceId') < 0) throw new Error(`The Tracker has no "${T.invoiceId}" column.`);

  const row = tracker.rows.find((r) => normKey(r[col('invoiceId')]) === normKey(invoiceId));
  if (!row) throw new Error(`No Tracker row with ${T.invoiceId} ${invoiceId}.`);
  const get = (k) => (col(k) >= 0 ? row[col(k)] : '');

  const countries = parseCountries(t[CONFIG.COUNTRIES_SHEET]);
  const country = countryFor(countries, get('country'), get('invoiceId'));
  const products = parseProducts(t[CONFIG.PRODUCTS_SHEET], countries);
  const missing = [];
  const items = parseProductsText(get('products')).map((it) => {
    const p = findProduct(products, it);
    const price = p ? p.prices[country.code] : null;
    if (price == null) missing.push(it.name);
    return { name: p ? p.name : it.name, code: it.code, qty: it.qty, price };
  });
  if (items.length > CONFIG.MAX_ITEMS) {
    throw new Error(`Invoice ${invoiceId} has ${items.length} items; the layout fits ${CONFIG.MAX_ITEMS}.`);
  }

  const calc = computeInvoice(items, get('discount'), country.taxRate);
  return {
    country,
    row: row._row,
    headers: h,
    invoiceId: String(get('invoiceId')),
    docType: String(get('docType') || CONFIG.DOC_TYPES[0]),
    date: toDate(get('date')) || new Date(),
    customer: String(get('customer') || ''),
    address: String(get('address') || ''),
    email: String(get('email') || ''),
    po: String(get('po') || ''),
    terms: String(get('terms') || ''),
    status: String(get('status') || ''),
    items, missing, ...calc
  };
}


export function fileName(inv) {
  return CONFIG.FILE_NAME_PATTERN
    .replace('{{docType}}', inv.docType)
    .replace('{{invoiceId}}', inv.invoiceId)
    .replace('{{customer}}', inv.customer)
    .replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() + '.pdf';
}

export function money(n) {
  return round2(Math.abs(n)).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** "$1,234.00" for Singapore, "HKD 1,234.00" elsewhere. Negative gets a minus. */
export function price(country, n) {
  return (n < 0 ? '-' : '') + country.symbol + money(n);
}


/* Invoice numbers ----------------------------------------------------------- */

/**
 * 'TC' + country prefix + date + the day's count: TC2026092901, TCHK26092901.
 * The count is the highest already on the Tracker for that prefix and day,
 * plus one.
 */
export function nextInvoiceId(existingIds, country, date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: CONFIG.TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date).map((x) => [x.type, x.value]));
  const day = country.idDate === 'yyyymmdd' ? p.year + p.month + p.day : p.year.slice(-2) + p.month + p.day;
  const stem = 'TC' + country.idPrefix + day;

  let max = 0;
  existingIds.forEach((id) => {
    const s = String(id).trim();
    if (!s.startsWith(stem)) return;
    const rest = s.slice(stem.length);
    if (/^\d+$/.test(rest)) max = Math.max(max, parseInt(rest, 10));
  });
  return stem + String(max + 1).padStart(CONFIG.INVOICE_SEQ_PAD, '0');
}
