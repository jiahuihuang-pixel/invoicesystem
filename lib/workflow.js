/**
 * Submit -> notify you with the PDF -> you approve -> it goes back to the
 * requester's group. Same states as the Apps Script bot, stored in the same
 * Bot Requests tab, so both can read each other's history.
 */
import { CONFIG, adminIds, appUrl } from './config.js';
import { countryByCode } from './countries.js';
import {
  readTables, readTable, appendRecord, updateRecord, ensureSheet, headerIndex, normKey, sheetDateTime
} from './sheets.js';
import {
  loadCatalog, catalogFromTables, clearCatalogCache, findCustomer, findProduct, marginDiscount,
  productsText, loadInvoice, fileName, price, toNumber, round2, nextInvoiceId
} from './invoice.js';
import { renderInvoicePdf } from './pdf.js';
import { send, sendDocument, kb, btn, esc, displayName, mention, sign, httpError } from './telegram.js';

const REQ_HEADERS = ['Invoice ID', 'Status', 'Customer', 'Items', 'Requested By', 'Requester ID',
                     'Chat ID', 'Chat Title', 'Submitted At', 'Generated At', 'PDF Link',
                     'Telegram File ID', 'Decided At', 'Note'];
const CHAT_HEADERS = ['Chat ID', 'Title', 'Added At'];

const now = (withTime = true) => sheetDateTime(new Date(), CONFIG.TIME_ZONE, withTime);
const S = CONFIG.STATUS;


/* Bot Requests tab --------------------------------------------------------- */

export async function findRequest(invoiceId) {
  const t = await readTable(CONFIG.REQUESTS_SHEET);
  if (!t) return null;
  const h = t.headers;
  const r = t.rows.find((row) => normKey(row[headerIndex(h, 'Invoice ID')]) === normKey(invoiceId));
  if (!r) return null;
  const get = (name) => { const i = headerIndex(h, name); return i >= 0 ? r[i] : ''; };
  return {
    row: r._row, headers: h,
    invoiceId: String(get('Invoice ID')), status: String(get('Status')),
    customer: String(get('Customer')), items: String(get('Items')),
    requestedBy: String(get('Requested By')), requesterId: String(get('Requester ID')),
    chatId: String(get('Chat ID')), chatTitle: String(get('Chat Title')),
    fileId: String(get('Telegram File ID'))
  };
}

export async function listOpenRequests() {
  const t = await readTable(CONFIG.REQUESTS_SHEET);
  if (!t) return [];
  const si = headerIndex(t.headers, 'Status'), ii = headerIndex(t.headers, 'Invoice ID');
  const open = [normKey(S.pending), normKey(S.generated)];
  return t.rows.filter((r) => open.includes(normKey(r[si]))).map((r) => String(r[ii]));
}

async function setStatus(req, status, extra = {}) {
  await updateRecord(CONFIG.REQUESTS_SHEET, req.headers, req.row, { 'Status': status, ...extra });
  await setTrackerFields(req.invoiceId, { [CONFIG.TRACKER.status]: status });
}

async function setTrackerFields(invoiceId, record) {
  const t = await readTable(CONFIG.TRACKER_SHEET);
  const ii = headerIndex(t.headers, CONFIG.TRACKER.invoiceId);
  const r = t.rows.find((row) => normKey(row[ii]) === normKey(invoiceId));
  if (r) await updateRecord(CONFIG.TRACKER_SHEET, t.headers, r._row, record);
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
 * the Product list, never from the phone), writes the Tracker and Bot
 * Requests rows, and returns the new request. PDF + notification happen
 * afterwards in notifyAdmins().
 */
