/**
 * Who may use the bot and the form: admins, and anyone who is a member of
 * one of your groups (a group the bot is in). Everyone else is told the
 * bot is private, and the form refuses to load, so a stranger who finds
 * the bot sees no customers, prices or margins.
 *
 * "Your groups" are the groups on the Bot Chats tab plus any group that
 * has made a request on the Tracker (groups the bot joined before the Bot
 * Chats tab existed only show up there). Membership is asked of Telegram
 * itself, so removing someone from the group removes their access.
 *
 * Pair this with @BotFather > Bot Settings > Allow Groups? > off, so
 * nobody can add the bot to a group of their own to get in.
 */
import { CONFIG, isAdmin } from './config.js';
import { readTables, headerIndex } from './sheets.js';
import { tg } from './telegram.js';

const verdicts = new Map();     // user id -> { ok, until }, per server instance
let groupCache = null;          // { ids, at }

/** Every group the bot serves. */
export async function yourGroups() {
  if (groupCache && Date.now() - groupCache.at < 5 * 60_000) return groupCache.ids;
  const t = await readTables([CONFIG.CHATS_SHEET, CONFIG.TRACKER_SHEET]);
  const ids = new Set();
  const chats = t[CONFIG.CHATS_SHEET];
  if (chats) {
    const ci = headerIndex(chats.headers, 'Chat ID'), ti = headerIndex(chats.headers, 'Title');
    chats.rows.forEach((r) => { if (String(r[ti]) !== '(bot removed)' && /^-\d+$/.test(String(r[ci]))) ids.add(String(r[ci])); });
  }
  const tr = t[CONFIG.TRACKER_SHEET];
  if (tr) {
    const ci = headerIndex(tr.headers, CONFIG.TRACKER.chatId);
    if (ci >= 0) tr.rows.forEach((r) => { if (/^-\d+$/.test(String(r[ci] ?? ''))) ids.add(String(r[ci])); });
  }
  groupCache = { ids: [...ids], at: Date.now() };
  return groupCache.ids;
}

async function memberOf(chatId, userId) {
  try {
    const m = await tg('getChatMember', { chat_id: chatId, user_id: Number(userId) });
    return ['creator', 'administrator', 'member'].includes(m.status) || (m.status === 'restricted' && m.is_member);
  } catch (e) {
    return false;                 // the bot left that group, or Telegram doesn't know the user there
  }
}

/** Admin, or a member of one of your groups. Answers are remembered for a few minutes. */
export async function isAllowed(userId, preferGroup = null) {
  if (isAdmin(userId)) return true;
  const key = String(userId);
  const v = verdicts.get(key);
  if (v && v.until > Date.now()) return v.ok;

  const groups = await yourGroups();
  // The group the form was opened from first: it is almost always the answer
  const order = preferGroup && groups.includes(String(preferGroup))
    ? [String(preferGroup), ...groups.filter((g) => g !== String(preferGroup))] : groups;
  let ok = false;
  for (const g of order) {
    if (await memberOf(g, userId)) { ok = true; break; }
  }
  verdicts.set(key, { ok, until: Date.now() + (ok ? 10 : 1) * 60_000 });
  return ok;
}

/* Who sees the customer list ---------------------------------------------- */

export const ACCESS_HEADERS = ['Telegram', 'Name', 'Email', 'Notes'];
let accessCache = null;          // { keys: Set, at }

/** "@Mei_Tan", "mei_tan", "t.me/mei_tan" -> "mei_tan"; an ID stays a number string. */
const userKey = (v) => String(v ?? '').trim().toLowerCase()
  .replace(/^(https?:\/\/)?(www\.)?t\.me\//, '').replace(/^@/, '');

/** Everyone on the Access tab, by @username or Telegram ID. */
export async function accessList() {
  if (accessCache && Date.now() - accessCache.at < 2 * 60_000) return accessCache.keys;
  const t = (await readTables([CONFIG.ACCESS_SHEET]))[CONFIG.ACCESS_SHEET];
  const keys = new Set();
  if (t) {
    const i = headerIndex(t.headers, ['Telegram', 'Telegram Username', 'Username', 'Telegram ID']);
    if (i >= 0) t.rows.forEach((r) => { const k = userKey(r[i]); if (k) keys.add(k); });
  }
  accessCache = { keys, at: Date.now() };
  return keys;
}

/**
 * May this Telegram user see saved customers (names, addresses, emails,
 * margins)? Admins always; others only when their @username or ID is on
 * the Access tab, like sharing a Google Sheet.
 */
export async function canSeeCustomers(user) {
  if (!user) return false;
  if (isAdmin(user.id)) return true;
  const keys = await accessList();
  return keys.has(String(user.id)) || (!!user.username && keys.has(userKey(user.username)));
}

export const PRIVATE_MESSAGE = 'This bot is private. Ask the admin to add you to your team\'s Telegram group.';
