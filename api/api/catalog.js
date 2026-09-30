/**
 * POST /api/catalog  { initData }
 * Everything the form needs: products, customers, choices, where it will
 * be sent. Only for signed-in Telegram users, since it carries prices.
 */
import { verifyInitData } from '../lib/telegram.js';
import { catalogForForm } from '../lib/workflow.js';
import { readJson, fail, targetOptions } from '../lib/http.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
    const body = await readJson(req);
    const init = verifyInitData(body.initData);
    const [catalog, targets] = await Promise.all([catalogForForm(), targetOptions(init)]);
    res.status(200).json({ ok: true, ...catalog, targets, user: { name: init.user.first_name } });
  } catch (err) {
    fail(res, err);
  }
}
