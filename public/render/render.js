/**
 * Draws the invoice. Used by the server for real PDFs and by the Template
 * Studio page for its live preview, so both always match.
 *
 * Two layouts, picked by the country's `layout`:
 *   'sg'      the Templates tab design. Letterhead, title, labels and
 *             footer come from the country's template (template.js);
 *             the table and totals are fixed.
 *   'simple'  the old Hong Kong proforma design, not templated.
 *
 * Coordinates are top-down (distance from the top of the page, in points),
 * as measured off the original PDFs; `Y()` flips them for pdf-lib.
 * Returns the PDF as a Uint8Array.
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { LOGO_JPG_BASE64, LOGO_GREY_JPG_BASE64 } from './logo.js';
import { resolveTemplate, fieldValues, fill as fillFields } from './template.js';

const W = 595.92, H = 842.88;
// Pages are drawn as if they were very tall, then moved (and, when there is
// too much to fit, shrunk evenly) onto the A4 page by finishPage().
const BIG = 3000;
const Y = (top) => BIG - top;
const BLACK = rgb(0, 0, 0);
const WHITE = rgb(1, 1, 1);
const LINK = rgb(0x11 / 255, 0x55 / 255, 0xcc / 255);
const HEAD_FILL = rgb(0.847, 0.847, 0.847);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 10-Jul-26. Dates from the sheet arrive as UTC midnight of the sheet's local date. */
function formatDate(d) {
  d = d instanceof Date ? d : new Date(d);
  return `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${String(d.getUTCFullYear()).slice(-2)}`;
}

function money(n) {
  const r = Math.round((Math.abs(n) + Number.EPSILON) * 100) / 100;
  return r.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function hex(c, fallback = BLACK) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(c || '').trim());
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return rgb((n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

const num = (v, d) => (v === '' || v == null || isNaN(Number(v)) ? d : Number(v));

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
  pdf.setAuthor((inv.country.company && inv.country.company.name) || '');
  let page = pdf.addPage([W, H]);                         // the tools below draw on whichever page is current
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);
  const boldItalic = await pdf.embedFont(StandardFonts.HelveticaBoldOblique);
  const fontFor = (b, i) => (b ? (i ? boldItalic : bold) : (i ? italic : reg));

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
  const fillRect = (x1, t1, x2, t2, color) =>
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
    fill: (x1, t1, x2, t2, c) => fillRect(x1, t1 + d, x2, t2 + d, c)
  });

  /**
   * Word-wraps to `width`; returns the top of the line after the last one.
   * With `dry`, only measures (for fitting the table to the page).
   */
  const para = (s, x, top, width, { size = 6.3, font = reg, leading = size * 1.2, dry = false, ...o } = {}) => {
    const put = (t, at) => { if (!dry) text(t, x, at, { size, font, ...o }); };
    for (const paragraph of String(s == null ? '' : s).split(/\r?\n/)) {
      const words = clean(paragraph).split(' ').filter(Boolean);
      let lineText = '';
      for (const w of words) {
        const next = lineText ? lineText + ' ' + w : w;
        if (lineText && font.widthOfTextAtSize(next, size) > width) {
          put(lineText, top); top += leading; lineText = w;
        } else lineText = next;
      }
      if (lineText) put(lineText, top);
      top += leading;                                     // blank lines keep their space
    }
    return top;
  };
  const newPage = () => { page = pdf.addPage([W, H]); };

  /**
   * Puts what was drawn onto the A4 page. `contentBottom` is how far down
   * the page's content reaches: up to A4 it is placed as drawn, beyond that
   * everything is scaled down evenly (and centred) until it fits.
   */
  const finishPage = (contentBottom) => {
    const s = contentBottom > H ? H / contentBottom : 1;
    const tx = (W - W * s) / 2;
    if (s !== 1) page.scaleContent(s, s);
    page.translateContent(tx, H - s * BIG);
    return { s, tx };
  };

  const draw = { text, para, line, box, fill: fillRect, image, reg, bold, italic, fontFor, shifted, newPage, finishPage };
  if (inv.country.layout === 'simple') { await drawSimple(inv, draw); finishPage(H); }
  else await drawSingapore(inv, draw);

  return pdf.save();
}


