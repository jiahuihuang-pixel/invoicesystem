/*
 * Template Studio: edit each country's invoice letterhead and footer with
 * a live preview. The preview is drawn right here in the browser by the
 * same code the server uses (render/render.js), so what you see is what
 * gets sent. Saving stores the template in the "Invoice Templates" tab.
 *
 * Add ?demo=1 to try it with made-up data (nothing is loaded or saved).
 */
import { renderInvoicePdf } from './render/render.js';
import { resolveTemplate, defaultTemplate, FIELDS } from './render/template.js';

const DEMO = /[?&]demo=1\b/.test(location.search);
const $ = (s) => document.querySelector(s);
const panel = $('#panel');

let key = '';
let data = null;              // { countries, samples, docTypes }
let code = '';                // selected country
let tpl = null;               // the template being edited (full, resolved)
let savedJson = '';           // what is saved, to know about unsaved changes
let lastFocus = null;         // where a clicked {Field} chip goes
let pdfUrl = '';
let spots = [];               // where each editable item is, from the last render
let selected = null;          // path (array) of the clicked item
let pdfjs = null;             // Mozilla's PDF viewer library, loaded on first use
const PAGE_W = 595.92, PAGE_H = 842.88;


/* Small helpers ----------------------------------------------------------- */

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}

const clone = (o) => JSON.parse(JSON.stringify(o));
const country = () => data.countries.find((c) => c.code === code);

function getPath(path) { return path.reduce((o, k) => (o == null ? undefined : o[k]), tpl); }
function setPath(path, value) {
  let o = tpl;
  path.slice(0, -1).forEach((k) => { if (o[k] == null) o[k] = {}; o = o[k]; });
  o[path[path.length - 1]] = value;
}

function changed(fromPop = false) {
  if (!fromPop) refreshPop();
  else schedulePanel();
  const dirty = JSON.stringify(tpl) !== savedJson;
  const st = $('#status');
  st.textContent = dirty ? '● Unsaved changes' : 'Saved';
  st.className = 'status' + (dirty ? ' dirty' : '');
  $('#save').disabled = !dirty || DEMO;
  scheduleRender();
}


/* Fields bound to the template ---------------------------------------------- */

function text(path, label, placeholder = '') {
  return h('label', { class: 'f' }, label,
    h('input', { type: 'text', value: getPath(path) ?? '', placeholder, 'data-path': path.join('.'),
      onfocus: (e) => { lastFocus = { el: e.target, path }; },
      oninput: (e) => { setPath(path, e.target.value); changed(); } }));
}

function area(path, label, placeholder = '') {
  return h('label', { class: 'f' }, label,
    h('textarea', { rows: 4, placeholder, 'data-path': path.join('.'),
      onfocus: (e) => { lastFocus = { el: e.target, path }; },
      oninput: (e) => { setPath(path, e.target.value); changed(); } }, getPath(path) ?? ''));
}

/** Blank = let the design decide (stored as null). Arrow keys nudge. */
function number(path, label, step = 0.5, blankHint = '') {
  const v = getPath(path);
  return h('label', { class: 'f' }, label,
    h('input', { type: 'number', step, value: v == null ? '' : v, placeholder: blankHint, 'data-path': path.join('.'),
      oninput: (e) => { setPath(path, e.target.value === '' ? null : Number(e.target.value)); changed(); } }));
}

function check(path, label, invert = false) {
  const v = getPath(path);
  return h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: invert ? v !== false : !!v,
      onchange: (e) => { setPath(path, invert ? (e.target.checked ? true : false) : e.target.checked); changed(); } }),
    label);
}

function color(path, label, fallback) {
  return h('label', { class: 'f' }, label,
    h('input', { type: 'color', value: getPath(path) || fallback,
      oninput: (e) => { setPath(path, e.target.value); changed(); } }));
}

function section(title, open, ...body) {
  return h('details', { class: 'sec', open }, h('summary', {}, title), h('div', { class: 'sec-body' }, ...body));
}

