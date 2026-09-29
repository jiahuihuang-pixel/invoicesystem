/**
 * Draws the invoice. Two layouts, picked by the country's `layout`:
 *
 *   'sg'      the Templates tab design (gold logo, GST breakdown). Positions
 *             measured off the tab's own PDF export.
 *   'simple'  the Hong Kong proforma design (grey logo, no tax). Positions
 *             measured off TC_Acoustic_Performa_Invoice_..._20260817.pdf.
 *
 * Coordinates are written top-down (distance from the top of the page, in
 * points) to match those measurements; `Y()` flips them for pdf-lib.
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { money } from './invoice.js';
import { LOGO_JPG_BASE64, LOGO_GREY_JPG_BASE64 } from './logo.js';

const W = 595.92, H = 842.88;
const Y = (top) => H - top;
const BLACK = rgb(0, 0, 0);
const WHITE = rgb(1, 1, 1);
const LINK = rgb(0x11 / 255, 0x55 / 255, 0xcc / 255);
const HEAD_FILL = rgb(0.847, 0.847, 0.847);
const STAMP_RED = rgb(0.9, 0.07, 0.07);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 10-Jul-26. Dates from the sheet arrive as UTC midnight of the sheet's local date. */
function formatDate(d) {
  return `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${String(d.getUTCFullYear()).slice(-2)}`;
}

/**
 * Helvetica can only print Latin-1 characters. Straighten the usual
 * suspects and replace anything else with "?" instead of crashing.
 */
function clean(s) {
  return String(s == null ? '' : s)
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...')
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
}