/* =====================================================================
 * THE TEMPLATED DESIGN (Singapore, and every country by default)
 * ===================================================================== */

/**
 * Up to ITEMS_PER_PAGE items per page. Every page repeats the letterhead,
 * title, bill-to and invoice details; S/N numbering carries on; totals and
 * the footer come only on the last page. The discount line always goes on
 * the last page, after the items.
 */
export const ITEMS_PER_PAGE = 20;

async function drawSingapore(inv, tools) {
  const per = inv.itemsPerPage || ITEMS_PER_PAGE;
  const items = inv.lines.filter((l) => !l.isDiscount);
  const pages = [];
  for (let i = 0; i < items.length; i += per) pages.push(items.slice(i, i + per));
  if (!pages.length) pages.push([]);
  pages[pages.length - 1].push(...inv.lines.filter((l) => l.isDiscount));

  let start = 0;
  for (let p = 0; p < pages.length; p++) {
    if (p) tools.newPage();
    const needed = await drawPage(inv, tools, { lines: pages[p], start, page: p, pages: pages.length });
    const fit = tools.finishPage(needed);
    // The Template Studio's click areas must shrink with the page
    if (p === 0 && inv.spots && fit.s !== 1) {
      inv.spots.forEach((sp) => { sp.x = fit.tx + sp.x * fit.s; sp.top *= fit.s; sp.w *= fit.s; sp.h *= fit.s; });
    }
    start += pages[p].length;
  }
}

