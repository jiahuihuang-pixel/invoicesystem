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

function changed() {
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
    h('input', { type: 'text', value: getPath(path) ?? '', placeholder,
      onfocus: (e) => { lastFocus = { el: e.target, path }; },
      oninput: (e) => { setPath(path, e.target.value); changed(); } }));
}

function area(path, label, placeholder = '') {
  return h('label', { class: 'f' }, label,
    h('textarea', { rows: 4, placeholder,
      onfocus: (e) => { lastFocus = { el: e.target, path }; },
      oninput: (e) => { setPath(path, e.target.value); changed(); } }, getPath(path) ?? ''));
}

/** Blank = let the design decide (stored as null). Arrow keys nudge. */
function number(path, label, step = 0.5, blankHint = '') {
  const v = getPath(path);
  return h('label', { class: 'f' }, label,
    h('input', { type: 'number', step, value: v == null ? '' : v, placeholder: blankHint,
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


/* Preview ------------------------------------------------------------------ */

let timer = null, rendering = false, again = false;
function scheduleRender() { clearTimeout(timer); timer = setTimeout(renderNow, 200); }

async function renderNow() {
  if (rendering) { again = true; return; }
  rendering = true;
  const err = $('#render-error');
  try {
    const c = country();
    const s = data.samples[c.code];
    const inv = { ...s, date: new Date(s.date), docType: $('#doctype').value,
                  country: { ...c, template: tpl } };
    const bytes = await renderInvoicePdf(inv);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    $('#pdf').src = url + '#toolbar=0&navpanes=0&view=FitH';
    if (pdfUrl) setTimeout(((u) => () => URL.revokeObjectURL(u))(pdfUrl), 2000);
    pdfUrl = url;
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


/* Loading, switching, saving --------------------------------------------------- */

function openCountry(c) {
  code = c;
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