/** Up / down / delete for an item in a list. */
function listButtons(list, i) {
  const move = (d) => { const [x] = list.splice(i, 1); list.splice(i + d, 0, x); changed(); buildPanel(); };
  return [
    h('button', { class: 'icon', type: 'button', title: 'Move up', disabled: i === 0, onclick: () => move(-1) }, '↑'),
    h('button', { class: 'icon', type: 'button', title: 'Move down', disabled: i === list.length - 1, onclick: () => move(1) }, '↓'),
    h('button', { class: 'icon', type: 'button', title: 'Remove', onclick: () => { list.splice(i, 1); changed(); buildPanel(); } }, '✕')
  ];
}


/* The panel ---------------------------------------------------------------- */

function buildPanel() {
  const scroll = panel.scrollTop;
  const open = [...panel.querySelectorAll('details')].map((d) => d.open);
  const lines = tpl.header.lines || (tpl.header.lines = []);
  const sigs = tpl.footer.signatures || (tpl.footer.signatures = []);

  const chips = h('div', { class: 'chips' }, ...FIELDS.map((f) => h('button', {
    class: 'chip', type: 'button', title: 'Insert into the box you last clicked',
    onclick: () => {
      if (!lastFocus) return;
      const el = lastFocus.el, ins = `{${f}}`;
      const at = el.selectionStart ?? el.value.length;
      el.value = el.value.slice(0, at) + ins + el.value.slice(el.selectionEnd ?? at);
      setPath(lastFocus.path, el.value); changed(); el.focus();
    } }, `{${f}}`)));

  const sections = [
    section('Fields from the Countries tab', false,
      h('p', { class: 'hint' }, 'Put these in any text to use that country\'s details from the Countries tab. ' +
        'Click a box first, then a field to insert it. A header line whose field is empty is left out.'),
      chips),

    section('Logo', false,
      h('div', { class: 'checks' }, check(['logo', 'show'], 'Show logo', true)),
      h('div', { class: 'row' }, number(['logo', 'x'], 'Left'), number(['logo', 'top'], 'Top'), number(['logo', 'size'], 'Size'))),

    section('Letterhead', true,
      h('p', { class: 'hint' }, 'Lines stack downwards from Top. Bold label, then the text. Sizes are in points.'),
      h('div', { class: 'row' }, number(['header', 'x'], 'Left'), number(['header', 'top'], 'Top')),
      ...lines.map((ln, i) => h('div', { class: 'item' },
        h('div', { class: 'item-head' }, h('span', { class: 'n' }, `Line ${i + 1}`), ...listButtons(lines, i)),
        h('div', { class: 'row' }, text(['header', 'lines', i, 'label'], 'Label (bold)', 'e.g. Tel: '),
                                   text(['header', 'lines', i, 'text'], 'Text', 'e.g. {Tel}')),
        h('div', { class: 'row' }, number(['header', 'lines', i, 'size'], 'Size'),
                                   number(['header', 'lines', i, 'lineHeight'], 'Line height', 0.5, 'auto'),
                                   number(['header', 'lines', i, 'gap'], 'Space above', 0.5, '0'),
                                   color(['header', 'lines', i, 'color'], 'Colour', '#000000')),
        h('div', { class: 'checks' }, check(['header', 'lines', i, 'bold'], 'Bold'),
                                      check(['header', 'lines', i, 'italic'], 'Italic'),
                                      check(['header', 'lines', i, 'labelBold'], 'Bold label', true),
                                      check(['header', 'lines', i, 'wrap'], 'Wrap long text'),
                                      check(['header', 'lines', i, 'link'], 'Blue link')))),
      h('button', { class: 'btn ghost small', type: 'button',
        onclick: () => { lines.push({ label: '', text: '', size: 6.8 }); changed(); buildPanel(); } }, '+ Add line')),

    section('Stamp (top right)', false,
      h('div', { class: 'row' }, text(['stamp', 'text'], 'Text', 'e.g. <ORIGINAL> or {Stamp}')),
      h('div', { class: 'row' }, number(['stamp', 'size'], 'Size'), number(['stamp', 'top'], 'Top', 0.5, 'level with last line'),
                                 color(['stamp', 'color'], 'Colour', '#e61212'))),

    section('Title', true,
      h('div', { class: 'row' }, text(['title', 'invoice'], 'Invoice', 'INVOICE')),
      h('div', { class: 'row' }, text(['title', 'quotation'], 'Quotation'), text(['title', 'proforma'], 'Proforma')),
      h('div', { class: 'row' }, number(['title', 'size'], 'Size'), number(['title', 'x'], 'Left'),
                                 number(['title', 'gap'], 'Space above'))),

    section('Labels', false,
      h('div', { class: 'row' }, text(['labels', 'billTo'], 'Bill to'), text(['labels', 'invoiceNo'], 'Invoice no.')),
      h('div', { class: 'row' }, text(['labels', 'po'], 'PO no.'), text(['labels', 'date'], 'Date'), text(['labels', 'terms'], 'Terms')),
      text(['labels', 'currencyNote'], 'Currency note (beside the totals)')),

    section('Footer', true,
      h('div', { class: 'checks' }, check(['footer', 'showBank'], 'Show bank details', true)),
      text(['footer', 'bankTitle'], 'Bank heading'),
      area(['footer', 'bank'], 'Bank lines ("Label: value" per line, or {Bank Details})'),
      h('div', { class: 'row' }, number(['footer', 'bankSize'], 'Bank text size')),
      area(['footer', 'notes'], 'Notes, e.g. terms and conditions (blank = none)'),
      h('div', { class: 'row' }, number(['footer', 'notesSize'], 'Notes size')),
      h('p', { class: 'hint' }, 'Signature lines, side by side, e.g. "Authorised Signature" and "Received By".'),
      ...sigs.map((s, i) => h('div', { class: 'item' },
        h('div', { class: 'item-head' }, h('span', { class: 'n' }, `Signature ${i + 1}`), ...listButtons(sigs, i)),
        text(['footer', 'signatures', i, 'label'], 'Label under the line'))),
      h('button', { class: 'btn ghost small', type: 'button',
        onclick: () => { sigs.push({ label: sigs.length ? 'Received By' : 'Authorised Signature' }); changed(); buildPanel(); } },
        '+ Add signature line'),
      h('div', { class: 'row' }, number(['footer', 'signatureWidth'], 'Line length'), number(['footer', 'signatureSpace'], 'Space to sign')),
      text(['footer', 'footnote'], 'Footnote (small print at the bottom)'),
      h('div', { class: 'row' }, number(['footer', 'footnoteSize'], 'Footnote size')))
  ];

  panel.replaceChildren(...sections);
  if (open.length) panel.querySelectorAll('details').forEach((d, i) => { if (open[i] !== undefined) d.open = open[i]; });
  panel.scrollTop = scroll;
}