export async function renderInvoicePdf(inv) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${inv.docType} ${inv.invoiceId}`);
  pdf.setAuthor(inv.country.company.name);
  const page = pdf.addPage([W, H]);
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);

  // top = top edge of the text box, as measured; baseline sits ~0.905 em below
  const text = (s, x, top, { size = 6.3, font = reg, color = BLACK, align = 'left', maxWidth } = {}) => {
    s = clean(s);
    let w = font.widthOfTextAtSize(s, size);
    if (maxWidth && w > maxWidth) {                       // shrink to fit, never below 4.5pt
      size = Math.max(4.5, size * maxWidth / w);
      w = font.widthOfTextAtSize(s, size);
    }
    const dx = align === 'right' ? -w : align === 'center' ? -w / 2 : 0;
    page.drawText(s, { x: x + dx, y: Y(top + size * 0.905), size, font, color });
    return w;
  };
  const line = (x1, t1, x2, t2, thickness = 0.6) =>
    page.drawLine({ start: { x: x1, y: Y(t1) }, end: { x: x2, y: Y(t2) }, thickness, color: BLACK });
  const box = (x1, t1, x2, t2, thickness = 0.85) =>
    page.drawRectangle({ x: x1, y: Y(t2), width: x2 - x1, height: t2 - t1, borderColor: BLACK, borderWidth: thickness });
  const fill = (x1, t1, x2, t2, color) =>
    page.drawRectangle({ x: x1, y: Y(t2), width: x2 - x1, height: t2 - t1, color });
  // Hand pdf-lib the base64 text, not a Node Buffer: it reads a Buffer's
  // bytes from the wrong place when Node has packed it into a shared block,
  // and then fails with "SOI not found in JPEG".
  const image = async (b64, x, top, w, h) =>
    page.drawImage(await pdf.embedJpg(b64), { x, y: Y(top + h), width: w, height: h });

  // The same tools with everything moved down by `d` points
  const shifted = (d) => ({
    text: (s, x, top, o) => text(s, x, top + d, o),
    line: (x1, t1, x2, t2, th) => line(x1, t1 + d, x2, t2 + d, th),
    box: (x1, t1, x2, t2, th) => box(x1, t1 + d, x2, t2 + d, th),
    fill: (x1, t1, x2, t2, c) => fill(x1, t1 + d, x2, t2 + d, c)
  });

  /** Word-wraps to `width`; returns the top of the line after the last one. */
  const para = (s, x, top, width, { size = 6.3, font = reg, leading = size * 1.2, ...o } = {}) => {
    const words = clean(s).split(' ').filter(Boolean);
    let lineText = '';
    for (const w of words) {
      const next = lineText ? lineText + ' ' + w : w;
      if (lineText && font.widthOfTextAtSize(next, size) > width) {
        text(lineText, x, top, { size, font, ...o }); top += leading; lineText = w;
      } else lineText = next;
    }
    if (lineText) { text(lineText, x, top, { size, font, ...o }); top += leading; }
    return top;
  };

  const draw = { text, para, line, box, fill, image, reg, bold, italic, shifted };
  if (inv.country.layout === 'sg') await drawSingapore(inv, draw);
  else await drawSimple(inv, draw);

  return Buffer.from(await pdf.save());
}


/* =====================================================================
 * SINGAPORE: the Templates tab
 * ===================================================================== */

async function drawSingapore(inv, { text, para, line, box, fill, image, bold, italic, shifted }) {
  const C = inv.country.company;
  const TABLE = { left: 64.1, right: 522.1, top: 208.5, headBottom: 225.2, bottom: 480.7 };
  const COLS = [64.1, 123.5, 299.1, 358.1, 431.6, 522.1];   // S/N | DESCRIPTION | QTY | UNIT PRICE | AMOUNT
  const ROW_H = 19.65, ROWS = 13;
  const TOTALS = [480.7, 491.0, 501.2, 511.5];              // SUB-TOTAL / GST / GRAND TOTAL rows

  /* ---- Letterhead -------------------------------------------------- */
  // Two styles, picked by the Countries tab "Header Style" column:
  //   standard  small bold name, then label/value lines (the Singapore sheet)
  //   large     big name, address in italics under it, then the labelled
  //             lines (the Thailand sheet)
  await image(LOGO_JPG_BASE64, 58.5, 72.6, 59, 59);
  const X = 124.8, RIGHT = 522.1;
  const regLabel = C.regLabel || `${inv.country.taxName} Reg No.`;
  let bottom;                                   // where the letterhead ends

  if (C.headerStyle === 'large') {
    text(C.name, X, 74, { size: 13, font: bold, maxWidth: RIGHT - X });
    let top = C.store ? para(C.store, X, 91, RIGHT - X, { size: 6.8, font: italic, leading: 8.2 }) : 91;
    top += 5;
    const lines = [[regLabel + ': ', C.gstRegNo], ['Tel: ', C.tel], ['Website: ', C.website], ['Email: ', C.email]]
      .filter(([, v]) => v);
    lines.forEach(([label, value], i) => {
      const w = text(label, X, top + i * 9, { size: 7.5, font: bold });
      text(value, X + w, top + i * 9, { size: 7.5 });
    });
    const last = top + Math.max(lines.length - 1, 0) * 9;
    if (C.stamp) text(C.stamp, RIGHT, last - 1, { size: 9, font: bold, color: STAMP_RED, align: 'right' });
    bottom = last + 9;
  } else {
    text(C.name, X, 91.3, { font: bold });
    const lines = [[regLabel + ': ', C.gstRegNo], [`${C.storeLabel}: `, C.store], ['Tel: ', C.tel],
                   ['Website: ', C.website], ['Email: ', C.email]].filter(([, v]) => v);
    lines.forEach(([label, value], i) => {
      const top = 99.0 + i * 7.7;
      const w = text(label, X, top, { font: bold });
      const isLink = label.startsWith('Website');
      const vw = text(value, X + w, top, { color: isLink ? LINK : BLACK });
      if (isLink) line(X + w, top + 6.4, X + w + vw, top + 6.4, 0.43);
    });
    if (C.stamp) text(C.stamp, RIGHT, 99.0 + Math.max(lines.length - 1, 0) * 7.7, { size: 8, font: bold, color: STAMP_RED, align: 'right' });
    bottom = 99.0 + lines.length * 7.7;
  }
  bottom = Math.max(bottom, 131.6);             // never above the bottom of the logo

  // Document title under the logo, lined up with BILL TO. Everything below
  // moves down to make room for it and for a tall letterhead.
  const title = inv.docType === 'Invoice' && C.invoiceTitle ? C.invoiceTitle : inv.docType.toUpperCase();
  const titleTop = Math.max(138, bottom + 7);
  text(title, 65.8, titleTop, { size: 14, font: bold, maxWidth: RIGHT - 65.8 });
  ({ text, line, box, fill } = shifted(16 + (titleTop - 138)));

  /* ---- Bill to ----------------------------------------------------- */
  text('BILL TO', 65.8, 151.1, { size: 6.8, font: bold });
  text(inv.customer, 124.8, 151.1, { size: 6.8, font: bold, maxWidth: 230 });
  const billLines = [...String(inv.address).split(/\r?\n/), inv.email]
    .map((s) => String(s).trim()).filter(Boolean).slice(0, 5);
  billLines.forEach((s, i) => text(s, 124.8, 161.3 + i * 8.1, { size: 6.8, maxWidth: 230 }));

  /* ---- Invoice no / PO / date / terms ------------------------------ */
  const meta = [['Invoice No:', inv.invoiceId], ['PO No.:', inv.po],
                ['Date:', formatDate(inv.date)], ['Terms:', inv.terms]];
  meta.forEach(([label, value], i) => {
    const top = 151.1 + i * 10.23;
    text(label, 431.1, top, { size: 6.8, align: 'right' });
    text(value, 476.6, top, { size: 6.8, align: 'center', maxWidth: 88 });
    line(431.1, top + 8.9, 522.1, top + 8.9, 0.43);
  });

  /* ---- Items table ------------------------------------------------- */
  fill(TABLE.left, TABLE.top, TABLE.right, TABLE.headBottom, HEAD_FILL);
  box(TABLE.left, TABLE.top, TABLE.right, TABLE.bottom);
  line(TABLE.left, TABLE.headBottom, TABLE.right, TABLE.headBottom);
  COLS.slice(1, -1).forEach((x) => line(x, TABLE.top, x, TABLE.bottom));

  const mid = (i) => (COLS[i] + COLS[i + 1]) / 2;
  ['S/N', 'DESCRIPTION', 'UNIT QUANTITY', 'UNIT PRICE', 'AMOUNT']
    .forEach((h, i) => text(h, mid(i), 215.7, { align: 'center' }));

  // Accounting format, like the sheet: "$" (or HKD, MYR...) on the left,
  // figure on the right, negatives in brackets with the ")" hanging past
  // the digits.
  const sym = inv.country.symbol.trim();
  const amountCell = (n, dollarX, rightX, top, opts = {}) => {
    if (n == null) return;
    text(sym, dollarX, top, opts);
    text(n < 0 ? `(${money(n)})` : money(n), n < 0 ? rightX + 2.1 : rightX, top, { ...opts, align: 'right' });
  };

  inv.lines.slice(0, ROWS).forEach((l, i) => {
    const top = 236.2 + i * ROW_H;
    text(String(i + 1), mid(0), top, { align: 'center' });
    text(l.description, 124.8, top, { maxWidth: COLS[2] - 124.8 - 2 });
    if (l.qty != null) text(String(l.qty), mid(2), top, { align: 'center' });
    if (l.unit != null) amountCell(l.unit, 361.4, 425.7, top);
    if (l.amount != null) amountCell(l.amount, 434.9, 516.3, top);
    else if (!l.isDiscount) text('price?', 516.3, top, { align: 'right' });   // not on the Product list
  });

  /* ---- Totals ------------------------------------------------------ */
  // With tax: SUB-TOTAL / 9% GST / GRAND TOTAL. Without: GRAND TOTAL only,
  // on the bottom row, so the currency note beside it stays put.
  const taxPct = Math.round((inv.country.taxRate - 1) * 1000) / 10;
  const rows = inv.country.taxRate > 1
    ? [['SUB-TOTAL', inv.subtotal], [`${taxPct}% ${inv.country.taxName.toUpperCase()}`, inv.gst], ['GRAND TOTAL', inv.total]]
    : [['GRAND TOTAL', inv.total]];
  const first = TOTALS.length - 1 - rows.length;             // index of the top edge
  box(COLS[3], TOTALS[first], TABLE.right, TOTALS[3]);
  line(COLS[4], TOTALS[first], COLS[4], TOTALS[3]);
  for (let i = first + 1; i < 3; i++) line(COLS[3], TOTALS[i], TABLE.right, TOTALS[i]);
  rows.forEach(([label, n], i) => {
    const top = TOTALS[first + i] + 1.0;
    text(label, 429.0, top, { font: bold, align: 'right' });
    amountCell(n, 434.9, 516.3, top);
  });
  text(C.currencyNote, 65.8, 502.8, { font: bold });

  /* ---- Bank details ------------------------------------------------ */
  const bw = text('BANK ACCOUNT DETAILS:', 65.8, 539.5, { size: 6.8, font: bold });
  line(65.8, 546.3, 65.8 + bw, 546.3, 0.43);
  C.bankPairs.forEach(([label, value], i) => {
    const top = 549.8 + i * 9.83;
    text(label, 65.8, top);
    text(value, 124.8, top);
  });
  text(C.footnote, 65.8, 628.7, { size: 4.6 });
}


/* =====================================================================
 * HONG KONG and the other countries: the proforma design
 * ===================================================================== */

async function drawSimple(inv, { text, line, fill, image, reg, bold }) {
  const C = inv.country.company;
  const cur = inv.country.currency + ' ';
  const S = 11;                                   // everything is 11pt
  const COLS = [36.5, 110.7, 292.2, 424.3, 556.3]; // Qty | Description | Unit Price | Total
  const TOP = 294.9, HEAD_BOTTOM = 308.7, BOTTOM = 568.5;
  const cash = (n) => (n < 0 ? '-' : '') + cur + money(n);

  await image(LOGO_GREY_JPG_BASE64, 36.0, 42.0, 139.4, 138.4);

  /* ---- Date / number / PO ------------------------------------------ */
  [['Date:', formatDate(inv.date)],
   [`${inv.docType} No.:`, inv.invoiceId],
   ['PO Number:', inv.po],
   ['Terms:', inv.terms]].forEach(([label, value], i) => {
    const top = 131.6 + i * 13.7;
    text(label, 294.3, top, { size: S, font: bold });
    text(value, 426.3, top, { size: S, maxWidth: 556 - 426.3 });
  });

  /* ---- Bill to / ship to ------------------------------------------- */
  const billTop = 186.3 + 13.7;                   // one row lower than the sample: Terms took a line
  text('Bill To:', 38.5, billTop, { size: S, font: bold });
  text('Ship To:', 294.3, billTop, { size: S, font: bold });
  // Name, up to three address lines (extra lines are joined onto the third)
  // and the email: six rows at most, which is all the room above the table.
  const addr = String(inv.address).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (addr.length > 3) addr.splice(2, addr.length, addr.slice(2).join(', '));
  const bill = [inv.customer, ...addr, inv.email ? 'Email: ' + inv.email : ''].filter(Boolean);
  bill.forEach((s, i) => text(s, 38.5, billTop + 14.1 + i * 13.7, { size: S, maxWidth: 250 }));

  /* ---- Items table ------------------------------------------------- */
  fill(COLS[0], TOP, COLS[4], HEAD_BOTTOM, BLACK);
  COLS.forEach((x) => line(x, TOP, x, BOTTOM, 1));
  line(COLS[0], HEAD_BOTTOM, COLS[4], HEAD_BOTTOM, 1);
  line(COLS[0], BOTTOM, COLS[4], BOTTOM, 1);

  text('Qty', (COLS[0] + COLS[1]) / 2, 296.4, { size: S, font: bold, color: WHITE, align: 'center' });
  text('Description', 112.7, 296.4, { size: S, font: bold, color: WHITE });
  text('Unit Price', 422.3, 296.4, { size: S, font: bold, color: WHITE, align: 'right' });
  text('Total', 554.2, 296.4, { size: S, font: bold, color: WHITE, align: 'right' });

  // The sample spaces rows 27.3pt apart, which fits 9. Squeeze when there
  // are more, so 12 items and a discount still fit.
  const lines = inv.lines;
  const pitch = Math.min(27.3, (BOTTOM - 309.9 - 4) / Math.max(lines.length, 1));
  const descWidth = COLS[2] - 112.7 - 3;
  lines.forEach((l, i) => {
    const top = 309.9 + i * pitch;
    if (l.qty != null) text(String(l.qty), (COLS[0] + COLS[1]) / 2, top, { size: S, align: 'center' });
    wrapText(l.description, 112.7, top, descWidth, pitch);
    if (l.unit != null) text(cash(l.unit), 418.3, top, { size: S, align: 'right' });
    if (l.amount != null) text(cash(l.amount), 550.3, top, { size: S, align: 'right' });
    else if (!l.isDiscount) text('price?', 550.3, top, { size: S, align: 'right' });
  });

  // Long product names: two smaller lines rather than one tiny one
  function wrapText(s, x, top, width, room) {
    s = String(s);
    if (reg.widthOfTextAtSize(clean(s), S) <= width) return text(s, x, top, { size: S });
    const size = 9.5, words = s.split(/\s+/);
    let first = '';
    while (words.length && reg.widthOfTextAtSize(clean((first + ' ' + words[0]).trim()), size) <= width) {
      first = (first + ' ' + words.shift()).trim();
    }
    if (!first || room < 22) return text(s, x, top, { size: S, maxWidth: width });
    text(first, x, top, { size });
    text(words.join(' '), x, top + 10.5, { size, maxWidth: width });
  }

  /* ---- Total ------------------------------------------------------- */
  text('Total', 294.3, 569.4 + 2, { size: S, font: bold });
  text(cash(inv.total), 554.0, 569.4 + 2, { size: S, font: bold, align: 'right' });

  /* ---- Bank details ------------------------------------------------ */
  const hw = text('Bank details as follow:', 38.5, 610.5, { size: S, font: bold });
  line(38.5, 621.7, 38.5 + hw, 621.7, 1.1);
  let top = 637.9;
  C.bankBlocks.forEach((block) => {
    block.forEach((s) => { text(s, 38.5, top, { size: S, font: bold, maxWidth: 520 }); top += 13.7; });
    top += 13.7;
  });
}
