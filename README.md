# Invoice requests on Vercel

This replaces the Telegram side of the Apps Script bot. Your Google Sheet stays
the database, and the sheet sidebar keeps working as before.

```
Manager taps "New invoice request" in the group
  → form opens inside Telegram (country, customer, items, details, review)
  → Submit: Tracker row + Bot Requests row written, group told "request #57 is in"
  → you get the PDF in your private chat within a few seconds
       ✅ Approve     → PDF is posted in the group it came from
       🔁 Regenerate  → after you fix the Tracker row
       ❌ Reject      → you reply with a reason, the manager is told
```

The PDF is drawn in code (`lib/pdf.js`) from the Tracker row. It no longer goes
through the Templates tab, which is what made it slow.

## Countries

The first question is the country. It picks the currency, prices and invoice number.
Every country uses the **Singapore invoice design**. Countries with tax get SUB-TOTAL /
tax / GRAND TOTAL; countries without get GRAND TOTAL only. Amounts show the currency
code (HKD, MYR, THB) where Singapore shows `$`.

The country details live in a **Countries** tab in your Google Sheet, not in this code,
so the bank details never go on GitHub and you can change them without redeploying.
Changes show up within a minute.

| Country | Prices from (Product list column) | Invoice no. |
|---|---|---|
| 🇸🇬 Singapore | `Price` | `TC2026092901` |
| 🇭🇰 Hong Kong | `Price HKD` | `TCHK26092901` |
| 🇲🇾 Malaysia | `Price MYR` | `TCMY26092901` |
| 🇹🇭 Thailand | `Price THB` | `TCTH26092901` |

The last two digits count that country's invoices for the day (01, 02 … 10, 11).

**Countries tab columns:** Code, Country, Flag, Currency, GST % (blank = no tax),
Tax Name (GST / SST / VAT; blank = GST), Price Column, Layout (blank or `sg` = Singapore
design, `simple` = the old Hong Kong proforma design), Number Date, Ready, Company Name,
GST Reg No, Address Label (blank = "Flagship Store"), Address, Tel, Website, Email, Bank Details
(one "Label: value" per line), Currency Note, Footnote. Blank letterhead cells are left off.
Optional letterhead extras: Header Style (blank = big bold company name level with the logo,
address under it; `large` = the same with an italic address; `classic` = the original small
Singapore letterhead with "Flagship Store:"), Reg No Label (e.g. Business Registration Number),
Stamp (red text top right, e.g. `<ORIGINAL>`), Invoice Title (e.g. TAX INVOICE / RECEIPT).

**Before you go live, in the Google Sheet:**
1. **File → Import → Upload** `Countries.csv` (in the NEW INVOICE folder, next to this one),
   choose **Insert new sheet(s)**, and rename the new tab to exactly **Countries**.
2. Add a **Price HKD** column to the Product list (and **Price MYR**, **Price THB** later).
   A product with no price in that column can't be picked for that country.
3. Add a **Country** column to the Tracker and to the Customers tab. The form only shows
   customers saved under the chosen country, plus older ones with no country.

**To switch on Malaysia or Thailand:** fill in their row on the Countries tab (at least
Currency, Company Name and Bank Details) and set Ready to TRUE. The form greys out any
country that isn't ready, and `/api/setup` tells you what is missing.

## Proforma → tax invoice

When a proforma is approved, the group message has a **🧾 Convert to tax invoice** button
(or anyone can send `/convert <number>`). A manager's tap sends you a message with
**✅ Convert and send**. Converting updates the same Tracker row:

- a new number dated the day it was asked for (e.g. `TCHK26100301`), type Invoice
- the old number and date move to **Proforma No** / **Proforma Date**
- the proforma's PDF link stays in the **Proforma** column; the tax invoice's goes in **Invoice**
- the tax invoice is posted to the group straight away

An admin tapping the button, or sending `/convert`, converts at once.

## One tracking tab

