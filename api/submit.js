/**
 * POST /api/submit  { initData, form }
 * Saves the request, answers the form straight away, then makes the PDF
 * and sends it to you in the background.
 */
import { waitUntil } from '@vercel/functions';
import { verifyInitData, send, esc, mention, httpError, groupFromStartParam } from '../lib/telegram.js';
import { isAllowed, PRIVATE_MESSAGE } from '../lib/access.js';
import { submitRequest, notifyAdmins } from '../lib/workflow.js';
import { readJson, fail, targetOptions } from '../lib/http.js';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
    const body = await readJson(req);
    const init = verifyInitData(body.initData);
    // Private bot: only admins and members of your groups get past here
    if (!(await isAllowed(init.user.id, groupFromStartParam(init.start_param)))) throw httpError(403, PRIVATE_MESSAGE);
    const form = body.form || {};

    const { options } = await targetOptions(init);
    const target = options.find((o) => o.id === String(form.targetId)) || (options.length === 1 ? options[0] : null);
    if (!target) throw httpError(400, 'Choose where the invoice should be sent.');

    const out = await submitRequest(form, init.user, target);
    res.status(200).json({ ok: true, invoiceId: out.invoiceId, target: target.title });

    waitUntil((async () => {
      await send(target.id, `${mention(init.user)}, request <b>#${esc(out.invoiceId)}</b> for ` +
                            `<b>${esc(out.customer)}</b> is in. It will be posted here once approved.`)
        .catch((e) => console.warn('group notice failed: ' + e.message));
      await notifyAdmins(out.invoiceId, init.user);
    })());
  } catch (err) {
    fail(res, err);
  }
}
