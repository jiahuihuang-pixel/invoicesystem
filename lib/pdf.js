/**
 * The server's way in to the invoice drawing code, which lives in
 * public/render/ so the Template Studio page can run the very same code in
 * the browser for its preview.
 */
import { renderInvoicePdf as render } from '../public/render/render.js';

/** The invoice as a PDF, in a Node Buffer. */
export async function renderInvoicePdf(inv) {
  return Buffer.from(await render(inv));
}
