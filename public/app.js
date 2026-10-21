/*
 * Invoice request form (Telegram Mini App).
 *
 * Five steps, Paperform style: country -> customer -> items -> details ->
 * review. The country decides the template, currency and price column.
 * Prices shown here are the Product list's, tax included. The server works
 * out everything again from the sheet; nothing typed here is trusted for
 * money except the discount.
 *
 * Add ?demo=1 to the address to try the form in a normal browser with
 * made-up data. Nothing is submitted in demo mode.
 */
(function () {
  'use strict';

  // The SDK loads in any browser; platform is 'unknown' outside Telegram.
  const W = window.Telegram && window.Telegram.WebApp;
  const tg = W && W.platform && W.platform !== 'unknown' ? W : null;
  const DEMO = /[?&]demo=1\b/.test(location.search);
  const VERSION = '21 Oct 2026 (same chat)';          // shown on the first step, to check the newest form is loaded
  const initData = tg ? tg.initData : '';

  const STEPS = ['country', 'customer', 'items', 'details', 'review'];
  let data = null;                   // catalog from the server
  let step = 0;
  let busy = false;
  let shownStep = '';

  const state = {
    country: null,                   // { code, name, flag, currency, taxRate, ready }
    customer: null,                  // record from the Customers tab, or null for a new one
    name: '', address: '', email: '',
    editDetails: false,
    items: [],                       // { name, code, price, qty }
    docType: '', terms: '', po: '',
    discountMode: 'auto', discount: '',
    originalPrices: false,           // true = ignore this customer's special prices this time
    customerType: 'Company',         // new customers only: Company or Individual
    th: blankThai(),                 // new Thai customers: address parts + tax details
    nameCheck: null,                 // customer list hidden: { name, known } from the server
    targetId: ''
  };

  const $ = (sel) => document.querySelector(sel);
  const app = $('#app');
  const nextBtn = $('#next');
  const backBtn = $('#back');


  /* Tiny DOM helper. Text always goes in through textContent. ----------- */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  // "$1,234.00" in Singapore, "HKD 1,234.00" elsewhere
  const money = (n) => (!state.country || state.country.code === 'SG' ? '$' : state.country.currency + ' ') +
    (Math.round((Math.abs(n) + Number.EPSILON) * 100) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const listPriceOf = (p) => (p.prices && state.country ? p.prices[state.country.code] : null);
  /** This customer's special price for a product (Customer Prices tab), or null. */
  const specialOf = (p) => {
    if (!state.customer || state.originalPrices || !state.country) return null;
    const s = (state.customer.special || []).find((x) => x.name === p.name && (!x.country || x.country === state.country.code));
    return s ? s.price : null;
  };
  const priceOf = (p) => { const sp = specialOf(p); return sp != null ? sp : listPriceOf(p); };
  /** Does this customer have any special prices in this country? */
  const hasSpecials = () => !!state.customer && !!state.country &&
    (state.customer.special || []).some((x) => !x.country || x.country === state.country.code);

  /** Re-price the order after the customer or the original-prices switch changes. */
  function reprice() {
    state.items.forEach((it) => {
      const p = data.products.find((x) => x.name === it.name);
      if (!p) return;
      it.special = specialOf(p) != null;
      it.price = priceOf(p);
    });
  }
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\u0E00-\u0E7F]/g, '');   // Thai letters kept
  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const haptic = (kind) => { try { tg.HapticFeedback.impactOccurred(kind || 'light'); } catch (e) {} };


  /* Numbers ------------------------------------------------------------- */

  function gross() {
    return state.items.reduce((s, it) => s + (it.price || 0) * it.qty, 0);
  }
  function margin() {
    return state.customer ? state.customer.margin || 0 : 0;
  }
  /** The customer margin only applies to items at list price, never at original prices. */
  function autoDiscount() {
    if (state.originalPrices) return 0;
    const g = state.items.filter((it) => !it.special).reduce((s, it) => s + (it.price || 0) * it.qty, 0);
    return round2(g * margin());
  }
  function discountValue() {
    if (state.discountMode === 'manual') {
      const n = parseFloat(String(state.discount).replace(/[^0-9.]/g, ''));
      return isNaN(n) ? 0 : n;
    }
    return autoDiscount();
  }
  function total() { return gross() - discountValue(); }


  /* Boot ---------------------------------------------------------------- */

  async function boot() {
    if (tg) {
      tg.ready();
      tg.expand();
      try { tg.disableVerticalSwipes(); } catch (e) {}
      tg.BackButton.onClick(goBack);
    }
    try {
      if (DEMO) {
        data = demoData();
        if (/[?&]hidden=1/.test(location.search)) { data.customers = []; data.customersHidden = true; }
      }
      else if (!initData) throw new Error('Open this form from the bot in Telegram.');
      else data = await post('/api/catalog', { initData });
    } catch (e) {
      return showFatal(e.message);
    }
    state.docType = data.docTypes[0];
    state.targetId = data.targets.options.length === 1 ? data.targets.options[0].id : '';
    backBtn.addEventListener('click', goBack);
    nextBtn.addEventListener('click', goNext);
    $('#actions').hidden = false;
    render();
  }

  async function post(url, body) {
    const res = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    const out = await res.json().catch(() => ({ ok: false, error: 'The server did not answer properly.' }));
    if (!out.ok) throw new Error(out.error || 'Something went wrong.');
    return out;
  }


  /* Navigation ---------------------------------------------------------- */

  async function goNext() {
    if (STEPS[step] === 'customer' && listHidden() && !state.customer && state.name.trim() && !checkedName()) {
      if (busy) return;
      busy = true; nextBtn.disabled = true;
      try {
        const out = DEMO ? { known: ['tom', 'harmonyaudiopteltd'].includes(norm(state.name)) }
                         : await post('/api/catalog', { initData, checkName: state.name.trim() });
        state.nameCheck = { name: norm(state.name), known: !!out.known };
      } catch (e) {
        busy = false; nextBtn.disabled = false;
        return showError(e.message);
      }
      busy = false; nextBtn.disabled = false;
      if (!state.nameCheck.known) { render(); return; }   // stay: show the new-customer boxes
    }
    const err = validate(STEPS[step]);
    if (err) { showError(err); if (tg) try { tg.HapticFeedback.notificationOccurred('error'); } catch (e) {} return; }
    if (step === STEPS.length - 1) return submit();
    step++;
    render();
    window.scrollTo(0, 0);
  }

  function goBack() {
    if (busy) return;
    if (step === 0) { if (tg) tg.close(); return; }
    step--;
    render();
  }

  function validate(name) {
    if (name === 'country' && !state.country) return 'Choose a country.';
    if (name === 'customer') {
      if (!state.name.trim()) return 'Type or pick the customer first.';
      if (savedButHidden()) {
        // a saved customer: their own details are used, nothing more to ask
      } else if (listHidden() && !state.customer && !checkedName()) {
        return 'Press Next again to check the customer.';
      } else if (thaiMode()) {
        const problem = thaiProblem();
        if (problem) return problem;
        state.address = thaiAddressText();          // what the review step and the invoice show
      }
      if (state.email && !/^\S+@\S+\.\S+$/.test(state.email.trim())) return 'That email address does not look right.';
    }
    if (name === 'items') {
      if (!state.items.length) return 'Add at least one item.';
    }
    if (name === 'details') {
      if (!state.targetId) return 'Choose where the invoice should be sent.';
      if (state.discountMode === 'manual' && discountValue() > gross()) return 'The discount is bigger than the order.';
    }
    return '';
  }

  function showError(msg) {
    const box = app.querySelector('.error-box');
    if (box) box.remove();
    const el = h('div', { class: 'error-box', role: 'alert' }, msg);
    app.querySelector('.screen.is-active').prepend(el);
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function showFatal(msg) {
    app.replaceChildren(h('section', { class: 'screen is-active' },
      h('div', { class: 'center' }, h('h1', {}, 'Cannot open the form'), h('p', { class: 'hint' }, msg))));
  }


  /* Rendering ----------------------------------------------------------- */

  function render() {
    const name = STEPS[step];
    $('#progress').style.width = ((step + 1) / STEPS.length * 100) + '%';
    const screen = h('section', { class: 'screen is-active' + (name !== shownStep ? ' enter' : '') },
      h('div', { class: 'step-label' }, `Step ${step + 1} of ${STEPS.length}`),
      ...({ country: countryStep, customer: customerStep, items: itemsStep, details: detailsStep, review: reviewStep }[name])());
    app.replaceChildren(screen);
    shownStep = name;

    backBtn.hidden = step === 0 || !!tg;              // Telegram shows its own back arrow
    if (tg) { step === 0 ? tg.BackButton.hide() : tg.BackButton.show(); }
    updateNext();
  }

  function updateNext() {
    const name = STEPS[step];
    nextBtn.replaceChildren();
    if (name === 'items' && state.items.length) {
      const n = state.items.reduce((s, it) => s + it.qty, 0);
      nextBtn.append('Next ', h('span', { class: 'summary-chip' }, `· ${n} item${n === 1 ? '' : 's'} · ${money(gross())}`));
    } else {
      nextBtn.append(name === 'review' ? 'Submit for approval' : 'Next');
    }
    nextBtn.disabled = busy;
  }


  /* Step 1: country ----------------------------------------------------- */

  function countryStep() {
    const list = h('ul', { class: 'list countries' }, ...data.countries.map((c) => h('li', {
      class: 'country' + (c.ready ? '' : ' is-disabled') + (state.country && state.country.code === c.code ? ' is-picked' : ''),
      role: 'button', 'aria-disabled': String(!c.ready),
      onclick: () => {
        if (!c.ready) return showError(`${c.name} invoices are not set up yet. Ask the admin.`);
        pickCountry(c);
      } },
      h('span', { class: 'flag', 'aria-hidden': 'true' }, c.flag),
      h('div', { class: 'grow' },
        h('div', { class: 'title' }, c.name),
        h('div', { class: 'sub' }, c.ready ? `${c.currency}${c.taxRate > 1 ? ` · ${round2((c.taxRate - 1) * 100)}% GST` : ''}` : 'Not set up yet')),
      c.ready ? h('span', { class: 'chev', 'aria-hidden': 'true' }, '›') : null)));
    return [h('h1', {}, 'Which country?'),
            h('p', { class: 'lead' }, 'This picks the invoice template, currency and prices.'),
            h('div', { class: 'card' }, list),
            h('p', { class: 'hint', style: 'text-align:center' }, 'Form version ' + VERSION)];
  }

  function pickCountry(c) {
    haptic();
    if (state.country && state.country.code !== c.code) {
      // Prices and customers differ per country; start those over.
      state.items = [];
      state.discountMode = 'auto'; state.discount = '';
      if (state.customer && state.customer.country && state.customer.country !== c.code) clearCustomer();
    }
    state.country = c;
    step++;
    render();
    window.scrollTo(0, 0);
  }

  /** This country's customers first, then ones with no country saved. */
  function countryCustomers() {
    const code = state.country ? state.country.code : '';
    return data.customers.filter((c) => !c.country || c.country === code)
      .sort((a, b) => (b.country === code) - (a.country === code));
  }


  /* Step 2: customer ---------------------------------------------------- */

  function customerStep() {
    if (listHidden()) return hiddenCustomerStep();
    const intro = [h('h1', {}, 'Who is this for?'),
                   h('p', { class: 'lead' }, 'Pick a saved customer or type a new name.')];

    if (state.customer && !state.editDetails) {
      const c = state.customer;
      return [...intro, h('div', { class: 'card' },
        h('div', { class: 'chosen' },
          h('div', { class: 'grow' },
            h('div', { class: 'name' }, c.name),
            h('div', { class: 'details' }, [c.address, c.email, c.terms].filter(Boolean).join('\n') || 'No details saved yet'),
            c.margin ? h('span', { class: 'badge' }, `${round2(c.margin * 100)}% off list for this customer`) : null,
            state.country && state.country.hasCopies && (c.type === 'Individual' || !String(c.address || '').trim()) ? h('span', { class: 'badge' }, 'One copy, no ORIGINAL / COPY') : null),
          h('button', { class: 'linkbtn', type: 'button', onclick: () => { clearCustomer(); render(); } }, 'Change')),
        h('div', { style: 'margin-top:12px' },
          h('button', { class: 'linkbtn', type: 'button', onclick: () => { state.editDetails = true; render(); } },
            'Edit address or email for this invoice')))];
    }

    const list = h('ul', { class: 'list' });
    const input = h('input', {
      type: 'text', value: state.name, placeholder: 'Customer or company name', autocomplete: 'off',
      'aria-label': 'Customer name', disabled: !!state.customer,
      oninput: (e) => { state.name = e.target.value; fillSuggestions(list, e.target.value); }
    });
    fillSuggestions(list, state.name);

    const card = h('div', { class: 'card' }, h('div', { class: 'search' }, input), list);
    const extra = state.customer
      ? h('div', { class: 'card' }, h('h2', {}, `Details for ${state.customer.name}`), ...detailFields(),
          h('p', { class: 'hint' }, 'Only used on this invoice. The saved record is not changed.'),
          h('button', { class: 'linkbtn', type: 'button', onclick: () => { clearCustomer(); render(); } }, 'Pick a different customer'))
      : h('div', { class: 'card', id: 'new-fields', hidden: !state.name.trim() },
          h('h2', {}, 'New customer'),
          // Only asked where it matters: countries that print an original + copy for companies
          state.country && state.country.hasCopies ? h('div', {},
            h('label', {}, 'Company or individual?'),
            h('div', { class: 'chips', role: 'group' }, ...['Company', 'Individual'].map((t) =>
              h('button', { class: 'chip', type: 'button', 'aria-pressed': String(state.customerType === t),
                onclick: () => { state.customerType = t; haptic(); render(); } }, t))),
            h('p', { class: 'hint', style: 'margin:6px 0 0' }, 'Companies with an address get an original and a copy.')) : null,
          ...detailFields(),
          h('p', { class: 'hint' }, 'Saved to the Customers tab for next time.'));

    if (!state.customer) setTimeout(() => input.focus(), 50);
    return [...intro, card, extra];
  }

  /* Thai tax-invoice address ------------------------------------------- */

  function blankThai() {
    return { house: '', moo: '', soi: '', road: '', sub: '', district: '', province: '', postcode: '',
             taxId: '', office: 'Head Office', branchNo: '' };
  }

  /**
   * Not on the Access tab: the saved customer list is hidden, so the name is
   * checked with the server, which answers only "saved" or "not saved".
   */
  const listHidden = () => !!data.customersHidden;
  const checkedName = () => !!state.nameCheck && state.nameCheck.name === norm(state.name);
  const savedButHidden = () => listHidden() && !state.customer && checkedName() && state.nameCheck.known;
  const newButHidden = () => listHidden() && !state.customer && checkedName() && !state.nameCheck.known;

  /** A new customer in a country that uses the Thai address format. */
  const thaiMode = () => !state.customer && !savedButHidden() && !!state.country && !!state.country.thaiAddress;
  const isCompany = () => !(state.country && state.country.hasCopies) || state.customerType === 'Company';

  /** The parts in the Thai tax-invoice order, as the address lines printed under BILL TO. */
  function thaiAddressText() {
    const t = state.th, j = (a, sep) => a.map((x) => String(x).trim()).filter(Boolean).join(sep);
    return j([j([t.house, t.moo, t.soi, t.road], ', '), j([t.sub, t.district], ', '), j([t.province, t.postcode], ' ')], '\n');
  }

  function thaiField(key, label, placeholder, opts = {}) {
    return h('label', { class: 'f-thai' }, h('span', {}, label, opts.optional ? h('span', { class: 'opt' }, ' (optional)') : null),
      h('input', { type: 'text', value: state.th[key], placeholder, inputmode: opts.numeric ? 'numeric' : null,
                   maxlength: opts.max || null, oninput: (e) => { state.th[key] = e.target.value; } }));
  }

  function thaiFields() {
    const t = state.th;
    const company = isCompany();
    return [
      company ? h('div', {},
        h('label', {}, 'Head office or branch?'),
        h('div', { class: 'chips', role: 'group' }, ...['Head Office', 'Branch'].map((o) =>
          h('button', { class: 'chip', type: 'button', 'aria-pressed': String(t.office === o),
                        onclick: () => { t.office = o; haptic(); render(); } }, o))),
        t.office === 'Branch' ? thaiField('branchNo', 'Branch No.', 'e.g. 00001', { numeric: true, max: 5 }) : null,
        thaiField('taxId', 'Tax ID (13 digits)', 'e.g. 0105566120449', { numeric: true, max: 17 })) : null,
      thaiField('house', 'House No. / Building / Room', 'e.g. 88 The Parq, Room 08-138', { optional: true }),
      h('div', { class: 'row-2' }, thaiField('moo', 'Moo', 'e.g. Moo 5 / หมู่ 5', { optional: true }),
                                   thaiField('soi', 'Soi', 'e.g. Soi 31 / ซอย 31', { optional: true })),
      thaiField('road', 'Road', 'e.g. Ratchadaphisek Road / ถนนรัชดาภิเษก', { optional: true }),
      thaiField('sub', 'Sub-district (Khwaeng / Tambon)', 'e.g. Khlong Toei / แขวงคลองเตย', { optional: true }),
      thaiField('district', 'District (Khet / Amphoe)', 'e.g. Khlong Toei / เขตคลองเตย', { optional: true }),
      h('div', { class: 'row-2' }, thaiField('province', 'Province', 'e.g. Bangkok / กรุงเทพฯ', { optional: true }),
                                   thaiField('postcode', 'Postcode', '10110', { numeric: true, max: 5, optional: true })),
      h('p', { class: 'hint' }, 'English or Thai is fine. It prints in this order under BILL TO. Without an address, the invoice has no ORIGINAL / COPY.')
    ];
  }

  /** Why the Thai details can't be saved yet, or ''. */
  function thaiProblem() {
    const t = state.th;
    if (isCompany()) {
      if (t.office === 'Branch' && !/^\d{1,5}$/.test(t.branchNo.trim())) return 'Add the branch number (up to 5 digits).';
      if (!/^\d{13}$/.test(t.taxId.replace(/\D/g, ''))) return 'The Tax ID must be 13 digits.';
    }
    // The address is optional; only a postcode that was typed is checked
    if (t.postcode.trim() && !/^\d{5}$/.test(t.postcode.trim())) return 'The postcode must be 5 digits.';
    return '';
  }

  /** The customer step for someone who can't see the saved list. */
  function hiddenCustomerStep() {
    const input = h('input', {
      type: 'text', value: state.name, placeholder: 'Customer or company name', autocomplete: 'off',
      'aria-label': 'Customer name',
      oninput: (e) => {
        state.name = e.target.value;
        const card = document.getElementById('hidden-status');
        if (card) card.hidden = !checkedName();
        const nf = document.getElementById('new-fields');
        if (nf) nf.hidden = !newButHidden();
      }
    });
    setTimeout(() => input.focus(), 50);
    return [
      h('h1', {}, 'Who is this for?'),
      h('p', { class: 'lead' }, 'Type the customer\'s full name. If they are already saved, their details are used automatically.'),
      h('div', { class: 'card' }, input,
        h('div', { id: 'hidden-status', class: 'hint', style: 'margin-top:8px', hidden: !checkedName() },
          savedButHidden() ? '✓ Saved customer: their address, terms and discount will be used.'
                           : 'Not a saved customer yet: add their details below.')),
      h('div', { class: 'card', id: 'new-fields', hidden: !newButHidden() },
        h('h2', {}, 'New customer'),
        state.country && state.country.hasCopies ? h('div', {},
          h('label', {}, 'Company or individual?'),
          h('div', { class: 'chips', role: 'group' }, ...['Company', 'Individual'].map((t) =>
            h('button', { class: 'chip', type: 'button', 'aria-pressed': String(state.customerType === t),
              onclick: () => { state.customerType = t; haptic(); render(); } }, t))),
          h('p', { class: 'hint', style: 'margin:6px 0 0' }, 'Companies with an address get an original and a copy.')) : null,
        ...detailFields(),
        h('p', { class: 'hint' }, 'Saved to the Customers tab for next time.'))
    ];
  }

  function detailFields() {
    if (thaiMode()) {
      return [...thaiFields(),
        h('label', { for: 'f-email' }, 'Email ', h('span', { class: 'opt' }, '(optional)')),
        h('input', { id: 'f-email', type: 'email', value: state.email, placeholder: 'name@company.com', inputmode: 'email',
                     oninput: (e) => { state.email = e.target.value; } })];
    }
    return [
      h('label', { for: 'f-address' }, 'Billing address ', h('span', { class: 'opt' }, '(optional)')),
      h('textarea', { id: 'f-address', rows: 3, placeholder: 'Street, unit\nSingapore 123456', oninput: (e) => { state.address = e.target.value; } },
        state.address),
      h('label', { for: 'f-email' }, 'Email ', h('span', { class: 'opt' }, '(optional)')),
      h('input', { id: 'f-email', type: 'email', value: state.email, placeholder: 'name@company.com', inputmode: 'email',
                   oninput: (e) => { state.email = e.target.value; } })
    ];
  }

  function fillSuggestions(list, q) {
    const nq = norm(q);
    const matches = nq
      ? countryCustomers().filter((c) => norm(c.name).includes(nq)).slice(0, 8)
      : countryCustomers().slice(0, 6);
    const exact = data.customers.some((c) => norm(c.name) === nq);

    list.replaceChildren(...matches.map((c) => h('li', { onclick: () => pickCustomer(c) },
      h('div', { class: 'grow' },
        h('div', { class: 'title' }, c.name),
        h('div', { class: 'sub' }, [c.address.split('\n')[0], c.margin ? `${round2(c.margin * 100)}% off` : ''].filter(Boolean).join(' · ') || ' ')))));

    if (nq && !exact) {
      list.append(h('li', { class: 'new-customer', onclick: () => { document.querySelector('#new-fields textarea').focus(); } },
        `+ New customer “${q.trim()}”`));
    }
    const nf = document.getElementById('new-fields');
    if (nf) nf.hidden = !nq || exact;
    if (!matches.length && !nq) list.append(h('li', { class: 'sub' }, 'No saved customers yet.'));
  }

  function pickCustomer(c) {
    haptic();
    state.customer = c;
    state.name = c.name;
    state.address = c.address;
    state.email = c.email;
    state.editDetails = false;
    if (c.terms) state.terms = c.terms;
    state.originalPrices = false;
    reprice();
    render();
  }

  function clearCustomer() {
    state.customer = null;
    state.name = ''; state.address = ''; state.email = ''; state.terms = '';
    state.th = blankThai();
    state.editDetails = false;
    state.originalPrices = false;
    reprice();
  }


  /* Step 3: items ------------------------------------------------------- */

  function itemsStep() {
    const results = h('ul', { class: 'list' });
    const cart = h('div', {});
    const search = h('input', {
      type: 'search', placeholder: 'Search product or barcode', autocomplete: 'off', 'aria-label': 'Search products',
      oninput: (e) => fillResults(results, e.target.value, cart)
    });
    fillResults(results, '', cart);
    fillCart(cart, results, search);

    return [
      h('h1', {}, 'What are they buying?'),
      h('p', { class: 'lead' }, `${state.country.flag} ${state.country.currency} prices` +
        (state.country.taxRate > 1 ? ', GST included.' : '.') +
        (hasSpecials() && !state.originalPrices ? ` ${state.customer.name}'s special prices are marked.` : '') +
        (margin() && !state.originalPrices ? ` ${round2(margin() * 100)}% customer discount on the rest is applied at the end.` : '')),
      hasSpecials() || margin() ? h('div', { class: 'card' },
        h('label', { class: 'switch' },
          h('input', { type: 'checkbox', checked: state.originalPrices,
            onchange: (e) => { state.originalPrices = e.target.checked; reprice(); haptic(); render(); } }),
          h('span', {}, h('b', {}, 'Use original prices'),
            h('span', { class: 'hint', style: 'display:block' }, hasSpecials()
              ? 'Charge the normal list price this time: no special prices and no margin discount.'
              : `Charge the normal list price this time, without the ${round2(margin() * 100)}% margin discount.`)))) : null,
      h('div', { class: 'card' }, h('h2', {}, 'Order'), cart),
      h('div', { class: 'card' }, h('div', { class: 'search' }, search), results)
    ];
  }

  function fillResults(list, q, cart) {
    const nq = norm(q);
    const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
    const found = data.products.filter((p) => {
      if (!nq) return true;
      const hay = (p.name + ' ' + p.code).toLowerCase();
      return words.every((w) => hay.includes(w)) || norm(p.code) === nq;
    }).sort((a, b) => (priceOf(a) == null) - (priceOf(b) == null)).slice(0, 40);

    list.replaceChildren(...found.map((p) => {
      const inCart = state.items.find((it) => it.name === p.name);
      return h('li', { 'data-name': p.name, onclick: (e) => {
        // The order box above grows as items go in. Keep the tapped row
        // where the finger is, so a quick second tap hits the same product.
        const y0 = e.currentTarget.getBoundingClientRect().top;
        addItem(p); fillResults(list, q, cart); fillCart(cart, list);
        const again = [...list.children].find((li) => li.dataset.name === p.name);
        if (again) window.scrollBy(0, again.getBoundingClientRect().top - y0);
      } },
        h('div', { class: 'grow' },
          h('div', { class: 'title' }, p.name),
          h('div', { class: 'sub' }, p.code || ' ')),
        specialOf(p) != null
          ? h('div', { class: 'price' }, h('span', { class: 'special' }, money(specialOf(p))),
              listPriceOf(p) != null ? h('s', { class: 'was' }, money(listPriceOf(p))) : null)
          : h('div', { class: 'price' }, priceOf(p) == null ? 'no price' : money(priceOf(p))),
        inCart ? h('span', { class: 'in-cart' }, `×${inCart.qty}`) : h('button', { class: 'add', type: 'button', 'aria-label': 'Add ' + p.name }, '+'));
    }));
    if (!found.length) list.append(h('li', { class: 'sub' }, 'Nothing matches. Check the Product list tab.'));
  }

  function addItem(p) {
    if (priceOf(p) == null) {
      return showError(`${p.name} has no ${state.country.currency} price on the Product list ("${state.country.code === 'SG' ? 'Price' : 'Price ' + state.country.currency}" column).`);
    }
    haptic();
    const it = state.items.find((x) => x.name === p.name);
    if (it) it.qty++;
    else {
      if (state.items.length >= data.maxItems) return showError(`Up to ${data.maxItems} different items fit on one invoice.`);
      state.items.push({ name: p.name, code: p.code, price: priceOf(p), special: specialOf(p) != null, qty: 1 });
    }
    updateNext();
  }

  function fillCart(cart, results) {
    if (!state.items.length) {
      cart.replaceChildren(h('div', { class: 'empty' }, 'Nothing yet. Tap products below to add them.'));
      return;
    }
    const refresh = () => { fillCart(cart, results); updateNext(); const s = document.querySelector('input[type=search]'); fillResults(results, s ? s.value : '', cart); };
    cart.replaceChildren(...state.items.map((it) => h('div', { class: 'cart-line' },
      h('div', { class: 'grow' },
        h('div', { class: 'title' }, it.name),
        h('div', { class: 'sub muted' }, it.price == null ? 'No price on the list'
          : `${money(it.price)} each${it.special ? ' (special)' : ''} · ${money(it.price * it.qty)}`)),
      h('div', { class: 'stepper' },
        h('button', { type: 'button', 'aria-label': 'One fewer', onclick: () => {
          haptic(); it.qty--; if (it.qty < 1) state.items = state.items.filter((x) => x !== it); refresh(); } }, '−'),
        h('input', { type: 'number', inputmode: 'numeric', min: 1, value: it.qty, 'aria-label': 'Quantity',
          onchange: (e) => { const n = parseInt(e.target.value, 10); it.qty = n > 0 ? n : 1; refresh(); } }),
        h('button', { type: 'button', 'aria-label': 'One more', onclick: () => { haptic(); it.qty++; refresh(); } }, '+')))));
  }


  /* Step 4: details ----------------------------------------------------- */

  function chips(options, current, onPick) {
    return h('div', { class: 'chips', role: 'group' }, ...options.map((o) =>
      h('button', { class: 'chip', type: 'button', 'aria-pressed': String(o === current),
                    onclick: () => { haptic(); onPick(o); render(); } }, o)));
  }

  function detailsStep() {
    // Terms are not chosen here: the customer's own, or the default
    const terms = (state.customer && state.customer.terms) || data.defaultTerms || 'Cash Before Delivery';

    const auto = autoDiscount();
    const discountCard = h('div', { class: 'card' }, h('h2', {}, 'Discount'),
      state.discountMode === 'auto'
        ? [h('div', { class: 'row' },
             h('span', {}, auto ? `${round2(margin() * 100)}% customer margin` + (state.items.some((it) => it.special) ? ' (items at list price)' : '')
                             : 'No discount'),
             h('span', { class: 'num' }, auto ? '−' + money(auto) : '')),
           h('button', { class: 'linkbtn', type: 'button', onclick: () => { state.discountMode = 'manual'; state.discount = auto ? String(auto) : ''; render(); } },
             'Enter a different amount')]
        : [h('label', { for: 'f-discount' }, `Discount in ${state.country.currency}` + (state.country.taxRate > 1 ? ', GST included' : '')),
           h('input', { id: 'f-discount', type: 'text', inputmode: 'decimal', value: state.discount, placeholder: '0.00',
                        oninput: (e) => { state.discount = e.target.value; } }),
           h('p', { class: 'hint' }, 'Taken off the grand total.'),
           h('button', { class: 'linkbtn', type: 'button', onclick: () => { state.discountMode = 'auto'; render(); } },
             margin() && !state.originalPrices ? 'Use the customer margin instead' : 'No discount')]);

    const t = data.targets;
    const targetCard = t.fixed ? null : h('div', { class: 'card' }, h('h2', {}, 'Send the approved PDF to'),
      chips(t.options.map((o) => o.title), (t.options.find((o) => o.id === state.targetId) || {}).title,
            (title) => { state.targetId = t.options.find((o) => o.title === title).id; }));

    return [
      h('h1', {}, 'A few details'),
      h('p', { class: 'lead' }, 'Nearly done.'),
      targetCard,
      h('div', { class: 'card' }, h('h2', {}, 'Document'), chips(data.docTypes, state.docType, (v) => { state.docType = v; })),
      h('div', { class: 'card' }, h('h2', {}, 'Payment terms'),
        h('div', { style: 'font-weight:600' }, terms),
        h('p', { class: 'hint', style: 'margin:4px 0 0' }, 'Need different terms for this customer? Message the admin.')),
      h('div', { class: 'card' },
        h('label', { for: 'f-po' }, 'PO number ', h('span', { class: 'opt' }, '(optional)')),
        h('input', { id: 'f-po', type: 'text', value: state.po, placeholder: 'e.g. PO-2291', oninput: (e) => { state.po = e.target.value; } })),
      discountCard
    ];
  }


  /* Step 5: review ------------------------------------------------------ */

  function reviewStep() {
    const d = discountValue();
    const target = data.targets.options.find((o) => o.id === state.targetId);
    return [
      h('h1', {}, 'Check and submit'),
      h('p', { class: 'lead' }, 'You will get a message in Telegram once it is approved.'),
      h('div', { class: 'card' }, h('h2', {}, `${state.country.flag} ${state.country.name} ${state.docType.toLowerCase()} for`),
        h('div', { style: 'font-weight:600' }, state.customer ? state.customer.name : state.name.trim()),
        h('div', { class: 'hint', style: 'white-space:pre-line' }, savedButHidden()
          ? 'Saved customer: their saved address, terms and discount will be used.'
          : [state.address, state.email].filter(Boolean).join('\n')),
        h('div', { class: 'hint', style: 'margin-top:6px' },
          [(state.customer && state.customer.terms) || data.defaultTerms || 'Cash Before Delivery', state.po && 'PO ' + state.po]
            .filter(Boolean).join(' · '))),
      h('div', { class: 'card' }, h('h2', {}, 'Items'),
        ...state.items.map((it) => h('div', { class: 'row' },
          h('span', {}, `${it.qty} × ${it.name}`), h('span', { class: 'num' }, it.price == null ? '—' : money(it.price * it.qty)))),
        d ? h('div', { class: 'row muted' }, h('span', {}, 'Discount'), h('span', { class: 'num' }, '−' + money(d))) : null,
        h('div', { class: 'row total' }, h('span', {}, 'Grand total'), h('span', { class: 'num' }, money(total()))),
        state.originalPrices ? h('p', { class: 'hint', style: 'margin:4px 0 0' }, 'Original prices: no customer discount.')
          : state.items.some((it) => it.special) ? h('p', { class: 'hint', style: 'margin:4px 0 0' }, 'Includes this customer\'s special prices.') : null,
        state.country.taxRate > 1
          ? h('p', { class: 'hint', style: 'margin:4px 0 0' },
              `Includes ${round2((state.country.taxRate - 1) * 100)}% GST of ${money(total() - total() / state.country.taxRate)}`)
          : null),
      target ? h('p', { class: 'hint' }, 'Approved PDF goes to: ' + target.title) : null
    ];
  }


  /* Submit -------------------------------------------------------------- */

  async function submit() {
    if (busy) return;
    busy = true;
    nextBtn.disabled = true;
    nextBtn.replaceChildren('Sending…');
    const form = {
      customer: { name: state.customer ? state.customer.name : state.name.trim(), address: state.address, email: state.email.trim(),
                  type: state.customer || savedButHidden() ? '' : state.customerType,
                  ...(thaiMode() && isCompany() ? {
                    taxId: state.th.taxId.replace(/\D/g, ''),
                    branch: state.th.office === 'Branch' ? state.th.branchNo.trim().padStart(5, '0') : 'Head Office'
                  } : {}) },
      items: state.items.map(({ name, code, qty }) => ({ name, code, qty })),
      country: state.country.code,
      docType: state.docType, po: state.po.trim(),
      discountMode: state.discountMode, discount: state.discountMode === 'manual' ? String(state.discount) : '',
      pricing: state.originalPrices ? 'original' : 'customer',
      targetId: state.targetId
    };
    try {
      const out = DEMO ? { invoiceId: 'DEMO', target: 'the group' } : await post('/api/submit', { initData, form });
      if (tg) try { tg.HapticFeedback.notificationOccurred('success'); } catch (e) {}
      done(out);
    } catch (e) {
      busy = false;
      updateNext();
      showError(e.message);
    }
  }

  function done(out) {
    $('#actions').hidden = true;
    $('#progress').style.width = '100%';
    if (tg) tg.BackButton.hide();
    app.replaceChildren(h('section', { class: 'screen is-active' },
      h('div', { class: 'center' },
        h('div', { class: 'done-mark' }, '✓'),
        h('h1', {}, `Request #${out.invoiceId} sent`),
        h('p', { class: 'hint' }, `It is waiting for approval. The PDF will be posted to ${out.target} once it is approved.`),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => (tg ? tg.close() : location.reload()) }, 'Done'))));
  }


  /* Demo data (?demo=1) -------------------------------------------------- */

  function demoData() {
    return {
      countries: [
        { code: 'SG', name: 'Singapore', flag: '🇸🇬', currency: 'SGD', taxRate: 1.09, ready: true },
        { code: 'HK', name: 'Hong Kong', flag: '🇭🇰', currency: 'HKD', taxRate: 1, ready: true },
        { code: 'MY', name: 'Malaysia', flag: '🇲🇾', currency: 'MYR', taxRate: 1, ready: false },
        { code: 'TH', name: 'Thailand', flag: '🇹🇭', currency: 'THB', taxRate: 1.07, ready: true, hasCopies: true, thaiAddress: true }
      ],
      products: [
        { name: 'Sonos Ace White', code: '8717755779999', prices: { SG: 499, HK: 2988 } },
        { name: 'Sonos Era 100 Home Bookshelf Speaker White', code: '8717755777001', prices: { SG: 299, HK: 1788 } },
        { name: 'Sonos Sub Gen4 Wireless Subwoofer White', code: '8717755778002', prices: { SG: 1159, HK: null } },
        { name: 'Sonos Arc Ultra Smart Soundbar White', code: '8717755779003', prices: { SG: 1499, HK: 8988 } },
        { name: 'Amp Multi', code: 'AMPM', prices: { SG: null, HK: 22949 } }
      ],
      customers: [
        { name: 'Tom', address: 'east coast road 12345\nSingapore 111111', email: 'tom@gmail.com', terms: 'Cash Before Delivery', margin: 0, country: '' },
        { name: 'Harmony Audio Pte Ltd', address: '10 Anson Road #12-01\nSingapore 079903', email: 'buy@harmony.sg', terms: '30 Days', margin: 0.15, country: 'SG',
          special: [{ name: 'Sonos Ace White', price: 420, country: 'SG' }, { name: 'Sonos Arc Ultra Smart Soundbar White', price: 1299, country: '' }] },
        { name: 'Linko Smart Technology Limited', address: 'Unit 18-19, 11/F, Nan Fund Commercial Centre,\n19 Lam Lok Street, Kowloon Bay, Hong Kong', email: '', terms: 'Cash Before Delivery', margin: 0, country: 'HK' }
      ],
      docTypes: ['Invoice', 'Quotation', 'Proforma Invoice'],
      defaultTerms: 'Cash Before Delivery',
      maxItems: 12,
      targets: { fixed: true, options: [{ id: '-1001', title: 'Harmony Audio x TC' }] }
    };
  }

  boot();
})();
