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
import { readTables, headerIndex } from '../lib/sheets.js';
import { ensureTrackerColumns } from '../lib/workflow.js';
import { driveConfigured, driveCheck } from '../lib/drive.js';

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
          ['Tel', C.tel], ['Website', C.website], ['Email', C.email], ['Stamp', C.stamp], ['Invoice Title', C.invoiceTitle]
        ].map(([k, v]) => `${k}=${v ? '"' + (v.length > 40 ? v.slice(0, 40) + '…' : v) + '"' : '(blank)'}`).join(', '));
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

    if (!driveConfigured()) {
      out.push('⚠️ Google Drive: not set up, so the Tracker gets the app\'s own PDF links. ' +
               `See the README, then open ${url}/api/google-auth?key=<your secret>`);
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
