/**
 * Shared bits for the API routes: reading JSON, answering errors, and
 * working out where a finished invoice should be sent.
 */
import { tg, groupFromStartParam } from './telegram.js';
import { knownChats } from './workflow.js';
import { isAdmin } from './config.js';

export async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export function fail(res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ ok: false, error: err.message || String(err) });
}

/**
 * Where the invoice goes back to. Group names are never shown to anyone
 * but admins, and nobody can pick a group they did not open the form from.
 *   Opened from a group's button  -> that group only (the link is signed,
 *                                    so it cannot be pointed elsewhere)
 *   Opened in a private chat      -> the requester's own chat only.
 *                                    Admins may also pick any group.
 */
export async function targetOptions(init) {
  const groupId = groupFromStartParam(init.start_param);
  if (groupId) {
    let title = String(groupId);
    try { title = (await tg('getChat', { chat_id: groupId })).title || title; } catch (e) {}
    return { fixed: true, options: [{ id: String(groupId), title }] };
  }
  const me = { id: String(init.user.id), title: 'Me (private chat)' };
  if (!isAdmin(init.user.id)) return { fixed: true, options: [me] };
  return { fixed: false, options: [...await knownChats(), me] };
}
