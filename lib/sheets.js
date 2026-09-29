/**
 * Minimal Google Sheets client. Signs in as a service account with a JWT
 * (no googleapis package, which would slow every cold start), and talks
 * to the Sheets REST API directly.
 *
 * Share the spreadsheet with the service account's email as an Editor.
 */
import crypto from 'node:crypto';
import { env } from './config.js';

const API = 'https://sheets.googleapis.com/v4/spreadsheets';
let token = null;          // { value, expires }
let titles = null;         // { set, at } tab names, cached briefly


async function accessToken() {
  if (token && token.expires > Date.now() + 60_000) return token.value;

  const email = env('GOOGLE_SERVICE_ACCOUNT_EMAIL');
  // Vercel stores the key with literal "\n"; turn them back into newlines.
  const key = env('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);

  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  });
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(key).toString('base64url');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: unsigned + '.' + sig
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Google sign-in failed: ' + (data.error_description || data.error || res.status));

  token = { value: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  return token.value;
}


async function call(path, { method = 'GET', query, body } = {}) {
  const url = new URL(API + '/' + env('SPREADSHEET_ID') + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      [].concat(v).forEach((x) => url.searchParams.append(k, x));
    }
  }
  const res = await fetch(url, {
    method,
    headers: { authorization: 'Bearer ' + await accessToken(), 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error && data.error.message ? data.error.message : 'HTTP ' + res.status;
    if (res.status === 403) {
      throw new Error('Google Sheets refused access (' + msg + '). Share the sheet with ' +
                      process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL + ' as an Editor.');
    }
    throw new Error('Google Sheets: ' + msg);
  }
  return data;
}


/* Helpers ----------------------------------------------------------------- */

export function normKey(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function colLetter(n) {          // 1 -> A, 27 -> AA
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

const q = (sheet) => "'" + sheet.replace(/'/g, "''") + "'";

/** Index of the first header matching any of the names, or -1. */
export function headerIndex(headers, names) {
  const want = [].concat(names).map(normKey);
  for (const w of want) {
    const i = headers.findIndex((h) => normKey(h) === w);
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * Stops typed text being read as a formula (=, +, -, @) when written with
 * USER_ENTERED. Numbers and dates pass through untouched.
 */
function safeCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return v;
  const s = String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}


/* Reading ----------------------------------------------------------------- */

/**
 * Reads whole tabs. Returns { [sheet]: { headers, rows } } where each row
 * is an array with a hidden `_row` (sheet row number). Missing tabs come
 * back as null.
 */
async function tabNames(fresh = false) {
  if (!fresh && titles && Date.now() - titles.at < 5 * 60_000) return titles.set;
  const meta = await call('', { query: { fields: 'sheets.properties.title' } });
  titles = { set: new Set(meta.sheets.map((s) => s.properties.title)), at: Date.now() };
  return titles.set;
}

export async function readTables(sheets) {
  let have = await tabNames();
  if (sheets.some((s) => !have.has(s))) have = await tabNames(true);   // maybe added since
  const present = sheets.filter((s) => have.has(s));

  const out = {};
  sheets.forEach((s) => { out[s] = null; });
  if (!present.length) return out;

  const data = await call('/values:batchGet', {
    query: {
      ranges: present.map(q),
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'SERIAL_NUMBER'
    }
  });

  data.valueRanges.forEach((vr, i) => {
    const values = vr.values || [];
    const headers = (values[0] || []).map((h) => String(h).trim());
    const rows = values.slice(1).map((r, j) => {
      const row = headers.map((_, k) => (r[k] === undefined ? '' : r[k]));
      row._row = j + 2;
      return row;
    });
    out[present[i]] = { headers, rows };
  });
  return out;
}

export async function readTable(sheet) {
  return (await readTables([sheet]))[sheet];
}


/* Writing ----------------------------------------------------------------- */

/** Appends one row. `record` is { header: value }; unknown headers are dropped. */
export async function appendRecord(sheet, headers, record) {
  const row = headers.map(() => '');
  for (const [h, v] of Object.entries(record)) {
    const i = headerIndex(headers, h);
    if (i >= 0) row[i] = safeCell(v);
  }
  const res = await call('/values/' + encodeURIComponent(q(sheet) + '!A1') + ':append', {
    method: 'POST',
    query: { valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS' },
    body: { values: [row] }
  });
  // "Tracker!A57:N57" -> 57
  const m = String(res.updates && res.updates.updatedRange || '').match(/![A-Z]+(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

/** Writes cells in one row by header. Headers the tab lacks are skipped. */
export async function updateRecord(sheet, headers, rowNum, record) {
  const data = [];
  for (const [h, v] of Object.entries(record)) {
    const i = headerIndex(headers, h);
    if (i < 0) continue;
    data.push({ range: q(sheet) + '!' + colLetter(i + 1) + rowNum, values: [[safeCell(v)]] });
  }
  if (!data.length) return;
  await call('/values:batchUpdate', {
    method: 'POST',
    body: { valueInputOption: 'USER_ENTERED', data }
  });
}

/** Creates a tab with a header row if it does not exist yet. */
export async function ensureSheet(sheet, headers) {
  if ((await tabNames()).has(sheet) || (await tabNames(true)).has(sheet)) return false;
  await call(':batchUpdate', {
    method: 'POST',
    body: { requests: [{ addSheet: { properties: { title: sheet, gridProperties: { frozenRowCount: 1 } } } }] }
  });
  await call('/values/' + encodeURIComponent(q(sheet) + '!A1'), {
    method: 'PUT',
    query: { valueInputOption: 'RAW' },
    body: { values: [headers] }
  });
  titles = null;
  return true;
}


/* Values ------------------------------------------------------------------ */

/** A Sheets date serial (or a date-ish string) to a JS Date, or null. */
export function toDate(v) {
  if (v === '' || v === null || v === undefined) return null;
  if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400000));
  const s = String(v).trim();
  const dmy = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);   // Singapore order
  if (dmy) {
    const y = dmy[3].length === 2 ? 2000 + +dmy[3] : +dmy[3];
    return new Date(Date.UTC(y, +dmy[2] - 1, +dmy[1]));
  }
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

/** "yyyy-mm-dd hh:mm" in the given zone, which Sheets reads as a date. */
export function sheetDateTime(date, timeZone, withTime = true) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}` + (withTime ? ` ${p.hour}:${p.minute}` : '');
}
