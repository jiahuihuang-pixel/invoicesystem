/**
 * The countries the form offers, read from the "Countries" tab of the
 * Google Sheet, one row each. Company and bank details live there, not in
 * this code, so they never end up on GitHub and you can change them
 * without redeploying.
 *
 * COLUMNS (matched ignoring case and spaces)
 *   Code            SG, HK, MY, TH. Also goes in the invoice number.
 *   Country         Singapore
 *   Flag            🇸🇬 (optional, for the form)
 *   Currency        SGD
 *   GST %           9%  (blank or 0 = no tax line; prices include it)
 *   Tax Name        what the tax is called on the invoice: GST, SST, VAT.
 *                   Blank = GST. Also used for "<Tax Name> Reg No.:".
 *   Address Label   label before the Address on the letterhead.
 *                   Blank = "Flagship Store".
 *   Price Column    Product list column with this country's prices.
 *                   Blank = "Price" for SG, "Price <currency>" otherwise.
 *   Layout          sg (the Singapore / Templates tab design, the default)
 *                   or simple (the old Hong Kong proforma design).
 *   Number Date     yyyymmdd or yymmdd, the date inside the invoice number.
 *                   Blank = yyyymmdd for SG, yymmdd otherwise.
 *   Ready           tick box. Unticked shows the country greyed out.
 *   Company Name, GST Reg No, Address, Tel, Website   the letterhead;
 *                   blank ones are left off (the simple layout only uses
 *                   Company Name)
 *   Bank Details    several lines in one cell, "Label: value" each. A
 *                   blank line starts a new group on the simple layout.
 *   Currency Note   e.g. ALL PRICES ARE IN HONG KONG DOLLARS (HKD).
 *                   Blank = "ALL PRICES ARE IN <currency>".
 *   Footnote        small print at the bottom of the sg layout
 * =====================================================================
 */
import { CONFIG } from './config.js';
import { headerIndex } from './sheets.js';

export const COUNTRY_HEADERS = ['Code', 'Country', 'Flag', 'Currency', 'GST %', 'Tax Name', 'Price Column',
  'Layout', 'Number Date', 'Ready', 'Company Name', 'GST Reg No', 'Address Label', 'Address', 'Tel',
  'Website', 'Bank Details', 'Currency Note', 'Footnote'];


export function parseCountries(table) {
  if (!table) {
    throw new Error(`The sheet has no "${CONFIG.COUNTRIES_SHEET}" tab. Import Countries.csv ` +
                    '(File > Import > Upload > Insert new sheet) and name the tab Countries.');
  }
  const h = table.headers;
  const get = (r, name) => { const i = headerIndex(h, name); return i >= 0 ? r[i] : ''; };
  const str = (r, name) => String(get(r, name) ?? '').trim();

  return table.rows.map((r) => {
    const code = str(r, 'Code').toUpperCase();
    const isSG = code === 'SG';
    const currency = str(r, 'Currency').toUpperCase();

    let gst = parseFloat(String(get(r, ['GST %', 'GST', 'Tax %', 'Tax'])).replace(/[^0-9.]/g, '')) || 0;
    if (gst && gst > 0 && gst < 1) gst *= 100;          // a percent cell reads as 0.09
    const taxRate = gst > 0 ? 1 + gst / 100 : 1;

    const bankText = str(r, 'Bank Details');
    const bankBlocks = bankText.split(/\n\s*\n/).map((b) => b.split('\n').map((l) => l.trim()).filter(Boolean)).filter((b) => b.length);

    const readyCell = get(r, 'Ready');
    const company = {
      name: str(r, 'Company Name'),
      gstRegNo: str(r, ['GST Reg No', 'Tax Reg No']),
      storeLabel: str(r, 'Address Label') || 'Flagship Store',
      store: str(r, 'Address'),
      tel: str(r, 'Tel'),
      website: str(r, 'Website'),
      currencyNote: str(r, 'Currency Note') || (currency ? 'ALL PRICES ARE IN ' + currency : ''),
      footnote: str(r, 'Footnote'),
      bankBlocks,
      // "Bank Name: HSBC" -> ['Bank Name:', 'HSBC'] for the two-column sg layout
      bankPairs: bankBlocks.flat().map((l) => {
        const i = l.indexOf(':');
        return i < 0 ? ['', l] : [l.slice(0, i + 1), l.slice(i + 1).trim()];
      })
    };
    const missing = [!company.name && 'Company Name', !bankText && 'Bank Details', !currency && 'Currency'].filter(Boolean);

    return {
      code,
      name: str(r, 'Country') || code,
      flag: str(r, 'Flag'),
      currency,
      symbol: isSG ? '$' : currency + ' ',
      taxRate,
      taxName: str(r, 'Tax Name') || 'GST',
      priceColumn: str(r, 'Price Column') || (isSG ? 'Price' : 'Price ' + currency),
      layout: str(r, 'Layout').toLowerCase() === 'simple' ? 'simple' : 'sg',
      idPrefix: isSG ? '' : code,
      idDate: (str(r, 'Number Date') || (isSG ? 'yyyymmdd' : 'yymmdd')).toLowerCase() === 'yyyymmdd' ? 'yyyymmdd' : 'yymmdd',
      ready: (readyCell === true || /^(true|yes|y|1|✓|x)$/i.test(String(readyCell).trim())) && !missing.length,
      missing,
      company
    };
  }).filter((c) => /^[A-Z]{2}$/.test(c.code));
}

export function countryByCode(countries, code) {
  return countries.find((c) => c.code === String(code || '').toUpperCase()) || null;
}

/** Country from a Tracker cell ("Hong Kong" or "HK"), else from the invoice number, else Singapore. */
export function countryFor(countries, value, invoiceId) {
  const v = String(value || '').trim().toLowerCase();
  const byValue = v && countries.find((c) => c.code.toLowerCase() === v || c.name.toLowerCase() === v);
  if (byValue) return byValue;
  const m = String(invoiceId || '').match(/^TC([A-Z]{2})\d/);
  const byId = m && countryByCode(countries, m[1]);
  if (byId) return byId;
  const sg = countryByCode(countries, 'SG') || countries[0];
  if (!sg) throw new Error(`The "${CONFIG.COUNTRIES_SHEET}" tab has no countries in it.`);
  return sg;
}
