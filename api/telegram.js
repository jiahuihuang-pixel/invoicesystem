/**
 * POST /api/telegram — Telegram's webhook.
 *
 * Commands
 *   /invoice   opens the request form (in a group or a private chat)
 *   /pending   admins: everything still waiting on you
 *   /whoami    your user ID and this chat's ID
 *
 * Buttons on the PDF you receive
 *   ✅ Approve     posts the PDF to the group it was requested from
 *   🔁 Regenerate  rebuilds it from the Tracker row, after you fix the row
 *   ❌ Reject      asks for a reason and tells the requester
 */
import { CONFIG, env, isAdmin, appUrl } from '../lib/config.js';
import { tg, send, answer, kb, esc, startParamForGroup } from '../lib/telegram.js';
import {
  rememberChat, forgetChat, findRequest, listOpenRequests, generateAndOffer,
  approve, reject, isClosed, adminButtons
} from '../lib/workflow.js';
import { readJson } from '../lib/http.js';

const REJECT_PROMPT = /Why is #(\S+) being rejected\?/;
let botUsername = process.env.TELEGRAM_BOT_USERNAME || '';


export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('Invoice bot is running.');
  if (req.headers['x-telegram-bot-api-secret-token'] !== env('TELEGRAM_WEBHOOK_SECRET')) {
    return res.status(403).send('forbidden');
  }

  let update = null;
  try {
    update = await readJson(req);
    await route(update);
  } catch (err) {
    console.error(err);
    await reportError(update, err);
  }
  // Always 200, or Telegram re-sends the same update forever.
  res.status(200).send('ok');
}


async function route(u) {
  if (u.my_chat_member) {
    const st = u.my_chat_member.new_chat_member.status;
    if (['member', 'administrator'].includes(st)) return rememberChat(u.my_chat_member.chat);
    if (['left', 'kicked'].includes(st)) return forgetChat(u.my_chat_member.chat.id);
    return;
  }
  if (u.callback_query) return onButton(u.callback_query);
  if (u.message) return onMessage(u.message);
}


/* Messages ------------------------------------------------------------------ */

async function onMessage(msg) {
  const text = String(msg.text || '').trim();
  const cmd = (text.match(/^\/([a-z_]+)(?:@\w+)?/i) || [])[1];
  const chat = msg.chat;

  // Reply to the "why is it rejected" question
  const prompt = msg.reply_to_message && msg.reply_to_message.text;
  if (prompt && REJECT_PROMPT.test(prompt) && isAdmin(msg.from.id)) {
    const id = prompt.match(REJECT_PROMPT)[1];
    const req = await findRequest(id);
    if (!req) return send(chat.id, `Request #${esc(id)} not found.`);
    if (isClosed(req)) return send(chat.id, `#${esc(id)} is already ${esc(req.status.toLowerCase())}.`);
    await reject(id, cmd === 'skip' ? '' : text);
    return send(chat.id, `❌ Rejected #${esc(id)} and told ${esc(req.requestedBy)}.`);
  }

  if (!cmd) return;
  if (chat.type !== 'private') await rememberChat(chat).catch((e) => console.warn(e.message));

  switch (cmd.toLowerCase()) {
    case 'start':
    case 'invoice':
    case 'new':
      return offerForm(msg);

    case 'whoami':
      return send(chat.id, `Your user ID: <code>${msg.from.id}</code>\nThis chat's ID: <code>${chat.id}</code>` +
                           (isAdmin(msg.from.id) ? '\nYou are an admin.' : ''));

    case 'pending':
      if (!isAdmin(msg.from.id)) return;
      return showPending(chat.id);

    case 'help':
      return send(chat.id, 'Send /invoice to request an invoice.' +
                           (isAdmin(msg.from.id) ? '\n/pending shows what is waiting for your approval.' : ''));
  }
}

/**
 * In a private chat a web_app button opens the form directly. Telegram does
 * not allow those in groups, so there the button is a t.me link to the Mini
 * App carrying the group's (signed) ID, which is how the form knows where
 * to send the invoice back to.
 */