/* Preview: the PDF drawn on a canvas, with clickable areas on top --------- */

let timer = null, rendering = false, again = false;
function scheduleRender(ms = 150) { clearTimeout(timer); timer = setTimeout(renderNow, ms); }

async function loadPdfJs() {
  if (!pdfjs) {
    pdfjs = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
  }
  return pdfjs;
}

async function renderNow() {
  if (rendering) { again = true; return; }
  rendering = true;
  const err = $('#render-error');
  try {
    const c = country();
    const s = data.samples[c.code];
    const inv = { ...s, date: new Date(s.date), docType: $('#doctype').value,
                  country: { ...c, template: tpl }, spots: [] };
    const bytes = await renderInvoicePdf(inv);

    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    $('#open-pdf').href = url;
    if (pdfUrl) setTimeout(((u) => () => URL.revokeObjectURL(u))(pdfUrl), 60000);
    pdfUrl = url;

    // Draw off-screen, then swap in, so the page never flickers
    const lib = await loadPdfJs();
    const doc = await lib.getDocument({ data: bytes.slice() }).promise;
    const pg = await doc.getPage(1);
    const cssW = $('#page').clientWidth || 800;
    const scale = (cssW / PAGE_W) * (window.devicePixelRatio || 1);
    const vp = pg.getViewport({ scale });
    const off = document.createElement('canvas');
    off.width = Math.round(vp.width); off.height = Math.round(vp.height);
    await pg.render({ canvasContext: off.getContext('2d'), viewport: vp }).promise;
    const cv = $('#canvas');
    cv.width = off.width; cv.height = off.height;
    cv.getContext('2d').drawImage(off, 0, 0);
    doc.destroy();

    spots = inv.spots;
    drawSpots();
    err.hidden = true;
  } catch (e) {
    console.error(e);
    err.textContent = 'Could not draw the preview: ' + e.message;
    err.hidden = false;
  } finally {
    rendering = false;
    if (again) { again = false; renderNow(); }
  }
}

