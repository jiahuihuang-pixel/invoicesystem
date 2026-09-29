/**
 * Telegram Bot API, Mini App sign-in check, and signed links.
 */
import crypto from 'node:crypto';
import { env } from './config.js';

const api = () => 'https://api.telegram.org/bot' + env('TELEGRAM_BOT_TOKEN');


export async function tg(method, params = {}) {
  const res = await fetch(api() + '/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params)
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description}`);
  return data.result;
}

/** Sends a PDF. `doc` is a Buffer (uploaded) or a file_id string (re-sent). */
export async function sendDocument(chatId, doc, filename, caption, replyMarkup) {
  if (typeof doc === 'string') {
    return tg('sendDocument', { chat_id: chatId, document: doc, caption, parse_mode: 'HTML',
                                reply_markup: replyMarkup });
  }
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('document', new Blob([doc], { type: 'application/pdf' }), filename);
  if (caption) { form.append('caption', caption); form.append('parse_mode', 'HTML'); }
  if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));

  const res = await fetch(api() + '/sendDocument', { method: 'POST', body: form });
  const data = await res.json();
  if (!data.ok) throw new Error('Telegram sendDocument: ' + data.description);
  return data.result;
}

export const send = (chatId, html, extra = {}) =>
  tg('sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML',
                      link_preview_options: { is_disabled: true }, ...extra });

export const answer = (id, text, alert = false) =>
  tg('answerCallbackQuery', { callback_query_id: id, text, show_alert: alert }).catch(() => {});

export const kb = (rows) => ({ inline_keyboard: rows });
export const btn = (text, data) => ({ text, callback_data: data });

export function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function displayName(u) {
  if (!u) return '';
  return [u.first_name, u.last_name].filter(Boolean).join(' ') || (u.username ? '@' + u.username : String(u.id));
}

export function mention(u, name) {
  return u && u.id ? `<a href="tg://user?id=${u.id}">${esc(name || displayName(u))}</a>` : esc(name);
}


/**
 * Checks the initData string Telegram hands the Mini App, so a request can
 * only come from a real Telegram user. Returns { user, start_param, ... }.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function verifyInitData(initData, maxAgeSec = 24 * 3600) {
  if (!initData) throw httpError(401, 'Open this form from Telegram.');
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  params.delete('hash');
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(env('TELEGRAM_BOT_TOKEN')).digest();
  const want = crypto.createHmac('sha256', secret).update(check).digest('hex');
  if (!hash || hash.length !== want.length ||
      !crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(want))) {
    throw httpError(401, 'Telegram sign-in check failed. Close the form and open it again.');
  }
  const age = Date.now() / 1000 - Number(params.get('auth_date'));
  if (!(age < maxAgeSec)) throw httpError(401, 'This form has been open too long. Close it and open it again.');

  const out = Object.fromEntries(params.entries());
  out.user = out.user ? JSON.parse(out.user) : null;
  if (!out.user) throw httpError(401, 'No Telegram user in the sign-in data.');
  return out;
}

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}


/* Signed values (group links, PDF links) ------------------------------- */

export function sign(value, len = 12) {
  return crypto.createHmac('sha256', env('TELEGRAM_WEBHOOK_SECRET')).update(String(value))
    .digest('base64url').slice(0, len);
}

export function signedOk(value, sig, len = 12) {
  const want = sign(value, len);
  return typeof sig === 'string' && sig.length === want.length &&
         crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}

/** "g-100123_abc..." -> the group chat id, if the signature holds. */
export function groupFromStartParam(p) {
  const m = String(p || '').match(/^g(-?\d+)_([A-Za-z0-9_-]+)$/);
  return m && signedOk(m[1], m[2], 10) ? Number(m[1]) : null;
}

export function startParamForGroup(chatId) {
  return `g${chatId}_${sign(chatId, 10)}`;
}