export async function submitRequest(form, user, target) {
  const customerName = String(form.customer && form.customer.name || '').trim();
  if (!customerName) throw httpError(400, 'Customer name is missing.');

  // One round trip to Google for everything below
  const tables = await readTables([CONFIG.TRACKER_SHEET, CONFIG.PRODUCTS_SHEET,
                                   CONFIG.CUSTOMERS_SHEET, CONFIG.REQUESTS_SHEET, CONFIG.COUNTRIES_SHEET]);
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

  // Tracker row
  const tracker = tables[CONFIG.TRACKER_SHEET];
  if (!tracker) throw new Error(`The sheet has no "${CONFIG.TRACKER_SHEET}" tab.`);
  const T = CONFIG.TRACKER;
  if (headerIndex(tracker.headers, T.invoiceId) < 0) throw new Error(`The Tracker has no "${T.invoiceId}" column.`);

  const idCol = headerIndex(tracker.headers, T.invoiceId);
  const invoiceId = nextInvoiceId(tracker.rows.map((r) => r[idCol]), country);
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
    [T.status]: S.pending
  });

  await saveCustomer(customersTable, existing, { name: customerName, address, email, terms, country: country.name });

  let reqHeaders = tables[CONFIG.REQUESTS_SHEET] && tables[CONFIG.REQUESTS_SHEET].headers;
  if (!reqHeaders || !reqHeaders.length) { await ensureSheet(CONFIG.REQUESTS_SHEET, REQ_HEADERS); reqHeaders = REQ_HEADERS; }
  await appendRecord(CONFIG.REQUESTS_SHEET, reqHeaders, {
    'Invoice ID': invoiceId,
    'Status': S.pending,
    'Customer': existing ? existing.name : customerName,
    'Items': items.map((it) => `${it.qty} × ${it.name}`).join('\n'),
    'Requested By': requestedBy,
    'Requester ID': String(user.id),
    'Chat ID': String(target.id),
    'Chat Title': target.title,
    'Submitted At': now()
  });

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

  const lines = [
    heading || `🧾 <b>${esc(inv.docType)} #${esc(inv.invoiceId)}</b> (regenerated)`,
    '',
    `${inv.country.flag} <b>${esc(inv.customer)}</b>`,
    ...inv.items.map((it) => `• ${it.qty} × ${esc(it.name)}`),
    inv.lines.some((l) => l.isDiscount)
      ? `• Discount ${price(inv.country, -inv.lines.find((l) => l.isDiscount).amount * inv.country.taxRate)}` : '',
    '',
    `Total <b>${price(inv.country, inv.total)}</b>` + (inv.country.taxRate > 1 ? ' incl. GST' : ''),
    `From ${esc(req.requestedBy)} for <b>${esc(req.chatTitle)}</b>`
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '');
  if (inv.missing.length) {
    lines.push('', `⚠️ Not on the Product list, no price: ${inv.missing.map(esc).join(', ')}`);
  }
  let caption = lines.join('\n');
  if (caption.length > 1000) caption = caption.slice(0, 990) + '…';

  let fileId = '';
  for (const chatId of chatIds) {
    try {
      const msg = await sendDocument(chatId, fileId || pdf, fileName(inv), caption, adminButtons(invoiceId));
      if (!fileId && msg.document) fileId = msg.document.file_id;
    } catch (e) {
      console.warn(`Could not send #${invoiceId} to ${chatId}: ${e.message}`);
    }
  }
  if (!fileId) throw new Error('The PDF was made but could not be sent to any admin. Have you pressed Start on the bot?');

  await updateRecord(CONFIG.REQUESTS_SHEET, req.headers, req.row, {
    'Status': S.generated, 'Generated At': now(), 'PDF Link': pdfLink(invoiceId), 'Telegram File ID': fileId
  });
  await setTrackerFields(invoiceId, {
    [CONFIG.TRACKER.status]: S.generated,
    [CONFIG.TRACKER.pdfLink]: pdfLink(invoiceId),
    [CONFIG.TRACKER.generatedAt]: now()
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

export async function approve(invoiceId) {
  const req = await findRequest(invoiceId);
  if (!req) throw new Error(`Unknown request #${invoiceId}`);
  if (!req.fileId) throw new Error('Generate the PDF first.');
  const who = req.requesterId ? mention({ id: req.requesterId }, req.requestedBy) : esc(req.requestedBy);
  await sendDocument(req.chatId, req.fileId, null,
    `🧾 <b>#${esc(invoiceId)}</b> — ${esc(req.customer)}\nRequested by ${who}`);
  await setStatus(req, S.sent, { 'Decided At': now() });
  return req;
}

export async function reject(invoiceId, reason) {
  const req = await findRequest(invoiceId);
  if (!req) throw new Error(`Unknown request #${invoiceId}`);
  await setStatus(req, S.rejected, { 'Decided At': now(), 'Note': reason || '' });
  const who = req.requesterId ? mention({ id: req.requesterId }, req.requestedBy) : esc(req.requestedBy);
  await send(req.chatId, `${who}, request <b>#${esc(invoiceId)}</b> for <b>${esc(req.customer)}</b> was not approved.` +
                         (reason ? `\nReason: ${esc(reason)}` : '') + '\nSend /invoice to submit a corrected one.');
  return req;
}

export function isClosed(req) {
  return [normKey(S.sent), normKey(S.rejected)].includes(normKey(req.status));
}