const k = () => ($('#page').clientWidth || 800) / PAGE_W;          // CSS pixels per point
const same = (a, b) => !!a && !!b && a.join('.') === b.join('.');
const MOVABLE = { logo: 1, header: 1, stamp: 1, title: 1 };
const pct = (v, of) => (v / of * 100) + '%';

function drawSpots() {
  const layer = $('#spots');
  layer.replaceChildren(...spots.map((sp) => {
    const el = h('div', { class: 'spot' + (MOVABLE[sp.kind] ? ' move' : '') + (same(sp.path, selected) ? ' sel' : ''),
                          title: describe(sp.path) });
    // In % of the page, so the boxes stay put when the window is resized
    Object.assign(el.style, { left: pct(sp.x - 2, PAGE_W), top: pct(sp.top - 2, PAGE_H),
                              width: pct(sp.w + 4, PAGE_W), height: pct(sp.h + 4, PAGE_H) });
    el.addEventListener('pointerdown', (e) => startDrag(e, sp, el));
    return el;
  }));
  placePop();
}

function describe(path) {
  const [a, b, c] = path;
  if (a === 'logo') return 'Logo';
  if (a === 'header') return `Letterhead line ${c + 1}`;
  if (a === 'stamp') return 'Stamp';
  if (a === 'title') return `Title (${b})`;
  if (a === 'labels') return { billTo: 'Bill to label', invoiceNo: 'Invoice no. label', po: 'PO label', date: 'Date label',
                               terms: 'Terms label', currencyNote: 'Currency note' }[b] || 'Label';
  if (a === 'footer') return { bankTitle: 'Bank heading', bank: 'Bank lines', notes: 'Notes', footnote: 'Footnote' }[b] ||
                             (b === 'signatures' ? `Signature ${c + 1}` : 'Footer');
  return path.join(' › ');
}


/* Click to select, drag to move ------------------------------------------- */

/** What dragging an item changes: the whole letterhead moves together. */
function moveTarget(sp) {
  if (sp.kind === 'logo') return { x: ['logo', 'x'], y: ['logo', 'top'], dx: 58.5, dy: 72.6 };
  if (sp.kind === 'header') return { x: ['header', 'x'], y: ['header', 'top'], dx: 124.8, dy: 70.2 };
  if (sp.kind === 'stamp') return { x: ['stamp', 'right'], y: ['stamp', 'top'], dx: 522.1, dy: sp.top };
  if (sp.kind === 'title') return { x: ['title', 'x'], y: ['title', 'gap'], dx: 65.8, dy: 7 };
  return null;
}

function nudge(sp, dxPt, dyPt) {
  const t = moveTarget(sp);
  if (!t) return;
  const round = (n) => Math.round(n * 2) / 2;                     // half points
  const gx = getPath(t.x), gy = getPath(t.y);
  setPath(t.x, round((gx == null ? t.dx : gx) + dxPt));
  setPath(t.y, round((gy == null ? t.dy : gy) + dyPt));
  changed();
  schedulePanel();                                                 // show the new numbers there too
}

function startDrag(e, sp, el) {
  e.preventDefault();
  const x0 = e.clientX, y0 = e.clientY;
  let moved = false;
  try { el.setPointerCapture(e.pointerId); } catch (err) { /* keeps working without capture */ }
  const onMove = (ev) => {
    const dx = ev.clientX - x0, dy = ev.clientY - y0;
    if (!moved && Math.hypot(dx, dy) < 4) return;
    if (!MOVABLE[sp.kind]) return;
    moved = true;
    el.classList.add('dragging');
    el.style.transform = `translate(${dx}px, ${dy}px)`;
  };
  const onUp = (ev) => {
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    if (moved) {
      const s = k();
      nudge(sp, (ev.clientX - x0) / s, (ev.clientY - y0) / s);
      select(sp.path);
    } else {
      select(sp.path);
    }
  };
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
}

function select(path) {
  selected = path;
  buildPop();
  drawSpots();
}

document.addEventListener('keydown', (e) => {
  if (!selected) return;
  const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
  if (e.key === 'Escape') { selected = null; $('#pop').hidden = true; drawSpots(); return; }
  if (inField) return;
  const sp = spots.find((x) => same(x.path, selected));
  if (!sp || !MOVABLE[sp.kind]) return;
  const step = e.shiftKey ? 5 : 0.5;
  const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (d) { e.preventDefault(); nudge(sp, d[0], d[1]); }
});

