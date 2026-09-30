/**
 * Saves PDFs into Google Drive:
 *
 *   <top folder> / <Country> / <Proforma | Invoice | Quotation> / file.pdf
 *
 * Two ways to connect, whichever is set in Vercel:
 *
 *   DRIVE_FOLDER_ID   (simplest, needs Google Workspace) the ID of a Shared
 *                     Drive, or a folder inside one, that the service
 *                     account has been added to as Content manager. No
 *                     sign-in needed. Service accounts cannot save into a
 *                     personal My Drive, only into Shared Drives.
 *
 *   GOOGLE_OAUTH_*    the app signs in as you and saves into your My Drive,
 *                     in a "TC Invoices" folder it creates.
 *
 * Uses the "drive.file" permission: the app can only see files and folders
 * it created itself, nothing else in your Drive. It finds its top folder by
 * a hidden tag, so you can move or rename "TC Invoices" freely.
 *
 * Needs GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET and
 * GOOGLE_OAUTH_REFRESH_TOKEN (get the last one from /api/google-auth).
 * Without them, PDFs are not saved to Drive and the Tracker gets the app's
 * own PDF link instead.
 */
import { env } from './config.js';
import { accessToken as serviceAccountToken } from './sheets.js';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const ROOT_NAME = 'TC Invoices';
const FOLDER = 'application/vnd.google-apps.folder';
const TYPE_FOLDERS = { 'Proforma Invoice': 'Proforma', 'Invoice': 'Invoice', 'Quotation': 'Quotation' };

let token = null;               // { value, expires }
const folders = new Map();      // path -> folder id, per server instance


const sharedFolder = () => (process.env.DRIVE_FOLDER_ID || '').trim();

export function driveConfigured() {
  return !!(sharedFolder() || (process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET &&
            process.env.GOOGLE_OAUTH_REFRESH_TOKEN));
}

async function accessToken() {
  if (sharedFolder()) return serviceAccountToken();
  if (token && token.expires > Date.now() + 60_000) return token.value;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: env('GOOGLE_OAUTH_CLIENT_ID').trim(),
      client_secret: env('GOOGLE_OAUTH_CLIENT_SECRET').trim(),
      refresh_token: env('GOOGLE_OAUTH_REFRESH_TOKEN').trim()
    })
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error('Google Drive sign-in failed (' + (data.error_description || data.error || res.status) + '). ' +
                    'Open /api/google-auth again to get a new sign-in code.');
  }
  token = { value: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  return token.value;
}

async function call(url, { method = 'GET', query, body, headers } = {}) {
  const u = new URL(url);
  u.searchParams.set('supportsAllDrives', 'true');           // Shared Drives need this on every call
  if (query) Object.entries(query).forEach(([k, v]) => u.searchParams.set(k, v));
  const res = await fetch(u, {
    method,
    headers: { authorization: 'Bearer ' + await accessToken(), ...(headers || {}) },
    body
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error('Google Drive: ' + (data.error && data.error.message ? data.error.message : 'HTTP ' + res.status));
    e.status = res.status;
    throw e;
  }
  return data;
}

const quote = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";


/* Folders ------------------------------------------------------------------- */

async function createFolder(name, parent, appProperties) {
  const f = await call(API + '/files', {
    method: 'POST',
    query: { fields: 'id' },
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER, ...(parent ? { parents: [parent] } : {}),
                           ...(appProperties ? { appProperties } : {}) })
  });
  return f.id;
}

async function findFolder(q) {
  const r = await call(API + '/files', { query: { q: `${q} and mimeType='${FOLDER}' and trashed=false`,
                                                  fields: 'files(id)', pageSize: '1',
                                                  includeItemsFromAllDrives: 'true', corpora: 'allDrives' } });
  return r.files && r.files[0] ? r.files[0].id : null;
}

/** The top folder: DRIVE_FOLDER_ID, or "TC Invoices" wherever it has been moved to. */
async function rootFolder() {
  if (sharedFolder()) return sharedFolder();
  if (folders.has('')) return folders.get('');
  const id = await findFolder("appProperties has { key='tcInvoicesRoot' and value='1' }") ||
             await createFolder(ROOT_NAME, null, { tcInvoicesRoot: '1' });
  folders.set('', id);
  return id;
}

async function subFolder(parent, name, path) {
  if (folders.has(path)) return folders.get(path);
  const id = await findFolder(`${quote(parent)} in parents and name=${quote(name)}`) ||
             await createFolder(name, parent);
  folders.set(path, id);
  return id;
}

async function folderFor(countryName, docType) {
  const root = await rootFolder();
  const c = await subFolder(root, countryName, countryName);
  const type = TYPE_FOLDERS[docType] || docType;
  return subFolder(c, type, countryName + '/' + type);
}


/* Files --------------------------------------------------------------------- */

/** The Drive file id inside a link the app wrote earlier, or ''. */
export function fileIdFromLink(link) {
  const m = String(link || '').match(/drive\.google\.com\/file\/d\/([\w-]+)/);
  return m ? m[1] : '';
}

/**
 * Saves the PDF and returns its Drive link. When `existingLink` points at a
 * file this app saved before (a Regenerate), that file is replaced, so the
 * link stays the same.
 */
export async function savePdf(pdf, name, countryName, docType, existingLink = '') {
  const oldId = fileIdFromLink(existingLink);
  if (oldId) {
    try {
      const f = await call(`${UPLOAD}/files/${oldId}`, {
        method: 'PATCH',
        query: { uploadType: 'media', fields: 'id,webViewLink' },
        headers: { 'content-type': 'application/pdf' },
        body: pdf
      });
      await call(`${API}/files/${oldId}`, {                 // keep the name in step with the row
        method: 'PATCH', query: { fields: 'id' },
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name })
      }).catch(() => {});
      return f.webViewLink;
    } catch (e) {
      if (e.status !== 404 && e.status !== 403) throw e;  // deleted or not ours: make a new one
    }
  }

  const parent = await folderFor(countryName, docType);
  const boundary = 'tcinv' + Date.now();
  const meta = JSON.stringify({ name, mimeType: 'application/pdf', parents: [parent] });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
                `--${boundary}\r\ncontent-type: application/pdf\r\n\r\n`),
    Buffer.from(pdf),
    Buffer.from(`\r\n--${boundary}--`)
  ]);
  const f = await call(`${UPLOAD}/files`, {
    method: 'POST',
    query: { uploadType: 'multipart', fields: 'id,webViewLink' },
    headers: { 'content-type': `multipart/related; boundary=${boundary}` },
    body
  });
  return f.webViewLink;
}

/** For /api/setup: checks access and describes the top folder. */
export async function driveCheck() {
  const id = await rootFolder();
  let f;
  try {
    f = await call(`${API}/files/${id}`, { query: { fields: 'id,name,driveId' } });
  } catch (e) {
    if (sharedFolder() && (e.status === 404 || e.status === 403)) {
      throw new Error(`Google Drive: can't open DRIVE_FOLDER_ID ${id}. Add ${process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL} ` +
                      'to that Shared Drive as a Content manager, and check the ID is copied from the address bar.');
    }
    throw e;
  }
  if (sharedFolder() && !f.driveId) {
    throw new Error(`Google Drive: "${f.name}" is in someone's My Drive, not a Shared Drive. Service accounts can ` +
                    'only save into Shared Drives. Use a Shared Drive (or a folder inside one) instead.');
  }
  return `"${f.name}" https://drive.google.com/drive/folders/${id}` +
         (sharedFolder() ? ' (Shared Drive, via the service account)' : ' (your My Drive, signed in as you)');
}
