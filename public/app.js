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
  const priceOf = (p) => (p.prices && state.country ? p.prices[state.country.code] : null);
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const haptic = (kind) => { try { tg.HapticFeedback.impactOccurred(kind || 'light'); } catch (e) {} };


  /* Numbers ------------------------------------------------------------- */

  function gross() {
    return state.items.reduce((s, it) => s + (it.price || 0) * it.qty, 0);
  }
  function margin() {
    return state.customer ? state.customer.margin || 0 : 0;
  }
  function discountValue() {
    if (state.discountMode === 'manual') {
      const n = parseFloat(String(state.discount).replace(/[^0-9.]/g, ''));
      return isNaN(n) ? 0 : n;
    }
    return round2(gross() * margin());
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
      if (DEMO) data = demoData();
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

  function goNext() {
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
      if (!state.customer && !state.address.trim()) return 'Add a billing address for this new customer.';
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
            h('div', { class: 'card' }, list)];
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
    const intro = [h('h1', {}, 'Who is this for?'),
                   h('p', { class: 'lead' }, 'Pick a saved customer or type a new name.')];

    if (state.customer && !state.editDetails) {
      const c = state.customer;
      return [...intro, h('div', { class: 'card' },
        h('div', { class: 'chosen' },
          h('div', { class: 'grow' },
            h('div', { class: 'name' }, c.name),
            h('div', { class: 'details' }, [c.address, c.email, c.terms].filter(Boolean).join('\n') || 'No details saved yet'),
            c.margin ? h('span', { class: 'badge' }, `${round2(c.margin * 100)}% off list for this customer`) : null),
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
          h('h2', {}, 'New customer'), ...detailFields(),
          h('p', { class: 'hint' }, 'Saved to the Customers tab for next time.'));

    if (!state.customer) setTimeout(() => input.focus(), 50);
    return [...intro, card, extra];
  }

  function detailFields() {
    return [
      h('label', { for: 'f-address' }, 'Billing address'),
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
    render();
  }

  function clearCustomer() {
    state.customer = null;
    state.name = ''; state.address = ''; state.email = ''; state.terms = '';
    state.editDetails = false;
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
      h('p', { class: 'lead' }, `${state.country.flag} ${state.country.currency} list prices` +
        (state.country.taxRate > 1 ? ', GST included.' : '.') +
        (margin() ? ` ${round2(margin() * 100)}% customer discount is applied at the end.` : '')),
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
        h('div', { class: 'price' }, priceOf(p) == null ? 'no price' : money(priceOf(p))),
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
      state.items.push({ name: p.name, code: p.code, price: priceOf(p), qty: 1 });
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
        h('div', { class: 'sub muted' }, it.price == null ? 'No price on the list' : `${money(it.price)} each · ${money(it.price * it.qty)}`)),
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
    const termsList = data.terms.includes(state.terms) || !state.terms ? data.terms : [state.terms, ...data.terms];
    if (!state.terms) state.terms = termsList[0];

    const auto = round2(gross() * margin());
    const discountCard = h('div', { class: 'card' }, h('h2', {}, 'Discount'),
      state.discountMode === 'auto'
        ? [h('div', { class: 'row' },
             h('span', {}, margin() ? `${round2(margin() * 100)}% customer margin` : 'No discount'),
             h('span', { class: 'num' }, auto ? '−' + money(auto) : '')),
           h('button', { class: 'linkbtn', type: 'button', onclick: () => { state.discountMode = 'manual'; state.discount = auto ? String(auto) : ''; render(); } },
             'Enter a different amount')]
        : [h('label', { for: 'f-discount' }, `Discount in ${state.country.currency}` + (state.country.taxRate > 1 ? ', GST included' : '')),
           h('input', { id: 'f-discount', type: 'text', inputmode: 'decimal', value: state.discount, placeholder: '0.00',
                        oninput: (e) => { state.discount = e.target.value; } }),
           h('p', { class: 'hint' }, 'Taken off the grand total.'),
           h('button', { class: 'linkbtn', type: 'button', onclick: () => { state.discountMode = 'auto'; render(); } },
             margin() ? 'Use the customer margin instead' : 'No discount')]);

    const t = data.targets;
    const targetCard = t.fixed ? null : h('div', { class: 'card' }, h('h2', {}, 'Send the approved PDF to'),
      chips(t.options.map((o) => o.title), (t.options.find((o) => o.id === state.targetId) || {}).title,
            (title) => { state.targetId = t.options.find((o) => o.title === title).id; }));

    return [
      h('h1', {}, 'A few details'),
      h('p', { class: 'lead' }, 'Nearly done.'),
      targetCard,
      h('div', { class: 'card' }, h('h2', {}, 'Document'), chips(data.docTypes, state.docType, (v) => { state.docType = v; })),
      h('div', { class: 'card' }, h('h2', {}, 'Payment terms'), chips(termsList, state.terms, (v) => { state.terms = v; })),
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
        h('div', { class: 'hint', style: 'white-space:pre-line' }, [state.address, state.email].filter(Boolean).join('\n')),
        h('div', { class: 'hint', style: 'margin-top:6px' }, [state.terms, state.po && 'PO ' + state.po].filter(Boolean).join(' · '))),
      h('div', { class: 'card' }, h('h2', {}, 'Items'),
        ...state.items.map((it) => h('div', { class: 'row' },
          h('span', {}, `${it.qty} × ${it.name}`), h('span', { class: 'num' }, it.price == null ? '—' : money(it.price * it.qty)))),
        d ? h('div', { class: 'row muted' }, h('span', {}, 'Discount'), h('span', { class: 'num' }, '−' + money(d))) : null,
        h('div', { class: 'row total' }, h('span', {}, 'Grand total'), h('span', { class: 'num' }, money(total()))),
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
      customer: { name: state.customer ? state.customer.name : state.name.trim(), address: state.address, email: state.email.trim() },
      items: state.items.map(({ name, code, qty }) => ({ name, code, qty })),
      country: state.country.code,
      docType: state.docType, terms: state.terms, po: state.po.trim(),
      discountMode: state.discountMode, discount: state.discountMode === 'manual' ? String(state.discount) : '',
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
        { code: 'TH', name: 'Thailand', flag: '🇹🇭', currency: 'THB', taxRate: 1, ready: false }
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
        { name: 'Harmony Audio Pte Ltd', address: '10 Anson Road #12-01\nSingapore 079903', email: 'buy@harmony.sg', terms: '30 Days', margin: 0.15, country: 'SG' },
        { name: 'Linko Smart Technology Limited', address: 'Unit 18-19, 11/F, Nan Fund Commercial Centre,\n19 Lam Lok Street, Kowloon Bay, Hong Kong', email: '', terms: 'Cash Before Delivery', margin: 0, country: 'HK' }
      ],
      docTypes: ['Invoice', 'Quotation', 'Proforma Invoice'],
      terms: ['Cash Before Delivery', 'Cash On Delivery', '30 Days'],
      maxItems: 12,
      targets: { fixed: false, options: [{ id: '-1001', title: 'Harmony Audio x TC' }, { id: '1', title: 'Me (private chat)' }] }
    };
  }

  boot();
})();