$('#page').addEventListener('pointerdown', (e) => {
  if (e.target.id === 'canvas') { selected = null; $('#pop').hidden = true; drawSpots(); }
});


/* The little editor that pops up by a clicked item ------------------------ */

function popText(path, label, multi = false) {
  const attrs = { 'data-pop': path.join('.'), placeholder: label,
    onfocus: (e) => { lastFocus = { el: e.target, path }; },
    oninput: (e) => { setPath(path, e.target.value); changed(true); } };
  return h('label', { class: 'f' }, label, multi
    ? h('textarea', { rows: 4, ...attrs }, getPath(path) ?? '')
    : h('input', { type: 'text', value: getPath(path) ?? '', ...attrs }));
}

function popNumber(path, label, fallback, step = 0.5) {
  const v = getPath(path);
  return h('label', { class: 'f' }, label, h('input', { type: 'number', step, value: v == null ? '' : v, placeholder: fallback ?? '',
    'data-pop': path.join('.'),
    oninput: (e) => { setPath(path, e.target.value === '' ? null : Number(e.target.value)); changed(true); } }));
}

function popToggle(path, label, cls) {
  const on = !!getPath(path);
  return h('button', { class: 'toggle ' + cls + (on ? ' on' : ''), type: 'button', title: label,
    onclick: (e) => { setPath(path, !getPath(path)); e.currentTarget.classList.toggle('on'); changed(true); } },
    cls === 'b' ? 'B' : 'I');
}

function buildPop() {
  const pop = $('#pop');
  if (!selected) { pop.hidden = true; return; }
  const p = selected;
  const [a, b, c] = p;
  const body = [];
  const actions = [];

  if (a === 'header') {
    const lines = tpl.header.lines;
    body.push(h('div', { class: 'row' }, popText([...p, 'label'], 'Label (bold)'), popText([...p, 'text'], 'Text')));
    body.push(h('div', { class: 'tools-row' },
      popNumber([...p, 'size'], 'Size', 6.8), popNumber([...p, 'gap'], 'Space above', 0),
      popToggle([...p, 'bold'], 'Bold', 'b'), popToggle([...p, 'italic'], 'Italic', 'i')));
    actions.push(
      h('button', { class: 'icon', type: 'button', title: 'Move up', disabled: c === 0,
        onclick: () => { lines.splice(c - 1, 0, lines.splice(c, 1)[0]); selected = ['header', 'lines', c - 1]; changed(true); buildPop(); } }, '↑'),
      h('button', { class: 'icon', type: 'button', title: 'Move down', disabled: c === lines.length - 1,
        onclick: () => { lines.splice(c + 1, 0, lines.splice(c, 1)[0]); selected = ['header', 'lines', c + 1]; changed(true); buildPop(); } }, '↓'),
      h('button', { class: 'icon', type: 'button', title: 'Remove this line',
        onclick: () => { lines.splice(c, 1); selected = null; pop.hidden = true; changed(true); } }, '✕'));
  } else if (a === 'logo') {
    body.push(h('div', { class: 'tools-row' }, popNumber(['logo', 'size'], 'Size', 59)));
    actions.push(h('button', { class: 'btn ghost small', type: 'button',
      onclick: () => { setPath(['logo', 'show'], false); selected = null; pop.hidden = true; changed(true); } }, 'Hide logo'));
  } else if (a === 'stamp') {
    body.push(popText(['stamp', 'text'], 'Text'));
    body.push(h('div', { class: 'tools-row' }, popNumber(['stamp', 'size'], 'Size', 9)));
  } else if (a === 'title') {
    body.push(popText(p, 'Title'));
    body.push(h('div', { class: 'tools-row' }, popNumber(['title', 'size'], 'Size', 14)));
  } else if (a === 'labels') {
    body.push(popText(p, 'Text'));
  } else if (a === 'footer' && b === 'signatures') {
    body.push(popText([...p, 'label'], 'Label under the line'));
    actions.push(h('button', { class: 'icon', type: 'button', title: 'Remove this signature line',
      onclick: () => { tpl.footer.signatures.splice(c, 1); selected = null; pop.hidden = true; changed(true); } }, '✕'));
  } else if (a === 'footer') {
    const multi = b === 'bank' || b === 'notes';
    body.push(popText(p, describe(p), multi));
    const sizeKey = { bank: 'bankSize', notes: 'notesSize', footnote: 'footnoteSize' }[b];
    if (sizeKey) body.push(h('div', { class: 'tools-row' }, popNumber(['footer', sizeKey], 'Size')));
  }

  pop.replaceChildren(
    h('div', { class: 'pop-head' }, h('b', {}, describe(p)), ...actions,
      h('button', { class: 'icon', type: 'button', title: 'Close', onclick: () => { selected = null; pop.hidden = true; drawSpots(); } }, '×')),
    ...body,
    h('button', { class: 'btn ghost small', type: 'button', onclick: () => showInPanel(p) }, 'All settings for this →'));
  pop.hidden = false;
  placePop();
}