Everything is on the **Tracker**. The app adds the columns it needs at the end
(Country, Requester ID, Chat ID, Chat Title, Telegram File ID, Note, Proforma No,
Proforma Date, Invoice, Quotation, Proforma) the first time it runs, or when you open
`/api/setup`. You can hide the Telegram ones. The **Bot Requests** tab is only read for
requests made before this change; once those are finished you can delete it.
The old **PDF Link** column is no longer written.

## Saving PDFs to Google Drive

Every PDF is saved into Google Drive, in **<your folder> → Country → Proforma / Invoice /
Quotation**, and the Tracker links to the Drive file. Regenerate replaces the file, so the
link stays the same. Without this set up, the Tracker gets the app's own PDF links instead.

**Option A: a Shared Drive (easiest, needs Google Workspace).** Uses the service account
the app already has, so there's no sign-in.
1. Google Cloud → **APIs & Services → Library** → enable **Google Drive API** (same project).
2. In Google Drive, open **Shared drives** (left side) and pick or create one, e.g. "Invoices".
   You can also use a folder inside a Shared Drive.
3. **Manage members** → add the service account's email (`GOOGLE_SERVICE_ACCOUNT_EMAIL` in
   Vercel, ends in `iam.gserviceaccount.com`) as **Content manager**. Untick "notify".
4. Open the Shared Drive (or folder) and copy the ID from the address bar:
   `drive.google.com/drive/folders/`**`THIS PART`**
5. In Vercel add `DRIVE_FOLDER_ID` = that ID, and redeploy.
6. Open `/api/setup?key=…`. It should say **✅ Google Drive: saving into "Invoices" …**.

It must be a **Shared Drive**. Google doesn't let service accounts save into anyone's
personal "My Drive", even a folder shared with them.

**Option B: sign in as you (any account, saves into your My Drive).** Needs an OAuth client:
enable the Drive API; set up **Google Auth Platform** (Audience **Internal** for a company
account, or External + **Publish app**); create a **Web application** client with redirect URI
`https://<your-project>.vercel.app/api/google-auth`; put `GOOGLE_OAUTH_CLIENT_ID` and
`GOOGLE_OAUTH_CLIENT_SECRET` in Vercel and redeploy; open `/api/google-auth?key=…`, approve,
and save the code it shows as `GOOGLE_OAUTH_REFRESH_TOKEN`. If `DRIVE_FOLDER_ID` is set,
Option A is used instead.

## Special prices per customer

> **Currently switched off** (`USE_SPECIAL_PRICES: false` in `lib/config.js`): every line is at list price
> and the customer's Margin % is a Discount line. "Use original prices" in the form drops the margin.
> Set it to `true` to use the tabs below again.

**Easiest: the Price Book Helper tab.** Products down the side (a Product Name and/or
Barcode column), one column per company headed with its Customer Name or Customer ID, and the
company's price in the cell. A blank cell means the normal price. Columns such as Price,
Price HKD, RRP, Cost or Category are ignored, and title rows above the header are fine.
`/api/setup` lists the company columns it found and warns about any that don't match a
customer on the Customers tab.

**Or, row by row:**
The **Customer Prices** tab (created by `/api/setup`) holds deals, one row each:

| Customer | Product | Price | Country |
|---|---|---|---|
| Harmony Audio Pte Ltd | Sonos Ace White | 420 | |
| CUST-0001 | 8717755779003 | 1299 | SG |

- **Customer**: the Customer Name or Customer ID from the Customers tab.
- **Product**: the Product Name or Barcode from the Product list.
- **Price**: what they pay, in that country's currency, GST included like the Product list.
- **Country**: optional; blank means the price applies whichever country the invoice is for.

When a manager picks that customer, the form shows their prices (marked "special") and the
invoice lines use them. Products without a row use the Product list price, and the
customer's **Margin** only applies to those, never on top of a special price. For the rare
invoice at normal prices, tick **Use original prices** in the form: no special prices and no
automatic margin (a discount can still be typed). The Tracker's **Pricing** column records
which was used, so Regenerate prices it the same way.

## Original and copy (Thailand)

