/**
 * Invoice templates: what the letterhead and footer say and where.
 *
 * Every country starts from defaultTemplate(), which reproduces the
 * built-in design (and the Countries tab "Header Style"). Anything saved
 * from the Template Studio is laid over it, so a saved template only needs
 * the parts that differ.
 *
 * Texts can use fields from the Countries tab, written in braces:
 *   {Company Name} {Address} {Address Label} {GST Reg No} {Reg No Label}
 *   {Tel} {Website} {Email} {Stamp} {Invoice Title} {Currency Note}
 *   {Footnote} {Bank Details} {Tax Name} {Country} {Currency}
 * A header line whose field is blank is left out.
 *
 * Shared by the server (real PDFs) and the Template Studio page (preview),
 * so this file must not use anything Node-only.
 */

export const FIELDS = ['Company Name', 'Address', 'Address Label', 'GST Reg No', 'Reg No Label', 'Tel', 'Website',
  'Email', 'Stamp', 'Invoice Title', 'Currency Note', 'Footnote', 'Bank Details', 'Tax Name', 'Country', 'Currency'];


export function defaultTemplate(country) {
  const style = (country.company && country.company.headerStyle) || 'standard';

  const header = {
    standard: {
      top: 70.2,                  // puts the top of the name level with the top of the logo
      lines: [
        { text: '{Company Name}', size: 13, bold: true },
        { text: '{Address}', size: 6.8, wrap: true },
        { label: '{Reg No Label}: ', text: '{GST Reg No}', size: 6.8, gap: 3 },
        { label: 'Tel: ', text: '{Tel}', size: 6.8 },
        { label: 'Website: ', text: '{Website}', size: 6.8, link: true },
        { label: 'Email: ', text: '{Email}', size: 6.8 }
      ]
    },
    large: {
      top: 74,
      lines: [
        { text: '{Company Name}', size: 13, bold: true },
        { text: '{Address}', size: 6.8, italic: true, wrap: true, gap: 1.4 },
        { label: '{Reg No Label}: ', text: '{GST Reg No}', size: 7.5, lineHeight: 9, gap: 5 },
        { label: 'Tel: ', text: '{Tel}', size: 7.5, lineHeight: 9 },
        { label: 'Website: ', text: '{Website}', size: 7.5, lineHeight: 9 },
        { label: 'Email: ', text: '{Email}', size: 7.5, lineHeight: 9 }
      ]
    },
    classic: {
      top: 91.3,
      lines: [
        { text: '{Company Name}', size: 6.3, bold: true, lineHeight: 7.7 },
        { label: '{Reg No Label}: ', text: '{GST Reg No}', size: 6.3, lineHeight: 7.7 },
        { label: '{Address Label}: ', text: '{Address}', size: 6.3, lineHeight: 7.7 },
        { label: 'Tel: ', text: '{Tel}', size: 6.3, lineHeight: 7.7 },
        { label: 'Website: ', text: '{Website}', size: 6.3, lineHeight: 7.7, link: true },
        { label: 'Email: ', text: '{Email}', size: 6.3, lineHeight: 7.7 }
      ]
    }
  }[style] || null;

  return {
    logo: { show: true, x: 58.5, top: 72.6, size: 59 },
    header: { x: 124.8, ...(header || {}) },
    stamp: { text: '{Stamp}', size: style === 'classic' ? 8 : 9, color: '#e61212', top: null },
    title: { invoice: '{Invoice Title}', quotation: 'QUOTATION', proforma: 'PROFORMA INVOICE',
             size: 14, x: 65.8, gap: 7 },
    labels: { billTo: 'BILL TO', invoiceNo: 'Invoice No:', po: 'PO No.:', date: 'Date:', terms: 'Terms:',
              currencyNote: '{Currency Note}' },
    footer: {
      showBank: true,
      bankTitle: 'BANK ACCOUNT DETAILS:',
      bank: '{Bank Details}',
      bankSize: 6.3,
      notes: '',
      notesSize: 5.5,
      signatures: [],
      signatureWidth: 150,
      signatureSpace: 30,
      footnote: '{Footnote}',
      footnoteSize: 4.6
    }
  };
}


/** The country's template: its saved changes laid over the default. */
export function resolveTemplate(country) {
  return merge(defaultTemplate(country), country.template || {});
}

function merge(base, over) {
  if (Array.isArray(over)) return over.slice();
  if (!over || typeof over !== 'object') return over === undefined ? base : over;
  const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
  for (const [k, v] of Object.entries(over)) out[k] = merge(out[k], v);
  return out;
}


/** Field values for {braces}, from the country's Countries tab row. */
export function fieldValues(country) {
  const C = country.company || {};
  const blocks = C.bankBlocks || [];
  return {
    'Company Name': C.name,
    'Address': C.store,
    'Address Label': C.storeLabel || 'Flagship Store',
    'GST Reg No': C.gstRegNo,
    'Reg No Label': C.regLabel || `${country.taxName || 'GST'} Reg No.`,
    'Tel': C.tel,
    'Website': C.website,
    'Email': C.email,
    'Stamp': C.stamp,
    'Invoice Title': C.invoiceTitle || 'INVOICE',
    'Currency Note': C.currencyNote,
    'Footnote': C.footnote,
    'Bank Details': blocks.map((b) => b.join('\n')).join('\n\n'),
    'Tax Name': country.taxName || 'GST',
    'Country': country.name,
    'Currency': country.currency
  };
}

/**
 * Fills in {Fields}. Returns '' when the text used fields and they were all
 * blank, so the line can be left out. Unknown {names} are left as typed.
 */
export function fill(text, values) {
  const s = String(text == null ? '' : text);
  let used = false, found = false;
  const out = s.replace(/\{([^{}]+)\}/g, (m, name) => {
    if (!(name in values)) return m;
    used = true;
    const v = values[name] == null ? '' : String(values[name]);
    if (v) found = true;
    return v;
  });
  return used && !found && !out.replace(/[\s:.,\-–—|/]+/g, '') ? '' : out;
}