/** Keep the editor beside its item after every redraw. */
function placePop() {
  const pop = $('#pop');
  if (pop.hidden || !selected) return;
  const sp = spots.find((x) => same(x.path, selected));
  if (!sp) return;
  const s = k(), pageW = $('#page').clientWidth;
  let left = sp.x * s, top = (sp.top + sp.h) * s + 8;
  left = Math.max(8, Math.min(left, pageW - pop.offsetWidth - 8));
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
}

/** Rebuild the editor after a panel change, unless it is being typed in. */
function refreshPop() {
  if (!selected || $('#pop').hidden) return;
  if ($('#pop').contains(document.activeElement)) return;
  buildPop();
}

let panelTimer = null;
function schedulePanel() { clearTimeout(panelTimer); panelTimer = setTimeout(buildPanel, 400); }

function showInPanel(path) {
  const key = path.join('.');
  const el = [...panel.querySelectorAll('[data-path]')].find((x) => x.dataset.path.startsWith(key));
  if (!el) return;
  const d = el.closest('details');
  if (d) d.open = true;
  const box = el.closest('.item') || el.closest('.f') || el;
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  box.classList.remove('flash'); void box.offsetWidth; box.classList.add('flash');
}

window.addEventListener('resize', () => { placePop(); scheduleRender(250); });


/* Loading, switching, saving --------------------------------------------------- */

function openCountry(c) {
  code = c;
  selected = null;
  $('#pop').hidden = true;
  tpl = clone(resolveTemplate(country()));
  savedJson = JSON.stringify(tpl);
  buildPanel();
  changed();
}

function confirmLeave() {
  return JSON.stringify(tpl) === savedJson || confirm('You have unsaved changes. Throw them away?');
}

async function api(method, body) {
  const res = await fetch('/api/studio', {
    method, headers: { 'content-type': 'application/json', 'x-studio-key': key },
    body: body ? JSON.stringify(body) : undefined
  });
  const out = await res.json().catch(() => ({ ok: false, error: 'The server did not answer properly.' }));
  if (!out.ok) { const e = new Error(out.error || 'Something went wrong'); e.status = res.status; throw e; }
  return out;
}

async function start() {
  try {
    data = DEMO ? demoData() : await api('GET');
  } catch (e) {
    if (e.status === 403) return askKey(e.message);
    panel.replaceChildren(h('p', { class: 'hint' }, 'Could not load: ' + e.message));
    return;
  }
  const sel = $('#country');
  sel.replaceChildren(...data.countries.map((c) => h('option', { value: c.code }, `${c.flag || ''} ${c.name}${c.ready ? '' : ' (not ready)'}`)));
  $('#doctype').replaceChildren(...data.docTypes.map((d) => h('option', { value: d }, d)));
  let prev = data.countries[0].code;
  sel.onchange = () => { if (!confirmLeave()) { sel.value = prev; return; } prev = sel.value; openCountry(sel.value); };
  $('#doctype').onchange = scheduleRender;
  $('#discard').onclick = () => { if (confirmLeave()) openCountry(code); };
  $('#reset').onclick = async () => {
    if (!confirm(`Put ${country().name} back to the built-in design? Its saved template is deleted.`)) return;
    if (!DEMO) await api('POST', { action: 'reset', code }).catch((e) => alert(e.message));
    delete country().template;
    tpl = clone(resolveTemplate(country()));
    savedJson = JSON.stringify(tpl);
    buildPanel(); changed();
  };
  $('#save').onclick = async () => {
    const btn = $('#save');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await api('POST', { action: 'save', code, template: tpl });
      country().template = clone(tpl);
      savedJson = JSON.stringify(tpl);
      changed();
    } catch (e) { alert('Not saved: ' + e.message); changed(); }
    btn.textContent = 'Save';
  };
  window.addEventListener('beforeunload', (e) => { if (tpl && JSON.stringify(tpl) !== savedJson) e.preventDefault(); });
  openCountry(prev);
}

