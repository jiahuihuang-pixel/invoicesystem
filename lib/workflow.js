/**
 * Submit -> notify you with the PDF -> you approve -> it goes back to the
 * requester's group. Proformas can later be converted into tax invoices.
 *
 * Everything is kept on the Tracker tab, one row per request. The Telegram
 * details (who asked, which group, the file) sit in their own columns,
 * which the app adds if they are missing. Requests made before this lived
 * on the old Bot Requests tab, which is still read for them.
 */
import { CONFIG, adminIds, appUrl } from './config.js';
import { countryByCode, countryFor, parseCountries } from './countries.js';
import {
  readTables, readTable, appendRecord, updateRecord, ensureSheet, ensureColumns, headerIndex, normKey,
  sheetDateTime, toDate
} from './sheets.js';
import {
  loadCatalog, catalogFromTables, clearCatalogCache, findCustomer, findProduct, marginDiscount,
  productsText, parseProductsText, loadInvoice, fileName, price, toNumber, round2, nextInvoiceId
} from './invoice.js';
import { renderInvoicePdf } from './pdf.js';
import { driveConfigured, savePdf } from './drive.js';
import { send, sendDocument, kb, btn, esc, displayName, mention, sign, httpError } from './telegram.js';

const CHAT_HEADERS = ['Chat ID', 'Title', 'Added At'];
const T = CONFIG.TRACKER;
const S = CONFIG.STATUS;
const PROFORMA = 'Proforma Invoice';

const now = (withTime = true) => sheetDateTime(new Date(), CONFIG.TIME_ZONE, withTime);


/* Tracker columns ------------------------------------------------------------ */

/** Every column the app writes, including the per-type link columns. */
function autoColumns() {
  return [...CONFIG.AUTO_COLUMNS.map((k) => T[k]), ...Object.values(CONFIG.LINK_COLUMNS)];
}

/** The Tracker, with any missing app columns added. */
async function trackerTable(tables) {
  const t = tables ? tables[CONFIG.TRACKER_SHEET] : await readTable(CONFIG.TRACKER_SHEET);
  if (!t) throw new Error(`The sheet has no "${CONFIG.TRACKER_SHEET}" tab.`);
  if (headerIndex(t.headers, T.invoiceId) < 0) throw new Error(`The Tracker has no "${T.invoiceId}" column.`);
  t.headers = await ensureColumns(CONFIG.TRACKER_SHEET, t.headers, autoColumns());
  return t;
}

export async function ensureTrackerColumns() {
  return (await trackerTable()).headers;
}

/** Every number in use, including converted proformas' old numbers. */
function usedIds(tracker) {
  const ids = [];
  [T.invoiceId, T.proformaNo].forEach((h) => {
    const i = headerIndex(tracker.headers, h);
    if (i >= 0) tracker.rows.forEach((r) => { if (r[i] != null && r[i] !== '') ids.push(r[i]); });
  });
  return ids;
}

const linkColumn = (docType) => CONFIG.LINK_COLUMNS[docType] || CONFIG.LINK_COLUMNS.Invoice;


/* Requests (Tracker rows) ----------------------------------------------------- */

/**
 * The request for an invoice number. Also finds a converted proforma by its
 * old number, flagged with `convertedTo`.
 */
