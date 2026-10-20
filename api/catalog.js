/**
 * POST /api/catalog  { initData }           everything the form needs
 * POST /api/catalog  { initData, checkName } is this a saved customer? (yes / no)
 * Everything the form needs: products, customers, choices, where it will
 * be sent. Only for signed-in Telegram users, since it carries prices.
 */
import { verifyInitData, groupFromStartParam, httpError } from '../lib/telegram.js';
import { isAllowed, canSeeCustomers, PRIVATE_MESSAGE } from '../lib/access.js';
import { catalogForForm, knownCustomer } from '../lib/workflow.js';
import { readJson, fail, targetOptions } from '../lib/http.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
    const body = await readJson(req);
    const init = verifyInitData(body.initData);
    // Private bot: only admins and members of your groups get past here
    if (!(await isAllowed(init.user.id, groupFromStartParam(init.start_param)))) throw httpError(403, PRIVATE_MESSAGE);
    // "Is this a saved customer?" from someone who can't see the list: yes or no only
    if (body.checkName !== undefined) {
      return res.status(200).json({ ok: true, known: await knownCustomer(String(body.checkName)) });
    }
    const showCustomers = await canSeeCustomers(init.user);
    const [catalog, targets] = await Promise.all([catalogForForm({ showCustomers }), targetOptions(init)]);
    res.status(200).json({ ok: true, ...catalog, targets, user: { name: init.user.first_name } });
  } catch (err) {
    fail(res, err);
  }
}
