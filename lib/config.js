/**
 * Everything you might want to change lives here. Secrets (bot token,
 * Google key) are environment variables in Vercel, never in this file.
 */

export const CONFIG = {

  // --- Tabs in the Google Sheet -----------------------------------------
  TRACKER_SHEET: 'Tracker',
  CUSTOMERS_SHEET: 'Customers',
  PRODUCTS_SHEET: 'Product list',
  REQUESTS_SHEET: 'Bot Requests',   // old: only read for requests made before the Tracker took over
  CHATS_SHEET: 'Bot Chats',         // created automatically: groups the bot is in
  COUNTRIES_SHEET: 'Countries',     // company, bank and tax details per country (see lib/countries.js)
  TEMPLATES_SHEET: 'Invoice Templates', // saved from the Template Studio, created when you first save
  // Special prices per customer: Customer | Product | Price (| Country).
  // Created by /api/setup. See lib/invoice.js specialPrice().
  CUSTOMER_PRICES_SHEET: 'Customer Prices',

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
    generatedAt: 'Generated At',
    // Telegram details, so the bot knows where to send the PDF back
    requesterId: 'Requester ID',
    chatId: 'Chat ID',
    chatTitle: 'Chat Title',
    fileId: 'Telegram File ID',
    note: 'Note',
    // Kept when a proforma is converted into a tax invoice
    proformaNo: 'Proforma No',
    proformaDate: 'Proforma Date',
    // "Customer prices" or "Original prices", so Regenerate prices the same way
    pricing: 'Pricing'
  },

  // The PDF link goes in the column for its document type. A proforma's
  // link stays in Proforma after it is converted; the tax invoice's goes
  // in Invoice.
  LINK_COLUMNS: { 'Invoice': 'Invoice', 'Quotation': 'Quotation', 'Proforma Invoice': 'Proforma' },

  // Tracker columns the app adds by itself (at the end) when missing
  AUTO_COLUMNS: ['country', 'requesterId', 'chatId', 'chatTitle', 'fileId', 'note', 'proformaNo', 'proformaDate', 'pricing'],

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

  // Most different items on one invoice. The PDF puts up to 20 on a page
  // and continues on the next (public/render/render.js, ITEMS_PER_PAGE).
  MAX_ITEMS: 100,

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