export async function findRequest(invoiceId) {
  const t = await trackerTable();
  const h = t.headers;
  // Rows read before ensureColumns() are shorter than the new header: ?? ''
  const at = (r, k) => { const i = headerIndex(h, T[k]); return i >= 0 ? r[i] ?? '' : ''; };

  let r = t.rows.find((row) => normKey(at(row, 'invoiceId')) === normKey(invoiceId));
  let convertedTo = '';
  if (!r) {
    r = t.rows.find((row) => at(row, 'proformaNo') !== '' && normKey(at(row, 'proformaNo')) === normKey(invoiceId));
    if (r) convertedTo = String(at(r, 'invoiceId'));
  }
  if (!r) return null;

  const req = {
    row: r._row, headers: h, convertedTo,
    invoiceId: String(at(r, 'invoiceId')),
    status: String(at(r, 'status')),
    docType: String(at(r, 'docType') || CONFIG.DOC_TYPES[0]),
    customer: String(at(r, 'customer')),
    country: String(at(r, 'country')),
    date: at(r, 'date'),
    items: parseProductsText(at(r, 'products')).map((it) => `${it.qty} × ${it.name}`).join('\n'),
    requestedBy: String(at(r, 'requestedBy')),
    requesterId: String(at(r, 'requesterId')),
    chatId: String(at(r, 'chatId')),
    chatTitle: String(at(r, 'chatTitle')),
    fileId: String(at(r, 'fileId')),
    proformaNo: String(at(r, 'proformaNo')),
    // What is in each link column now (a Drive link gets replaced on Regenerate)
    links: Object.fromEntries(Object.values(CONFIG.LINK_COLUMNS).map((c) => {
      const i = headerIndex(h, c);
      return [c, i >= 0 ? String(r[i] ?? '') : ''];
    }))
  };

  // Made before the Tracker kept the Telegram details: take them from the
  // old Bot Requests tab once, and copy them across.
  if (!req.chatId) {
    const old = await readTable(CONFIG.REQUESTS_SHEET).catch(() => null);
    const o = old && old.rows.find((row) => normKey(row[headerIndex(old.headers, 'Invoice ID')]) === normKey(req.invoiceId));
    if (o) {
      const g = (name) => { const i = headerIndex(old.headers, name); return i >= 0 ? String(o[i]) : ''; };
      Object.assign(req, { requesterId: g('Requester ID'), chatId: g('Chat ID'), chatTitle: g('Chat Title'),
                           fileId: req.fileId || g('Telegram File ID'), requestedBy: req.requestedBy || g('Requested By') });
      await updateRecord(CONFIG.TRACKER_SHEET, h, req.row, {
        [T.requesterId]: req.requesterId, [T.chatId]: req.chatId, [T.chatTitle]: req.chatTitle, [T.fileId]: req.fileId
      });
    }
  }
  return req;
}

/**
 * Bot requests still waiting on you. A row counts as a bot request when it
 * has a Chat ID, or when the old Bot Requests tab knows it.
 */
export async function listOpenRequests() {
  const t = await trackerTable();
  const at = (r, k) => { const i = headerIndex(t.headers, T[k]); return i >= 0 ? r[i] ?? '' : ''; };
  const old = await readTable(CONFIG.REQUESTS_SHEET).catch(() => null);
  const legacy = new Set(old ? old.rows.map((r) => normKey(r[headerIndex(old.headers, 'Invoice ID')])) : []);
  const open = [normKey(S.pending), normKey(S.generated)];
  return t.rows
    .filter((r) => open.includes(normKey(at(r, 'status'))) &&
                   (String(at(r, 'chatId')).trim() || legacy.has(normKey(at(r, 'invoiceId')))))
    .map((r) => String(at(r, 'invoiceId')));
}

function setRow(req, record) {
  return updateRecord(CONFIG.TRACKER_SHEET, req.headers, req.row, record);
}

export function isClosed(req) {
  return !!req.convertedTo || [normKey(S.sent), normKey(S.rejected)].includes(normKey(req.status));
}


/* Groups the bot is in ------------------------------------------------------ */

export async function rememberChat(chat) {
  if (!chat || chat.type === 'private') return;
  await ensureSheet(CONFIG.CHATS_SHEET, CHAT_HEADERS);
  const t = await readTable(CONFIG.CHATS_SHEET);
  const r = t.rows.find((row) => String(row[0]) === String(chat.id));
  const title = chat.title || String(chat.id);
  if (!r) await appendRecord(CONFIG.CHATS_SHEET, t.headers, { 'Chat ID': String(chat.id), 'Title': title, 'Added At': now() });
  else if (r[1] !== title) await updateRecord(CONFIG.CHATS_SHEET, t.headers, r._row, { 'Title': title });
}

export async function forgetChat(chatId) {
  const t = await readTable(CONFIG.CHATS_SHEET);
  const r = t && t.rows.find((row) => String(row[0]) === String(chatId));
  if (r) await updateRecord(CONFIG.CHATS_SHEET, t.headers, r._row, { 'Title': '(bot removed)' });
}