async function offerForm(msg) {
  const chat = msg.chat;
  const intro = '📝 Tap below to fill in the invoice request.';

  if (chat.type === 'private') {
    return send(chat.id, intro, {
      reply_markup: kb([[{ text: '📝 New invoice request', web_app: { url: appUrl() + '/' } }]])
    });
  }

  if (!botUsername) botUsername = (await tg('getMe')).username;
  const app = process.env.TELEGRAM_APP_SHORT_NAME ? '/' + process.env.TELEGRAM_APP_SHORT_NAME : '';
  const link = `https://t.me/${botUsername}${app}?startapp=${startParamForGroup(chat.id)}`;
  return send(chat.id, intro, {
    reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
    reply_markup: kb([[{ text: '📝 New invoice request', url: link }]])
  });
}

async function showPending(chatId) {
  const ids = await listOpenRequests();
  if (!ids.length) return send(chatId, 'Nothing waiting on you.');
  for (const id of ids.slice(0, 10)) {
    const req = await findRequest(id);
    const text = `🧾 <b>#${esc(id)}</b> — ${esc(req.customer)}\n${esc(req.items)}\n\n` +
                 `${esc(req.status)} · ${esc(req.requestedBy)} · ${esc(req.chatTitle)}`;
    await send(chatId, text, { reply_markup: adminButtons(id) });
  }
  if (ids.length > 10) await send(chatId, `…and ${ids.length - 10} more.`);
}


/* Buttons ------------------------------------------------------------------- */

async function onButton(cb) {
  const [kind, act, ...rest] = String(cb.data || '').split(':');
  if (kind !== 'a') return answer(cb.id);
  if (!isAdmin(cb.from.id)) return answer(cb.id, 'Admins only.', true);

  const id = rest.join(':');
  const req = await findRequest(id);
  if (!req) return answer(cb.id, `Unknown request #${id}`, true);
  if (isClosed(req)) {
    await stamp(cb.message, `Already ${req.status.toLowerCase()}.`);
    return answer(cb.id, `Already ${req.status.toLowerCase()}.`, true);
  }

  switch (act) {
    case 'ok': {
      if (!req.fileId) return answer(cb.id, 'There is no PDF yet. Tap Regenerate first.', true);
      await answer(cb.id, 'Sending…');
      await approve(id);
      return stamp(cb.message, `✅ Sent to ${req.chatTitle} ${when()}`);
    }
    case 'gen': {
      await answer(cb.id, 'Making a fresh PDF…');
      await generateAndOffer(id, [cb.message.chat.id]);
      return stamp(cb.message, `🔁 Replaced by a new PDF ${when()}`);
    }
    case 'no': {
      await answer(cb.id);
      await stamp(cb.message, '❌ Rejecting…');
      return send(cb.message.chat.id,
        `Why is #${id} being rejected? The requester will see this.\n<i>Reply here, or reply /skip for no reason.</i>`,
        { reply_markup: { force_reply: true, input_field_placeholder: 'Reason' } });
    }
    default:
      return answer(cb.id);
  }
}

/** Adds a note under a message and takes its buttons away. */
async function stamp(message, note) {
  if (!message) return;
  const base = { chat_id: message.chat.id, message_id: message.message_id, reply_markup: { inline_keyboard: [] } };
  try {
    if (message.document) {
      await tg('editMessageCaption', { ...base, caption: `${message.caption || ''}\n\n${note}`,
                                       caption_entities: message.caption_entities || [] });
    } else {
      await tg('editMessageText', { ...base, text: `${message.text || ''}\n\n${note}`,
                                    entities: message.entities || [] });
    }
  } catch (e) {
    await tg('editMessageReplyMarkup', base).catch(() => {});
  }
}

function when() {
  return new Intl.DateTimeFormat('en-GB', { timeZone: CONFIG.TIME_ZONE, day: 'numeric', month: 'short',
                                             hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
}

async function reportError(update, err) {
  const msg = '⚠️ ' + esc(err && err.message ? err.message : String(err));
  try {
    if (update && update.callback_query) {
      await answer(update.callback_query.id, 'Something went wrong', false);
      await send(update.callback_query.message.chat.id, msg);
    } else if (update && update.message) {
      await send(update.message.chat.id, msg);
    }
  } catch (e) {
    console.error('reportError failed: ' + e.message);
  }
}

