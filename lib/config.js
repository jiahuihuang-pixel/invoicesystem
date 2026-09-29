/**
 * Everything you might want to change lives here. Secrets (bot token,
 * Google key) are environment variables in Vercel, never in this file.
 */

export const CONFIG = {

  // --- Tabs in the Google Sheet -----------------------------------------
  TRACKER_SHEET: 'Tracker',
  CUSTOMERS_SHEET: 'Customers',
  PRODUCTS_SHEET: 'Product list',
  REQUESTS_SHEET: 'Bot Requests',   // same tab the Apps Script bot used
  CHATS_SHEET: 'Bot Chats',         // created automatically: groups the bot is in
  COUNTRIES_SHEET: 'Countries',     // company, bank and tax details per country (see lib/countries.js)

  // --- Tracker columns (matched ignoring case, spaces and punctuation) ---
  TRACKER: {
    invoiceId: 'Invoice ID',
    date: 'Date',
    country: 'Country',     // add this column; without it the country is read off the invoice number
    customer: 'Customer Name',
    address: 'Customer Address',
    email: 'Customer Email',
    po: 'PO Number',
    terms: 'Payment Terms',
    docType: 'Type of Invoice',
    discount: 'Discount',
    products: 'Products',
    requestedBy: 'Requested By',
    status: 'Status',
    pdfLink: 'PDF Link',
    generatedAt: 'Generated At'
  },

  // --- Customers tab columns --------------------------------------------
  CUSTOMERS: {
    id: 'Customer ID',
    name: 'Customer Name',
    address: ['Address', 'Customer Address', 'Billing Address', 'Address Line 1'],
    email: ['Email', 'Customer Email', 'Email Address'],
    terms: ['Payment Terms', 'Terms', 'Credit Terms'],
    margin: 'Margin',
    country: 'Country',
    createdAt: 'Created At',
    updatedAt: 'Last Updated',
    idPrefix: 'CUST-',
    idPad: 4
  },

  // --- Product list columns ---------------------------------------------
  // Each country's price column is set on the Countries tab.
  PRODUCTS: { name: 'Product Name', code: 'Barcode' },

  // Written into the Tracker Products column, one line per item. Must stay
  // what the Templates tab formulas split on, so the sheet sidebar keeps
  // producing the same invoice.
  PRODUCT_LINE_FORMAT: '{{name}} ({{code}}) x {{qty}}',

  // --- Choices shown in the form ----------------------------------------
  DOC_TYPES: ['Invoice', 'Quotation', 'Proforma Invoice'],
  TERMS: ['Cash Before Delivery', 'Cash On Delivery', '30 Days'],

  // Template rows 14-26 hold 13 lines; one is kept for the discount.
  MAX_ITEMS: 12,

  // Invoice numbers: 'TC' + country code + date + the day's count, two
  // digits. Singapore TC2026092901 (no code), Hong Kong TCHK26092901.
  INVOICE_SEQ_PAD: 2,

  STATUS: { pending: 'Pending', generated: 'Generated', sent: 'Sent', rejected: 'Rejected' },

  TIME_ZONE: 'Asia/Singapore',
  FILE_NAME_PATTERN: '{{docType}} {{invoiceId}} - {{customer}}'
};


/* Environment ------------------------------------------------------------ */

export function env(name, required = true) {
  const v = process.env[name];
  if (required && !v) throw new Error(`Environment variable ${name} is not set in Vercel.`);
  return v || '';
}

export function adminIds() {
  return env('TELEGRAM_ADMIN_IDS').split(/[,\s]+/).filter(Boolean).map(String);
}

export function isAdmin(userId) {
  return adminIds().includes(String(userId));
}

export function appUrl() {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL;
  throw new Error('APP_URL is not set.');
}