On the Countries tab, a **Copies** column with e.g. `<ORIGINAL>, <COPY>` makes that country's
PDF contain the whole invoice once per entry, each stamped with its own text, in one file.
This is for **companies** only: a customer whose **Customer Type** (Customers tab) is
`Individual` gets one copy with no stamp. Blank counts as Company. When a manager adds a new
customer for such a country, the form asks "Company or individual?" and saves the answer.

Invoices without a PO number leave out the PO line.

## Thai company details

New customers in Thailand enter their address as separate boxes, in the Thai tax-invoice
order: House No./Building/Room, Moo, Soi, Road, Sub-district (Khwaeng/Tambon), District
(Khet/Amphoe), Province, Postcode. Companies also give their 13-digit **Tax ID** and
**Head Office** or **Branch No.** These are saved on the Customers tab (**Tax ID** and
**Branch** columns, added automatically) and printed under BILL TO:

```
BILL TO   บริษัท สยามออดิโอ จำกัด (Branch 00001)
          88 อาคารเดอะพาร์ค ห้อง 08-138, ถนนรัชดาภิเษก
          แขวงคลองเตย, เขตคลองเตย
          กรุงเทพมหานคร 10110
          Tax ID: 0105566120449
```

English or Thai script both print: any text with Thai letters uses the **Sarabun** font
(`public/render/fonts/`, Open Font License, see `OFL.txt`). For customers you add to the
sheet yourself, type the Tax ID and Branch into those columns; a Tax ID that Sheets turned
into a number (lost its leading 0) is fixed when read. The labels ("Tax ID:", "Head Office",
"Branch") can be changed in the Template Studio under Labels.

## Template Studio (editing each country's invoice)

Open **`https://<your-project>.vercel.app/studio.html`** on a computer and enter your
`TELEGRAM_WEBHOOK_SECRET`. Pick a country and document type. The left side shows the real
PDF with a sample invoice and redraws as you type.

**Click anything on the invoice** to edit it in a small pop-up (text, size, bold/italic,
move a letterhead line up or down, remove it). **Drag** the logo, the letterhead, the stamp
or the title to move them; with one selected, the arrow keys nudge by half a point (hold
Shift for 5). "All settings for this" jumps to the full settings on the right:

- **Letterhead**: a list of lines (bold label + text, size, line height, space above,
  bold/italic, colour, wrap, blue link), with add, remove and move up/down, plus position.
- **Logo**, **Stamp** (e.g. `<ORIGINAL>` in red), **Title** (per document type), **Labels**
  (BILL TO, Invoice No, PO, Date, Terms, currency note).
- **Footer**: bank heading and lines, notes (e.g. terms and conditions), signature lines
  side by side (e.g. Authorised Signature / Received By), footnote.

Texts can pull from the Countries tab with fields like `{Company Name}`, `{Address}`,
`{Bank Details}`: click a box, then a field chip to insert it. **Save** stores that
country's template in an **Invoice Templates** tab (created on first save), and real
invoices use it straight away. **Reset to default** goes back to the built-in design.
The table and totals are the same for every country. Numbers are in points (1/72 inch);
the arrow keys nudge them.

Try it without logging in, with made-up data: `studio.html?demo=1` (nothing is saved).

## What lives where

| File | What it does |
|---|---|
| `public/` | The form (Telegram Mini App) |
| `api/telegram.js` | Telegram webhook: /invoice, /pending, the approve buttons |
| `api/catalog.js` | Sends products and customers to the form |
| `api/submit.js` | Saves a request, then sends you the PDF |
| `api/pdf.js` | The "PDF Link" on the Tracker; draws the invoice fresh each time |
| `api/setup.js` | One-time setup and health check |
| `api/google-auth.js` | One-time Google Drive sign-in |
| `lib/config.js` | Tab names, column names, choices |
| `lib/countries.js` | Reads the Countries tab (what each column means) |
| `public/render/` | The invoice drawing code and templates, shared by the server and the Studio |
| `public/studio.*`, `api/studio.js` | Template Studio |
| `lib/pdf.js` | The server's way in to `public/render/` |
| `lib/drive.js` | Saves PDFs into Google Drive |
| `lib/invoice.js` | Price maths and reading the Products column |

