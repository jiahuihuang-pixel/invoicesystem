/**
 * The server's way in to the invoice drawing code, which lives in
 * public/render/ so the Template Studio page can run the very same code in
 * the browser for its preview.
 */
import { readFile } from 'node:fs/promises';
import { renderInvoicePdf as render } from '../public/render/render.js';

// The Thai font files, bundled with the app (vercel.json includeFiles)
const FONTS = new URL('../public/render/fonts/', import.meta.url);
const loadFont = async (name) => new Uint8Array(await readFile(new URL(name, FONTS)));

/** The invoice as a PDF, in a Node Buffer. */
export async function renderInvoicePdf(inv) {
  return Buffer.from(await render(inv, { loadFont }));
}