export async function knownChats() {
  const t = await readTable(CONFIG.CHATS_SHEET);
  if (!t) return [];
  return t.rows.filter((r) => r[0] && r[1] !== '(bot removed)')
    .map((r) => ({ id: String(r[0]), title: String(r[1]) }));
}


/* The form's data ---------------------------------------------------------- */

export async function catalogForForm() {
  const { countries, products, customers } = await loadCatalog();
  return {
    countries: countries.map(({ code, name, flag, currency, taxRate, ready }) => ({ code, name, flag, currency, taxRate, ready })),
    products: products.map(({ name, code, prices }) => ({ name, code, prices })),
    customers: customers.map(({ name, address, email, terms, margin, country }) => ({ name, address, email, terms, margin, country })),
    docTypes: CONFIG.DOC_TYPES,
    terms: CONFIG.TERMS,
    maxItems: CONFIG.MAX_ITEMS
  };
}


/* Submit ------------------------------------------------------------------- */

/**
 * Validates the form against the sheet (prices and codes always come from
 * the Product list, never from the phone), writes the Tracker row and
 * returns the new request. PDF + notification happen afterwards in
 * notifyAdmins().
 */
export async function submitRequest(form, user, target) {
  const customerName = String(form.customer && form.customer.name || '').trim();
  if (!customerName) throw httpError(400, 'Customer name is missing.');

  // One round trip to Google for everything below
  const tables = await readTables([CONFIG.TRACKER_SHEET, CONFIG.PRODUCTS_SHEET,
                                   CONFIG.CUSTOMERS_SHEET, CONFIG.COUNTRIES_SHEET]);
  const { countries, products, customers, customersTable } = catalogFromTables(tables);

  const country = countryByCode(countries, form.country);
  if (!country) throw httpError(400, 'Choose a country first.');
  if (!country.ready) throw httpError(400, `${country.name} invoices are not set up yet.`);

  const items = [];
  for (const it of form.items || []) {
    const qty = Math.round(Number(it.qty));
    if (!(qty > 0)) continue;
    const p = findProduct(products, it);
    if (!p) throw httpError(400, `"${it.name}" is not on the Product list any more.`);
    const same = items.find((x) => x.name === p.name);
    if (same) same.qty += qty; else items.push({ name: p.name, code: p.code, price: p.prices[country.code], qty });
  }
  if (!items.length) throw httpError(400, 'Add at least one item.');
  if (items.length > CONFIG.MAX_ITEMS) throw httpError(400, `At most ${CONFIG.MAX_ITEMS} different items fit on one invoice.`);

  const existing = findCustomer(customers, customerName);
  const margin = existing ? existing.margin : 0;
  const address = String(form.customer.address || '').trim();
  const email = String(form.customer.email || '').trim();

  // Discount: whatever was typed, else the customer's margin as dollars.
  let discount = toNumber(form.discount);
  if (form.discountMode !== 'manual' || discount == null) discount = marginDiscount(items, margin) || null;
  if (discount != null) discount = round2(Math.max(0, discount));

  const docType = CONFIG.DOC_TYPES.includes(form.docType) ? form.docType : CONFIG.DOC_TYPES[0];
  const terms = String(form.terms || '').trim() || (existing && existing.terms) || CONFIG.TERMS[0];

  const tracker = await trackerTable(tables);
  const invoiceId = nextInvoiceId(usedIds(tracker), country);
  const requestedBy = displayName(user);
  await appendRecord(CONFIG.TRACKER_SHEET, tracker.headers, {
    [T.invoiceId]: invoiceId,
    [T.date]: now(false),
    [T.country]: country.name,
    [T.customer]: existing ? existing.name : customerName,
    [T.address]: address,
    [T.email]: email,
    [T.po]: String(form.po || '').trim(),
    [T.terms]: terms,
    [T.docType]: docType,
    [T.discount]: discount == null ? '' : discount,
    [T.products]: productsText(items),
    [T.requestedBy]: requestedBy,
    [T.status]: S.pending,
    [T.requesterId]: String(user.id),
    [T.chatId]: String(target.id),
    [T.chatTitle]: target.title
  });

  await saveCustomer(customersTable, existing, { name: customerName, address, email, terms, country: country.name });

  return { invoiceId: String(invoiceId), customer: existing ? existing.name : customerName, margin, discount };
}