## Setup (about 20 minutes)

### 1. Let the app into your Google Sheet

1. Go to <https://console.cloud.google.com>, create a project (any name).
2. **APIs & Services → Library**, search **Google Sheets API**, click **Enable**.
3. **IAM & Admin → Service Accounts → Create service account**. Any name, skip the optional steps.
4. Open it, **Keys → Add key → Create new key → JSON**. A file downloads. Keep it private.
5. Open your invoice spreadsheet, **Share**, paste the service account's email
   (`client_email` in that file, ends in `iam.gserviceaccount.com`) and give it **Editor**.

### 2. Put the code on Vercel

1. Create a GitHub repository and upload the contents of this `invoice-app` folder
   (on github.com: **Add file → Upload files**, drag everything in).
2. On <https://vercel.com>: **Add New → Project**, import that repository, and click **Deploy**.
   The framework preset should say **Other**.

### 3. Environment variables

Vercel → your project → **Settings → Environment Variables**. Add each of these, then
**Deployments → ⋯ → Redeploy** so they take effect.

| Name | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Your bot token from @BotFather (the same one Apps Script uses) |
| `TELEGRAM_ADMIN_IDS` | `1071676986` (comma-separate if there are more of you) |
| `TELEGRAM_WEBHOOK_SECRET` | Any long random string you make up, letters and numbers only |
| `SPREADSHEET_ID` | The long ID in the sheet's address: `docs.google.com/spreadsheets/d/`**`THIS`**`/edit` |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | `client_email` from the JSON file |
| `GOOGLE_PRIVATE_KEY` | `private_key` from the JSON file, the whole thing including `-----BEGIN` and `END-----` |

### 4. Switch the bot over

1. Open `https://<your-project>.vercel.app/api/setup?key=<your TELEGRAM_WEBHOOK_SECRET>`.
   You should see a list of ✅. Anything with ❌ or ⚠️ tells you what to fix.
2. In **@BotFather**: `/mybots` → your bot → **Bot Settings → Configure Mini App → Enable Mini App**,
   and send it `https://<your-project>.vercel.app/`. The button in groups needs this.
3. In **Apps Script**, open **Triggers** (the clock icon on the left) and delete the
   `botPoll` trigger. Don't run `botUsePolling`, `botUseWebhook` or `botUseProxy` again:
   each one takes the bot back from Vercel.

### 5. Try it

In a group with the bot, send `/invoice` and tap the button. Submit a test request.
You should get the PDF in your private chat with the bot within a few seconds.

## Things to know

- **Prices.** Singapore prices are taken as GST-inclusive, and the invoice shows them
  divided by 1.09, the same as the Templates tab. The discount in the Tracker is in the
  country's currency, tax included. The grand total is always the list prices minus the
  discount. Change GST % on the Countries tab if GST changes.
- **The sheet sidebar only knows the Singapore template.** Don't use it on Hong Kong,
  Malaysia or Thailand rows: it would print them in SGD with GST. Use Regenerate in Telegram instead.
- **Document title.** The Singapore PDF prints INVOICE / QUOTATION / PROFORMA INVOICE at the
  top right; the sheet template had no title there. The Hong Kong one says "Proforma Invoice No.:"
  (your sample spelled it "Performa") and adds a Terms line under PO Number.
- **Items per invoice.** Up to 100. The item table stretches to fill the A4 page; each page holds up to
  20 items, and more continue on a second page ("Page 1 of 2", totals and bank details on the last page).
- **Characters.** The PDF font covers English and Western European letters. Chinese
  characters in a product or customer name print as `?`.
- **Two requests at the same second** could get the same invoice number. Unlikely at your volume;
  if it happens, fix one number on the Tracker and Bot Requests tabs.
- **PDF links** on the Tracker are signed with `TELEGRAM_WEBHOOK_SECRET`. Changing that
  secret breaks old links (the invoices themselves are fine; tap Regenerate for a new one).
- **Try the form without Telegram:** open `https://<your-project>.vercel.app/?demo=1`.
  It uses made-up data and does not submit anything.
