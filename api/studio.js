/**
 * /api/studio: data for the Template Studio page (public/studio.html).
 * Admin only: every call needs the header x-studio-key = TELEGRAM_WEBHOOK_SECRET.
 *
 *   GET                         countries (with their Countries tab details
 *                               and saved template) and a sample invoice each
 *   POST { action: 'save', code, template }   saves a country's template
 *   POST { action: 'reset', code }            back to the built-in design
 *
 * The preview itself is drawn in the browser with the same code the server
 * uses (public/render/), so nothing is drawn here.
 */
import crypto from 'node:crypto';
import { CONFIG, env } from '../lib/config.js';
import { readTables, readTable, appendRecord, updateRecord, ensureSheet, headerIndex, sheetDateTime } from '../lib/sheets.js';
import { parseCountries, attachTemplates, TEMPLATE_HEADERS } from '../lib/countries.js';
import { catalogFromTables, computeInvoice, nextInvoiceId } from '../lib/invoice.js';
import { readJson, fail } from '../lib/http.js';
import { httpError } from '../lib/telegram.js';

function allowed(req) {
  const hash = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(hash(req.headers['x-studio-key'] || ''), hash(env('TELEGRAM_WEBHOOK_SECRET')));
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  try {
    if (!allowed(req)) throw httpError(403, 'Wrong key. Use your TELEGRAM_WEBHOOK_SECRET.');
    if (req.method === 'GET') return res.status(200).json({ ok: true, ...(await load()) });
    if (req.method !== 'POST') throw httpError(405, 'GET or POST only');

    const body = await readJson(req);
    const code = String(body.code || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) throw httpError(400, 'Which country?');

    if (body.action === 'save') {
      const json = JSON.stringify(body.template || {});
      if (json.length > 45000) throw httpError(400, 'That template is too big to save.');
      await saveRow(code, json);
      return res.status(200).json({ ok: true });
    }
    if (body.action === 'reset') {
      await saveRow(code, '');
      return res.status(200).json({ ok: true });
    }
    throw httpError(400, 'Unknown action');
  } catch (err) {
    fail(res, err);
  }
}


async function load() {
  const t = await readTables([CONFIG.COUNTRIES_SHEET, CONFIG.TEMPLATES_SHEET, CONFIG.PRODUCTS_SHEET, CONFIG.CUSTOMERS_SHEET]);
  const { countries, products } = catalogFromTables(t);
  attachTemplates(countries, t[CONFIG.TEMPLATES_SHEET]);

  // A made-up invoice per country, priced from the Product list, to preview with
  const samples = {};
  for (const c of countries) {
    const priced = products.filter((p) => p.prices[c.code] != null).slice(0, 3);
    const items = (priced.length ? priced : [{ name: 'Sample product', code: '', prices: { [c.code]: 100 } }])
      .map((p, i) => ({ name: p.name, code: p.code, qty: [1, 2, 1][i], price: p.prices[c.code] }));
    const calc = computeInvoice(items, 0, c.taxRate);
    samples[c.code] = {
      invoiceId: nextInvoiceId([], c),
      date: new Date().toISOString(),
      customer: 'Sample Customer Pte Ltd',
      address: '1 Example Road #01-01\nSample City 123456',
      email: 'accounts@example.com',
      po: 'PO-12345',
      terms: CONFIG.TERMS[0],
      items,
      ...calc
    };
  }
  return { countries, samples, docTypes: CONFIG.DOC_TYPES };
}


async function saveRow(code, json) {
  await ensureSheet(CONFIG.TEMPLATES_SHEET, TEMPLATE_HEADERS);
  const t = await readTable(CONFIG.TEMPLATES_SHEET);
  const ci = headerIndex(t.headers, 'Code');
  const row = t.rows.find((r) => String(r[ci]).trim().toUpperCase() === code);
  const record = { 'Code': code, 'Template': json, 'Updated At': sheetDateTime(new Date(), CONFIG.TIME_ZONE) };
  if (row) await updateRecord(CONFIG.TEMPLATES_SHEET, t.headers, row._row, record);
  else await appendRecord(CONFIG.TEMPLATES_SHEET, t.headers, record);
}