/**
 * New customers get a record; existing ones only have blank cells filled.
 * A one-off change on a single order never overwrites the master record.
 */
async function saveCustomer(table, existing, c) {
  if (!table) return;
  const C = CONFIG.CUSTOMERS;
  const h = table.headers;
  const col = (names) => { const i = headerIndex(h, names); return i >= 0 ? h[i] : null; };

  if (existing) {
    const fill = {};
    if (!existing.address && c.address && col(C.address)) fill[col(C.address)] = c.address;
    if (!existing.email && c.email && col(C.email)) fill[col(C.email)] = c.email;
    if (!existing.terms && c.terms && col(C.terms)) fill[col(C.terms)] = c.terms;
    if (!existing.country && c.country && col(C.country)) fill[col(C.country)] = c.country;
    if (Object.keys(fill).length) {
      if (col(C.updatedAt)) fill[col(C.updatedAt)] = now();
      await updateRecord(CONFIG.CUSTOMERS_SHEET, h, existing.row, fill);
    }
    return;
  }

  let max = 0;
  const ii = headerIndex(h, C.id);
  if (ii >= 0) table.rows.forEach((r) => {
    const m = String(r[ii]).match(/(\d+)\s*$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });

  const rec = { [C.name]: c.name };
  if (ii >= 0) rec[C.id] = C.idPrefix + String(max + 1).padStart(C.idPad, '0');
  if (col(C.address)) rec[col(C.address)] = c.address;
  if (col(C.email)) rec[col(C.email)] = c.email;
  if (col(C.terms)) rec[col(C.terms)] = c.terms;
  if (col(C.country)) rec[col(C.country)] = c.country;
  if (col(C.createdAt)) rec[col(C.createdAt)] = now();
  if (col(C.updatedAt)) rec[col(C.updatedAt)] = now();
  await appendRecord(CONFIG.CUSTOMERS_SHEET, h, rec);
  clearCatalogCache();
}


/* PDF + your approval -------------------------------------------------------- */

export function pdfLink(invoiceId) {
  return `${appUrl()}/api/pdf?id=${encodeURIComponent(invoiceId)}&s=${sign('pdf:' + invoiceId, 16)}`;
}

export const adminButtons = (id) => kb([
  [btn('✅ Approve — send it', `a:ok:${id}`)],
  [btn('🔁 Regenerate', `a:gen:${id}`), btn('❌ Reject', `a:no:${id}`)]
]);

/** Under a proforma in the group: anyone there can ask for the tax invoice. */
const convertButton = (id) => kb([[btn('🧾 Convert to tax invoice', `c:req:${id}`)]]);

/**
 * The link for the Tracker: the file in Google Drive when Drive is set up,
 * otherwise (or if saving fails, which you are told about) the app's own
 * PDF link.
 */
async function storePdf(pdf, inv, existingLink) {
  if (!driveConfigured()) return pdfLink(inv.invoiceId);
  try {
    return await savePdf(pdf, fileName(inv), inv.country.name, inv.docType, existingLink);
  } catch (e) {
    console.error(e);
    for (const id of adminIds()) {
      await send(id, `⚠️ #${esc(inv.invoiceId)} was not saved to Google Drive: ${esc(e.message)}
` +
                     'The Tracker has the app\'s own PDF link instead. Tap Regenerate to try Drive again.').catch(() => {});
    }
    return pdfLink(inv.invoiceId);
  }
}

function caption(inv, heading, footer) {
  const lines = [
    heading,
    '',
    `${inv.country.flag} <b>${esc(inv.customer)}</b>`,
    ...inv.items.map((it) => `• ${it.qty} × ${esc(it.name)}`),
    inv.lines.some((l) => l.isDiscount)
      ? `• Discount ${price(inv.country, -inv.lines.find((l) => l.isDiscount).amount * inv.country.taxRate)}` : '',
    '',
    `Total <b>${price(inv.country, inv.total)}</b>` + (inv.country.taxRate > 1 ? ` incl. ${esc(inv.country.taxName)}` : ''),
    footer
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '');
  if (inv.missing.length) lines.push('', `⚠️ Not on the Product list, no price: ${inv.missing.map(esc).join(', ')}`);
  const s = lines.join('\n');
  return s.length > 1000 ? s.slice(0, 990) + '…' : s;
}

/**
 * Builds the PDF from the Tracker row and sends it to every admin with the
 * approve buttons. Used for new requests and for Regenerate, so a fix made
 * on the Tracker row shows up in the next PDF.
 */
export async function generateAndOffer(invoiceId, chatIds = adminIds(), heading = '') {
  const req = await findRequest(invoiceId);
  if (!req) throw new Error(`Unknown request #${invoiceId}`);
  const inv = await loadInvoice(invoiceId);
  const pdf = await renderInvoicePdf(inv);
  const text = caption(inv, heading || `🧾 <b>${esc(inv.docType)} #${esc(inv.invoiceId)}</b> (regenerated)`,
                       `From ${esc(req.requestedBy)} for <b>${esc(req.chatTitle)}</b>`);

  let fileId = '';
  for (const chatId of chatIds) {
    try {
      const msg = await sendDocument(chatId, fileId || pdf, fileName(inv), text, adminButtons(invoiceId));
      if (!fileId && msg.document) fileId = msg.document.file_id;
    } catch (e) {
      console.warn(`Could not send #${invoiceId} to ${chatId}: ${e.message}`);
    }
  }
  if (!fileId) throw new Error('The PDF was made but could not be sent to any admin. Have you pressed Start on the bot?');

  // Drive after Telegram, so saving never delays the PDF reaching you
  const col = linkColumn(inv.docType);
  const link = await storePdf(pdf, inv, req.links[col]);
  await setRow(req, {
    [T.status]: S.generated, [T.generatedAt]: now(), [T.fileId]: fileId, [col]: link
  });
  return { inv, fileId };
}

/** Straight after submit. If the PDF fails you still hear about the request. */
export async function notifyAdmins(invoiceId, user) {
  const heading = `🆕 <b>New request #${esc(invoiceId)}</b>`;
  try {
    await generateAndOffer(invoiceId, adminIds(), heading);
  } catch (e) {
    console.error(e);
    for (const id of adminIds()) {
      await send(id, `${heading} from ${esc(displayName(user))}\n\n⚠️ The PDF could not be made: ${esc(e.message)}\n` +
                     'Fix that (usually the Tracker row or Product list), then tap Regenerate.',
                 { reply_markup: adminButtons(invoiceId) }).catch(() => {});
    }
  }
}

const requester = (req) => (req.requesterId ? mention({ id: req.requesterId }, req.requestedBy) : esc(req.requestedBy));

export async function approve(invoiceId) {
  const req = await findRequest(invoiceId);
  if (!req) throw new Error(`Unknown request #${invoiceId}`);
  if (!req.fileId) throw new Error('Generate the PDF first.');
  const isProforma = req.docType === PROFORMA;
  await sendDocument(req.chatId, req.fileId, null,
    `🧾 <b>#${esc(invoiceId)}</b> — ${esc(req.customer)}\nRequested by ${requester(req)}` +
    (isProforma ? '\n\nWhen it is paid, tap below to turn it into a tax invoice.' : ''),
    isProforma ? convertButton(invoiceId) : undefined);
  await setRow(req, { [T.status]: S.sent });
  return req;
}

export async function reject(invoiceId, reason) {
  const req = await findRequest(invoiceId);
  if (!req) throw new Error(`Unknown request #${invoiceId}`);
  await setRow(req, { [T.status]: S.rejected, [T.note]: reason || '' });
  await send(req.chatId, `${requester(req)}, request <b>#${esc(invoiceId)}</b> for <b>${esc(req.customer)}</b> was not approved.` +
                         (reason ? `\nReason: ${esc(reason)}` : '') + '\nSend /invoice to submit a corrected one.');
  return req;
}


/* Proforma -> tax invoice ---------------------------------------------------- */

/** Why a proforma can't be converted, or '' when it can. */
function cannotConvert(req, invoiceId) {
  if (!req) return `There is no request #${invoiceId}.`;
  if (req.convertedTo) return `#${invoiceId} is already tax invoice #${req.convertedTo}.`;
  if (req.docType !== PROFORMA) return `#${invoiceId} is a ${req.docType.toLowerCase()}, not a proforma invoice.`;
  if (normKey(req.status) === normKey(S.rejected)) return `#${invoiceId} was rejected.`;
  if (normKey(req.status) !== normKey(S.sent)) return `#${invoiceId} has not been approved and sent yet.`;
  return '';
}

/** yyyymmdd in Singapore time, for putting a date in a button. */
function dayStamp(date = new Date()) {
  return sheetDateTime(date, CONFIG.TIME_ZONE, false).replace(/-/g, '');
}

/**
 * A manager asked for a proforma to become a tax invoice. You get a message
 * with one button; the date they asked goes into the new invoice number.
 */
export async function requestConversion(invoiceId, user) {
  const req = await findRequest(invoiceId);
  const why = cannotConvert(req, invoiceId);
  if (why) throw httpError(400, why);

  const day = dayStamp();
  for (const id of adminIds()) {
    await send(id,
      `🧾 <b>${esc(displayName(user))}</b> asks to turn proforma <b>#${esc(invoiceId)}</b> ` +
      `(${esc(req.customer)}, ${esc(req.chatTitle)}) into a tax invoice.\n` +
      'Converting sends the tax invoice to the group straight away.',
      { reply_markup: kb([[btn('✅ Convert and send', `c:ok:${invoiceId}:${day}`)],
                          [btn('❌ Not yet', `c:no:${invoiceId}`)]]) }).catch(() => {});
  }
  return req;
}

export async function declineConversion(invoiceId) {
  const req = await findRequest(invoiceId);
  if (req && req.chatId && !req.convertedTo) {
    await send(req.chatId, `Proforma <b>#${esc(invoiceId)}</b> (${esc(req.customer)}) was not converted to a tax invoice yet. ` +
                           `Ask again with /convert ${esc(invoiceId)} when it is ready.`);
  }
  return req;
}

/**
 * Turns a sent proforma into a tax invoice on the same Tracker row: new
 * number dated `day` (yyyymmdd, the day it was asked for), type Invoice,
 * the old number and date kept in Proforma No / Proforma Date. The PDF
 * goes to the group straight away.
 */
export async function convertToInvoice(invoiceId, day = dayStamp()) {
  const req = await findRequest(invoiceId);
  const why = cannotConvert(req, invoiceId);
  if (why) throw httpError(400, why);

  const date = new Date(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T12:00:00+08:00`);
  const t = await readTables([CONFIG.TRACKER_SHEET, CONFIG.COUNTRIES_SHEET]);
  const tracker = await trackerTable(t);
  const country = countryFor(parseCountries(t[CONFIG.COUNTRIES_SHEET]), req.country, req.invoiceId);
  const newId = nextInvoiceId(usedIds(tracker), country, date);

  const oldDate = toDate(req.date);
  await setRow(req, {
    [T.proformaNo]: req.invoiceId,
    [T.proformaDate]: oldDate ? sheetDateTime(oldDate, 'UTC', false) : '',
    [T.invoiceId]: newId,
    [T.date]: sheetDateTime(date, CONFIG.TIME_ZONE, false),
    [T.docType]: 'Invoice',
    [T.status]: S.sent
  });

  const inv = await loadInvoice(newId);
  const pdf = await renderInvoicePdf(inv);
  const msg = await sendDocument(req.chatId, pdf, fileName(inv),
    caption(inv, `🧾 <b>Tax invoice #${esc(newId)}</b> (was proforma #${esc(req.invoiceId)})`,
            `Requested by ${requester(req)}`));

  await setRow(req, {
    [T.fileId]: msg.document ? msg.document.file_id : '',
    [T.generatedAt]: now(),
    [linkColumn('Invoice')]: await storePdf(pdf, inv, req.links[linkColumn('Invoice')])
  });
  return { req, newId, inv };
}