async function drawPage(inv, { text, para, line, box, fill, image, bold, fontFor, shifted }, pg) {
  const T = resolveTemplate(inv.country);
  const lastPage = pg.page === pg.pages - 1;
  // The Template Studio passes inv.spots = [] to learn where each editable
  // item landed (page points, top-down), so it can be clicked and dragged.
  const spot = (path, x, top, w, h, kind = 'text') => {
    if (inv.spots && pg.page === 0) inv.spots.push({ path, x, top, w: Math.max(w, 6), h: Math.max(h, 4), kind });
  };
  const values = fieldValues(inv.country);
  const f = (s) => fillFields(s, values);
  // The table's bottom edge is worked out below, once the footer has been measured
  const TABLE = { left: 64.1, right: 522.1, top: 208.5, headBottom: 225.2, bottom: 480.7 };
  const COLS = [64.1, 123.5, 299.1, 358.1, 431.6, 522.1];   // S/N | DESCRIPTION | QTY | UNIT PRICE | AMOUNT
  const ROW_H = 19.65;                                      // the sheet's row height: 13 rows in the original table
  const RIGHT = TABLE.right;

  /* ---- Logo -------------------------------------------------------- */
  const L = T.logo || {};
  if (L.show !== false) {
    const size = num(L.size, 59);
    await image(LOGO_JPG_BASE64, num(L.x, 58.5), num(L.top, 72.6), size, size);
    spot(['logo'], num(L.x, 58.5), num(L.top, 72.6), size, size, 'logo');
  }

  /* ---- Letterhead: a stack of lines -------------------------------- */
  // Each line: optional bold label, then the text. A line whose text uses
  // only blank fields is left out. `gap` adds space above a line.
  const X = num(T.header.x, 124.8);
  let top = num(T.header.top, 70.2);
  let lastTop = top;
  let first = true;
  const lines = T.header.lines || [];
  for (let li = 0; li < lines.length; li++) {
    const ln = lines[li];
    const value = f(ln.text);
    if (!value) continue;
    const size = num(ln.size, 6.8);
    const lh = num(ln.lineHeight, size * 1.2);
    if (!first) top += num(ln.gap, 0);
    first = false;
    lastTop = top;
    const label = f(ln.label);
    const color = ln.link ? LINK : hex(ln.color);
    let x = X;
    const lineTop = top;
    if (label) x += text(label, X, top, { size, font: fontFor(ln.labelBold !== false, ln.italic) });
    if (ln.wrap) {
      top = para(value, x, top, RIGHT - x, { size, font: fontFor(ln.bold, ln.italic), leading: lh, color });
      spot(['header', 'lines', li], X, lineTop, RIGHT - X, top - lineTop, 'header');
    } else {
      const w = text(value, x, top, { size, font: fontFor(ln.bold, ln.italic), color, maxWidth: RIGHT - x });
      if (ln.link) line(x, top + size * 1.01, x + w, top + size * 1.01, 0.43);
      spot(['header', 'lines', li], X, lineTop, x - X + w, lh, 'header');
      top += lh;
    }
  }
  let bottom = Math.max(top, num(L.top, 72.6) + (L.show === false ? 0 : num(L.size, 59)));

  /* ---- Stamp (e.g. <ORIGINAL>) ------------------------------------- */
  const S = T.stamp || {};
  const stamp = f(S.text);
  if (stamp) {
    const size = num(S.size, 9);
    const stampTop = S.top === null || S.top === '' || S.top === undefined ? lastTop - 1 : num(S.top, lastTop - 1);
    const sw = text(stamp, num(S.right, RIGHT), stampTop, { size, font: bold, color: hex(S.color, rgb(0.9, 0.07, 0.07)), align: 'right' });
    spot(['stamp'], num(S.right, RIGHT) - sw, stampTop, sw, size * 1.2, 'stamp');
  }

  /* ---- Title, then everything below moves down to make room --------- */
  const TT = T.title || {};
  const titleText = f(inv.docType === 'Quotation' ? TT.quotation
                    : inv.docType === 'Proforma Invoice' ? TT.proforma : TT.invoice) || inv.docType.toUpperCase();
  const titleTop = Math.max(138, bottom + num(TT.gap, 7));
  const titleW = text(titleText, num(TT.x, 65.8), titleTop, { size: num(TT.size, 14), font: bold, maxWidth: RIGHT - num(TT.x, 65.8) });
  const titleKey = inv.docType === 'Quotation' ? 'quotation' : inv.docType === 'Proforma Invoice' ? 'proforma' : 'invoice';
  spot(['title', titleKey], num(TT.x, 65.8), titleTop, titleW, num(TT.size, 14) * 1.2, 'title');
  ({ text, line, box, fill } = shifted(16 + (titleTop - 138)));
  const shift = 16 + (titleTop - 138);
  const textOnPage = text, lineOnPage = line, spotOnPage = spot;
  const LB = T.labels || {};

  /* ---- Bill to ----------------------------------------------------- */
  spot(['labels', 'billTo'], 65.8, 151.1 + shift, text(f(LB.billTo), 65.8, 151.1, { size: 6.8, font: bold }), 8.2);
  text(inv.customer, 124.8, 151.1, { size: 6.8, font: bold, maxWidth: 230 });
  const billLines = [...String(inv.address || '').split(/\r?\n/), inv.email]
    .map((s) => String(s || '').trim()).filter(Boolean).slice(0, 5);
  billLines.forEach((s, i) => text(s, 124.8, 161.3 + i * 8.1, { size: 6.8, maxWidth: 230 }));

  /* ---- Invoice no / PO / date / terms ------------------------------ */
  const meta = [[LB.invoiceNo, inv.invoiceId, 'invoiceNo'], [LB.po, inv.po, 'po'], [LB.date, formatDate(inv.date), 'date'],
                [LB.terms, inv.terms, 'terms']];
  meta.forEach(([label, value, k], i) => {
    const t = 151.1 + i * 10.23;
    const lw = text(f(label), 431.1, t, { size: 6.8, align: 'right' });
    spot(['labels', k], 431.1 - lw, t + shift, lw, 8.2);
    text(value, 476.6, t, { size: 6.8, align: 'center', maxWidth: 88 });
    line(431.1, t + 8.9, 522.1, t + 8.9, 0.43);
  });

  /* ---- Items table, stretched to fill the page ----------------------- */
  // Everything below the table (totals, bank details, notes, signatures,
  // footnote) is measured first; the table then runs down to meet it, so
  // the footer sits near the bottom of the A4 page. The table always has
  // room for its rows at the sheet's spacing (at least 13 of them); if that
  // plus the footer is taller than A4, the whole page is shrunk to fit.
  const F = T.footer || {};
  const PAGE_BOTTOM = H - 30 - shift;                       // 30pt margin, in the moved-down coordinates
  const footerHeight = drawFooter(0, true);
  const natural = TABLE.headBottom + Math.max(13, pg.lines.length) * ROW_H;
  TABLE.bottom = Math.max(natural, PAGE_BOTTOM - 58.8 - footerHeight);
  const needed = TABLE.bottom + 58.8 + footerHeight + 30 + shift;   // how tall this page is, before shrinking
  const TOTALS = [0, 10.3, 20.5, 30.8].map((d) => TABLE.bottom + d);   // SUB-TOTAL / GST / GRAND TOTAL rows

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
  const sym = String(inv.country.symbol || '$').trim();
  const amountCell = (n, dollarX, rightX, t, opts = {}) => {
    if (n == null) return;
    text(sym, dollarX, t, opts);
    text(n < 0 ? `(${money(n)})` : money(n), n < 0 ? rightX + 2.1 : rightX, t, { ...opts, align: 'right' });
  };

  const rowH = ROW_H;
  pg.lines.forEach((l, i) => {
    const t = TABLE.headBottom + rowH * 0.56 + i * rowH;
    text(String(pg.start + i + 1), mid(0), t, { align: 'center' });
    text(l.description, 124.8, t, { maxWidth: COLS[2] - 124.8 - 2 });
    if (l.qty != null) text(String(l.qty), mid(2), t, { align: 'center' });
    if (l.unit != null) amountCell(l.unit, 361.4, 425.7, t);
    if (l.amount != null) amountCell(l.amount, 434.9, 516.3, t);
    else if (!l.isDiscount) text('price?', 516.3, t, { align: 'right' });   // not on the Product list
  });

  if (pg.pages > 1) {
    text(`Page ${pg.page + 1} of ${pg.pages}`, RIGHT, Math.max(H, needed) - 24 - shift, { size: 6.3, align: 'right' });
  }
  if (!lastPage) {
    text('Continued on next page', 516.3, TABLE.bottom + 4, { font: bold, align: 'right' });
    return needed;
  }

  /* ---- Totals ------------------------------------------------------ */
  // With tax: SUB-TOTAL / 9% GST / GRAND TOTAL. Without: GRAND TOTAL only,
  // on the bottom row, so the currency note beside it stays put.
  const taxRate = inv.country.taxRate || 1;
  const taxPct = Math.round((taxRate - 1) * 1000) / 10;
  const rows = taxRate > 1
    ? [['SUB-TOTAL', inv.subtotal], [`${taxPct}% ${String(inv.country.taxName || 'GST').toUpperCase()}`, inv.gst], ['GRAND TOTAL', inv.total]]
    : [['GRAND TOTAL', inv.total]];
  const firstRow = TOTALS.length - 1 - rows.length;          // index of the top edge
  box(COLS[3], TOTALS[firstRow], TABLE.right, TOTALS[3]);
  line(COLS[4], TOTALS[firstRow], COLS[4], TOTALS[3]);
  for (let i = firstRow + 1; i < 3; i++) line(COLS[3], TOTALS[i], TABLE.right, TOTALS[i]);
  rows.forEach(([label, n], i) => {
    const t = TOTALS[firstRow + i] + 1.0;
    text(label, 429.0, t, { font: bold, align: 'right' });
    amountCell(n, 434.9, 516.3, t);
  });
  spot(['labels', 'currencyNote'], 65.8, TABLE.bottom + 22.1 + shift,
       text(f(LB.currencyNote), 65.8, TABLE.bottom + 22.1, { font: bold }), 7.6);
  drawFooter(TABLE.bottom + 58.8, false);
  return needed;

  /* ---- Footer: bank details, notes, signatures, footnote ------------ */
  // Flows down the page from `y0`, so a longer bank block or notes push
  // the rest down. With `dry`, draws nothing and returns the height, which
  // is how the table knows how far down it can stretch.
  function drawFooter(y0, dry) {
  const T0 = y0;
  const text = dry ? (s, x, t, o = {}) => 0 : textOnPage;
  const line = dry ? () => {} : lineOnPage;
  const spot = dry ? () => {} : spotOnPage;
  let y = y0;
  if (F.showBank !== false) {
    const title = f(F.bankTitle);
    if (title) {
      const bw = text(title, 65.8, y, { size: 6.8, font: bold });
      spot(['footer', 'bankTitle'], 65.8, y + shift, bw, 8.2);
      line(65.8, y + 6.8, 65.8 + bw, y + 6.8, 0.43);
      y += 10.3;
    }
    const bankSize = num(F.bankSize, 6.3);
    const step = bankSize * 1.56;                            // 9.83 at the original 6.3pt
    const bankTop = y;
    for (const raw of f(F.bank).split(/\r?\n/)) {
      const l = raw.trim();
      if (!l) continue;                                      // groups are one continuous list here
      const i = l.indexOf(':');
      if (i >= 0) {
        text(l.slice(0, i + 1), 65.8, y, { size: bankSize });
        text(l.slice(i + 1).trim(), 124.8, y, { size: bankSize, maxWidth: RIGHT - 124.8 });
      } else {
        text(l, 65.8, y, { size: bankSize, maxWidth: RIGHT - 65.8 });
      }
      y += step;
    }
    if (y > bankTop) spot(['footer', 'bank'], 65.8, bankTop + shift, RIGHT - 65.8, y - bankTop, 'block');
  }

  const notes = f(F.notes);
  if (notes.trim()) {
    y += 6;
    const size = num(F.notesSize, 5.5);
    // para() works in page coordinates; add the shift back in and take it out again
    const notesTop = y;
    y = para(notes, 65.8, y + shift, RIGHT - 65.8, { size, leading: size * 1.3, dry }) - shift;
    spot(['footer', 'notes'], 65.8, notesTop + shift, RIGHT - 65.8, y - notesTop, 'block');
  }

  const sigs = (F.signatures || []).filter((s) => s && (s.label || '').trim());
  if (sigs.length) {
    y += num(F.signatureSpace, 30);                          // room to sign above the line
    const span = RIGHT - 65.8;
    const slot = span / sigs.length;
    const width = Math.min(num(F.signatureWidth, 150), slot - 20);
    sigs.forEach((s, i) => {
      const x = 65.8 + i * slot;
      line(x, y, x + width, y, 0.6);
      text(f(s.label), x, y + 3, { size: 6.3 });
      spot(['footer', 'signatures', (F.signatures || []).indexOf(s)], x, y - 12 + shift, width, 22, 'signature');
    });
    y += 14;
  }

  const foot = f(F.footnote);
  if (foot) {
    const fw = text(foot, 65.8, y + 10.1, { size: num(F.footnoteSize, 4.6), maxWidth: RIGHT - 65.8 });
    spot(['footer', 'footnote'], 65.8, y + 10.1 + shift, fw, num(F.footnoteSize, 4.6) * 1.3);
    y += 10.1 + num(F.footnoteSize, 4.6) * 1.2;
  }
  return y - T0;
  }
}