function askKey(msg) {
  $('#gate').hidden = false;
  if (msg && key) { const e = $('#gate-error'); e.textContent = msg; e.hidden = false; }
  $('#gate-form').onsubmit = (ev) => {
    ev.preventDefault();
    key = $('#gate-key').value.trim();
    try { sessionStorage.setItem('studioKey', key); } catch (e) {}
    $('#gate').hidden = true;
    start();
  };
}

try { key = sessionStorage.getItem('studioKey') || ''; } catch (e) {}
if (DEMO || key) start(); else askKey();


/* Made-up data for ?demo=1 ------------------------------------------------- */

function demoData() {
  const company = (o) => ({ headerStyle: 'standard', storeLabel: 'Flagship Store', ...o });
  const lines = (prices, tax) => {
    const items = [['Sonos Ace White', 1], ['Sonos Era 100 Home Bookshelf Speaker White', 2], ['Sonos Arc Ultra Smart Soundbar White', 1]];
    const out = items.map(([name, qty], i) => ({ description: name, qty, unit: prices[i] / tax, amount: prices[i] * qty / tax }));
    const subtotal = out.reduce((s, l) => s + l.amount, 0);
    return { lines: out, subtotal, gst: subtotal * (tax - 1), total: subtotal * tax };
  };
  const sample = (id, prices, tax) => ({ invoiceId: id, date: new Date().toISOString(), customer: 'Sample Customer Pte Ltd',
    address: '1 Example Road #01-01\nSample City 123456', email: 'accounts@example.com', po: 'PO-12345',
    terms: 'Cash Before Delivery', ...lines(prices, tax) });
  return {
    docTypes: ['Invoice', 'Quotation', 'Proforma Invoice'],
    countries: [
      { code: 'SG', name: 'Singapore', flag: '🇸🇬', currency: 'SGD', symbol: '$', taxRate: 1.09, taxName: 'GST', layout: 'sg', ready: true,
        company: company({ name: 'Tat Chuan Acoustic Pte Ltd', gstRegNo: 'M200000000', store: '1 Demo Road #01-01 S000000',
          tel: '(+65) 6000 0000', website: 'example.com', currencyNote: 'ALL PRICES ARE IN SINGAPORE DOLLARS (SGD)',
          footnote: 'Kindly highlight any discrepancy within 7 days of this invoice otherwise this shall be deemed to be correct.',
          bankBlocks: [['Bank Name: Demo Bank', 'Account Name: Demo Pte Ltd', 'Account Number: 000-000000-000', 'Swift Code: DEMOSGSG']] }) },
      { code: 'TH', name: 'Thailand', flag: '🇹🇭', currency: 'THB', symbol: 'THB ', taxRate: 1.07, taxName: 'VAT', layout: 'sg', ready: true,
        company: company({ headerStyle: 'large', name: 'TC Acoustic (Thailand) Company Limited (Head Office)',
          store: '88 Demo Building, Room 08-138, Demo Road, Demo District, Bangkok 10110', regLabel: 'Business Registration Number',
          gstRegNo: '0000000000000 (Head Quarter)', website: 'https://example.co.th/', email: 'sales@example.co.th',
          stamp: '<ORIGINAL>', invoiceTitle: 'TAX INVOICE / RECEIPT', currencyNote: 'ALL PRICES ARE IN THB',
          bankBlocks: [['Bank Name: Demo Bank Thailand', 'Account Number: 000-0-00000-0']] }) }
    ],
    samples: { SG: sample('TC2026093001', [499, 299, 1499], 1.09), TH: sample('TCTH26093001', [17900, 10900, 53900], 1.07) }
  };
}
