/**
 * GET /api/setup?key=<TELEGRAM_WEBHOOK_SECRET>
 *
 * Run once after deploying (and again if you change the domain). Points
 * Telegram at this app, sets the bot's menu button and commands, and
 * checks it can read every tab it needs. Prints a plain report.
 */
import { CONFIG, env, appUrl, adminIds } from '../lib/config.js';
import { parseCountries } from '../lib/countries.js';
import crypto from 'node:crypto';
import { tg } from '../lib/telegram.js';
import { readTables, headerIndex, normKey, ensureSheet } from '../lib/sheets.js';
import { parseCustomerPrices, parsePriceBook } from '../lib/invoice.js';
import { ensureTrackerColumns } from '../lib/workflow.js';
import { driveConfigured, driveCheck } from '../lib/drive.js';
import { yourGroups, accessList, ACCESS_HEADERS } from '../lib/access.js';

export default async function handler(req, res) {
  // Compare fixed-length hashes so the check takes the same time either way
  const hash = (s) => crypto.createHash('sha256').update(String(s)).digest();
  if (!crypto.timingSafeEqual(hash(req.query.key || ''), hash(env('TELEGRAM_WEBHOOK_SECRET')))) {
    return res.status(403).send('Add ?key=<your TELEGRAM_WEBHOOK_SECRET> to the address.');
  }

  const out = [];
  const ok = (s) => out.push('✅ ' + s);
  const bad = (s) => out.push('❌ ' + s);

  try {
    const me = await tg('getMe');
    ok(`Bot: @${me.username}`);

    const url = appUrl();
    await tg('setWebhook', {
      url: url + '/api/telegram',
      secret_token: env('TELEGRAM_WEBHOOK_SECRET'),
      allowed_updates: ['message', 'callback_query', 'my_chat_member'],
      drop_pending_updates: false
    });
    ok(`Webhook: ${url}/api/telegram`);

    await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'New invoice', web_app: { url: url + '/' } } });
    ok('Menu button in private chats opens the form');

    await tg('setMyCommands', { commands: [
      { command: 'invoice', description: 'Request an invoice' },
      { command: 'convert', description: 'Turn a paid proforma into a tax invoice' },
      { command: 'whoami', description: 'Show my Telegram ID' }
    ] });
    for (const id of adminIds()) {
      await tg('setMyCommands', {
        scope: { type: 'chat', chat_id: Number(id) },
        commands: [
          { command: 'invoice', description: 'Request an invoice' },
          { command: 'pending', description: 'Requests waiting for approval' },
          { command: 'convert', description: 'Turn a proforma into a tax invoice' },
          { command: 'whoami', description: 'Show my Telegram ID' }
        ]
      }).then(() => ok(`Admin ${id}: commands set`))
        .catch((e) => bad(`Admin ${id}: ${e.message}. Open the bot and press Start, then run setup again.`));
    }

    const info = await tg('getWebhookInfo');
    if (info.last_error_message) out.push(`⚠️ Telegram's last delivery error (may be old): ${info.last_error_message}`);

    // Sheet (the Countries headers it found are listed to catch typos)
    ok(`Reading spreadsheet ${env('SPREADSHEET_ID')} (app version: letterhead styles)`);
    const t = await readTables([CONFIG.TRACKER_SHEET, CONFIG.PRODUCTS_SHEET, CONFIG.CUSTOMERS_SHEET, CONFIG.COUNTRIES_SHEET]);
    let countries = [];
    try {
      countries = parseCountries(t[CONFIG.COUNTRIES_SHEET]);
      out.push(`     Countries tab columns: ${t[CONFIG.COUNTRIES_SHEET].headers.filter(Boolean).join(' | ')}`);
      for (const c of countries) {
        if (c.ready) { ok(`${c.name}: ready (${c.currency}, ${c.taxRate > 1 ? Math.round((c.taxRate - 1) * 1000) / 10 + '% ' + c.taxName : 'no tax'}, ${c.layout} layout, ${c.company.headerStyle} header)`);
        // What the letterhead will print, so a wrong or missing column shows up here
        const C = c.company;
        out.push(`     letterhead: ` + [
          ['Company Name', C.name], ['Reg No Label', C.regLabel], ['GST Reg No', C.gstRegNo], ['Address', C.store],
          ['Tel', C.tel], ['Website', C.website], ['Email', C.email], ['Stamp', C.stamp], ['Copies', (C.copies || []).join(' + ')], ['Invoice Title', C.invoiceTitle]
        ].map(([k, v]) => `${k}=${v ? '"' + (v.length > 40 ? v.slice(0, 40) + '…' : v) + '"' : '(blank)'}`).join(', '));
        if ((C.copies || []).length > 1) ok(`${c.name}: companies get ${C.copies.length} copies in one PDF (${C.copies.join(', ')}); individuals get one`);
        else if (c.code === 'TH') out.push(`⚠️ ${c.name}: no original + copy. Type  <ORIGINAL>, <COPY>  in the Copies column of the Countries tab`);
        } else out.push(`⚠️ ${c.name}: not ready, greyed out in the form` +
                      (c.missing.length ? ` (Countries tab is missing ${c.missing.join(', ')})` : ' (Ready is not ticked)'));
      }
      if (!countries.some((c) => c.ready)) bad('No country is ready, so the form has nothing to offer');
    } catch (e) { bad(e.message); }
    const tr = t[CONFIG.TRACKER_SHEET];
    if (!tr) bad(`No "${CONFIG.TRACKER_SHEET}" tab`);
    else {
      ok(`Tracker: ${tr.rows.length} rows`);
      const before = tr.headers.length;
      tr.headers = await ensureTrackerColumns();
      if (tr.headers.length > before) ok(`Tracker: added columns ${tr.headers.slice(before).join(', ')}`);
      const missing = Object.values(CONFIG.TRACKER).filter((h) => headerIndex(tr.headers, h) < 0);
      if (missing.length) out.push(`⚠️ Tracker columns not found (these values will not be saved): ${missing.join(', ')}`);
    }
    const pr = t[CONFIG.PRODUCTS_SHEET];
    if (!pr) bad(`No "${CONFIG.PRODUCTS_SHEET}" tab`);
    else {
      ok(`Product list: ${pr.rows.length} rows`);
      for (const c of countries) {
        if (headerIndex(pr.headers, c.priceColumn) >= 0) ok(`${c.name} prices: "${c.priceColumn}" column`);
        else (c.ready ? bad : (m) => out.push('⚠️ ' + m))(`${c.name}: Product list has no "${c.priceColumn}" column, so no ${c.currency} prices`);
      }
    }
    if (!t[CONFIG.CUSTOMERS_SHEET]) out.push(`⚠️ No "${CONFIG.CUSTOMERS_SHEET}" tab: customers will not be remembered`);
    else ok(`Customers: ${t[CONFIG.CUSTOMERS_SHEET].rows.length} rows`);

    // Special prices per customer: the Price Book Helper grid and/or the Customer Prices list
    if (!CONFIG.USE_SPECIAL_PRICES) ok('Pricing: list prices with each customer\'s Margin % as a discount (special prices are switched off)');
    else {
    const pt = await readTables([CONFIG.PRICE_BOOK_SHEET, CONFIG.CUSTOMER_PRICES_SHEET, CONFIG.CUSTOMERS_SHEET]);
    const customerKeysAll = new Set();
    if (pt[CONFIG.CUSTOMERS_SHEET]) {
      const h = pt[CONFIG.CUSTOMERS_SHEET].headers;
      const ni = headerIndex(h, 'Customer Name'), ii = headerIndex(h, 'Customer ID');
      pt[CONFIG.CUSTOMERS_SHEET].rows.forEach((r) => {
        if (ni >= 0 && r[ni] !== '') customerKeysAll.add(normKey(r[ni]));
        if (ii >= 0 && r[ii] !== '') customerKeysAll.add(normKey(r[ii]));
      });
    }
    const unknown = (entries) => [...new Set(entries.filter((e) => !customerKeysAll.has(e.customer)).map((e) => e.customer))];

    if (pt[CONFIG.PRICE_BOOK_SHEET]) {
      const book = parsePriceBook(pt[CONFIG.PRICE_BOOK_SHEET]);
      ok(`${CONFIG.PRICE_BOOK_SHEET}: ${book.length} special price(s) for ${book.companies.length} company column(s): ` +
         (book.companies.join(', ') || '(none found)'));
      const notFound = (book.companies || []).filter((c) => !customerKeysAll.has(normKey(c)));
      if (notFound.length) {
        out.push(`⚠️ ${CONFIG.PRICE_BOOK_SHEET}: these columns don't match any Customer Name or Customer ID on the ` +
                 `Customers tab, so their prices are never used: ${notFound.join(', ')}`);
      }
    }
    if (pt[CONFIG.CUSTOMER_PRICES_SHEET]) {
      const cp = parseCustomerPrices(pt[CONFIG.CUSTOMER_PRICES_SHEET]);
      ok(`${CONFIG.CUSTOMER_PRICES_SHEET}: ${cp.length} special price(s)`);
      const bad = unknown(cp);
      if (bad.length) out.push(`⚠️ ${CONFIG.CUSTOMER_PRICES_SHEET}: customers not on the Customers tab: ${bad.join(', ')}`);
    }
    if (!pt[CONFIG.PRICE_BOOK_SHEET] && !pt[CONFIG.CUSTOMER_PRICES_SHEET]) {
      out.push(`⚠️ No special prices: add a "${CONFIG.PRICE_BOOK_SHEET}" tab (products down the side, one column per company) ` +
               `or a "${CONFIG.CUSTOMER_PRICES_SHEET}" tab (Customer | Product | Price)`);
    }
    }

    // Private bot: who gets in
    const groups = await yourGroups();
    ok(`Private: only admins and members of your ${groups.length} group(s) can use the bot and the form`);
    if (await ensureSheet(CONFIG.ACCESS_SHEET, ACCESS_HEADERS)) {
      ok(`Created the "${CONFIG.ACCESS_SHEET}" tab: add the Telegram @usernames of people who may see the customer list`);
    } else {
      ok(`Customer list visible to admins + ${(await accessList()).size} person(s) on the "${CONFIG.ACCESS_SHEET}" tab`);
    }
    if (!groups.length) out.push('⚠️ No groups found yet, so only admins can use the form. Send /invoice once in each group to register it.');

    if (!driveConfigured()) {
      out.push('⚠️ Google Drive: not set up, so the Tracker gets the app\'s own PDF links. ' +
               'Add DRIVE_FOLDER_ID in Vercel (a Shared Drive the service account can edit) - see the README.');
    } else {
      try { ok(`Google Drive: saving into ${await driveCheck()}`); }
      catch (e) { bad(e.message); }
    }

    out.push('', `Form address: ${url}/`, '',
      'Last step, in @BotFather: /mybots > your bot > Bot Settings > Configure Mini App >',
      `Enable Mini App, and give it ${url}/ . Without it the button in groups cannot open the form.`);
  } catch (e) {
    bad(e.message);
  }

  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.status(200).send(out.join('\n'));
}
