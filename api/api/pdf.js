/**
 * GET /api/pdf?id=123&s=<signature>
 * The "PDF Link" written to the Tracker. Draws the invoice fresh from the
 * Tracker row each time, so it always matches the sheet. The signature
 * stops anyone guessing other invoice numbers.
 */
import { signedOk } from '../lib/telegram.js';
import { loadInvoice, fileName } from '../lib/invoice.js';
import { renderInvoicePdf } from '../lib/pdf.js';

export default async function handler(req, res) {
  const id = String(req.query.id || '');
  if (!id || !signedOk('pdf:' + id, String(req.query.s || ''), 16)) {
    return res.status(403).send('This link is not valid.');
  }
  try {
    const inv = await loadInvoice(id);
    const pdf = await renderInvoicePdf(inv);
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-disposition', `inline; filename="${fileName(inv).replace(/"/g, '')}"`);
    res.setHeader('cache-control', 'private, no-store');
    res.status(200).send(pdf);
  } catch (err) {
    console.error(err);
    res.status(500).send('Could not make the PDF: ' + err.message);
  }
}