/* =====================================================================
 * THE OLD HONG KONG PROFORMA DESIGN (Layout = simple)
 * ===================================================================== */

async function drawSimple(inv, { text, line, fill, image, reg, bold }) {
  const C = inv.country.company;
  const cur = inv.country.currency + ' ';
  const S = 11;                                   // everything is 11pt
  const COLS = [36.5, 110.7, 292.2, 424.3, 556.3]; // Qty | Description | Unit Price | Total
  const TOP = 294.9, HEAD_BOTTOM = 308.7, BOTTOM = 568.5;
  const cash = (n) => (n < 0 ? '-' : '') + cur + money(n);

  await image(LOGO_GREY_JPG_BASE64, 36.0, 42.0, 139.4, 138.4);

  [['Date:', formatDate(inv.date)],
   [`${inv.docType} No.:`, inv.invoiceId],
   ['PO Number:', inv.po],
   ['Terms:', inv.terms]].forEach(([label, value], i) => {
    const top = 131.6 + i * 13.7;
    text(label, 294.3, top, { size: S, font: bold });
    text(value, 426.3, top, { size: S, maxWidth: 556 - 426.3 });
  });

  const billTop = 186.3 + 13.7;
  text('Bill To:', 38.5, billTop, { size: S, font: bold });
  text('Ship To:', 294.3, billTop, { size: S, font: bold });
  const addr = String(inv.address || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (addr.length > 3) addr.splice(2, addr.length, addr.slice(2).join(', '));
  const bill = [inv.customer, ...addr, inv.email ? 'Email: ' + inv.email : ''].filter(Boolean);
  bill.forEach((s, i) => text(s, 38.5, billTop + 14.1 + i * 13.7, { size: S, maxWidth: 250 }));

  fill(COLS[0], TOP, COLS[4], HEAD_BOTTOM, BLACK);
  COLS.forEach((x) => line(x, TOP, x, BOTTOM, 1));
  line(COLS[0], HEAD_BOTTOM, COLS[4], HEAD_BOTTOM, 1);
  line(COLS[0], BOTTOM, COLS[4], BOTTOM, 1);

  text('Qty', (COLS[0] + COLS[1]) / 2, 296.4, { size: S, font: bold, color: WHITE, align: 'center' });
  text('Description', 112.7, 296.4, { size: S, font: bold, color: WHITE });
  text('Unit Price', 422.3, 296.4, { size: S, font: bold, color: WHITE, align: 'right' });
  text('Total', 554.2, 296.4, { size: S, font: bold, color: WHITE, align: 'right' });

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

  function wrapText(s, x, top, width, room) {
    s = String(s);
    if (reg.widthOfTextAtSize(clean(s), S) <= width) return text(s, x, top, { size: S });
    const size = 9.5, words = s.split(/\s+/);
    let firstLine = '';
    while (words.length && reg.widthOfTextAtSize(clean((firstLine + ' ' + words[0]).trim()), size) <= width) {
      firstLine = (firstLine + ' ' + words.shift()).trim();
    }
    if (!firstLine || room < 22) return text(s, x, top, { size: S, maxWidth: width });
    text(firstLine, x, top, { size });
    text(words.join(' '), x, top + 10.5, { size, maxWidth: width });
  }

  text('Total', 294.3, 569.4 + 2, { size: S, font: bold });
  text(cash(inv.total), 554.0, 569.4 + 2, { size: S, font: bold, align: 'right' });

  const hw = text('Bank details as follow:', 38.5, 610.5, { size: S, font: bold });
  line(38.5, 621.7, 38.5 + hw, 621.7, 1.1);
  let top = 637.9;
  (C.bankBlocks || []).forEach((block) => {
    block.forEach((s) => { text(s, 38.5, top, { size: S, font: bold, maxWidth: 520 }); top += 13.7; });
    top += 13.7;
  });
}
