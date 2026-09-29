/**
 * Shared bits for the API routes: reading JSON, answering errors, and
 * working out where a finished invoice should be sent.
 */
import { tg, groupFromStartParam } from './telegram.js';
import { knownChats } from './workflow.js';

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
 * Where the invoice goes back to.
 *   Opened from a group's button  -> that group (the link is signed, so it
 *                                    cannot be pointed at another group)
 *   Opened in a private chat      -> any group the bot knows, or the
 *                                    requester's own chat
 */
export async function targetOptions(init) {
  const groupId = groupFromStartParam(init.start_param);
  if (groupId) {
    let title = String(groupId);
    try { title = (await tg('getChat', { chat_id: groupId })).title || title; } catch (e) {}
    return { fixed: true, options: [{ id: String(groupId), title }] };
  }
  const me = { id: String(init.user.id), title: 'Me (private chat)' };
  return { fixed: false, options: [...await knownChats(), me] };
}
