/**
 * GET /api/google-auth?key=<TELEGRAM_WEBHOOK_SECRET>
 *
 * One-time sign-in so the app can save PDFs into your Google Drive.
 *   1. Opening it sends you to Google to approve access (only to files
 *      this app creates).
 *   2. Google sends you back here, and the page shows a code. Put it in
 *      Vercel as GOOGLE_OAUTH_REFRESH_TOKEN and redeploy.
 *
 * Needs GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET, and this
 * page's address added to the OAuth client's "Authorised redirect URIs".
 */
import crypto from 'node:crypto';
import { env, appUrl } from '../lib/config.js';
import { sign, signedOk } from '../lib/telegram.js';
import { DRIVE_SCOPE } from '../lib/drive.js';

const page = (res, status, title, body) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.status(status).send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><body style="font:16px/1.5 -apple-system,sans-serif;max-width:640px;margin:40px auto;padding:0 16px">
<h1 style="font-size:22px">${title}</h1>${body}</body>`);
};

const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export default async function handler(req, res) {
  const redirectUri = appUrl() + '/api/google-auth';

  // Back from Google
  if (req.query.code || req.query.error) {
    if (!signedOk('google-auth', String(req.query.state || ''), 16)) {
      return page(res, 403, 'Link expired', '<p>Start again from <code>/api/google-auth?key=…</code>.</p>');
    }
    if (req.query.error) {
      return page(res, 400, 'Google did not give access', `<p>${escHtml(req.query.error)}</p>`);
    }
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(req.query.code),
        client_id: env('GOOGLE_OAUTH_CLIENT_ID').trim(),
        client_secret: env('GOOGLE_OAUTH_CLIENT_SECRET').trim(),
        redirect_uri: redirectUri
      })
    });
    const data = await r.json();
    if (!r.ok || !data.refresh_token) {
      return page(res, 400, 'Could not finish signing in',
        `<p>${escHtml(data.error_description || data.error || 'Google sent no refresh token.')}</p>` +
        '<p>If you have signed in before, remove the app at <a href="https://myaccount.google.com/permissions">' +
        'myaccount.google.com/permissions</a> and try again.</p>');
    }
    return page(res, 200, 'Signed in ✅',
      '<p>In Vercel → Settings → Environment Variables, add:</p>' +
      '<p><b>Name:</b> <code>GOOGLE_OAUTH_REFRESH_TOKEN</code><br><b>Value:</b></p>' +
      `<textarea readonly rows="4" style="width:100%;font:14px monospace" onclick="this.select()">${escHtml(data.refresh_token)}</textarea>` +
      '<p>Then redeploy. Keep this code private: it lets the app save files to your Drive. ' +
      'Close this page once it is saved.</p>');
  }

  // Start: only you, with the secret
  const hash = (s) => crypto.createHash('sha256').update(String(s)).digest();
  if (!crypto.timingSafeEqual(hash(req.query.key || ''), hash(env('TELEGRAM_WEBHOOK_SECRET')))) {
    return page(res, 403, 'Not allowed', '<p>Add <code>?key=</code> and your TELEGRAM_WEBHOOK_SECRET to the address.</p>');
  }
  // ?check=1 shows what would be sent to Google, to compare with the
  // Google Cloud settings when Google says "Access blocked".
  if (req.query.check) {
    const id = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
    return page(res, 200, 'Google sign-in check',
      '<p>Compare these with Google Cloud → Google Auth Platform → Clients → your client.</p>' +
      `<p><b>Client ID the app uses:</b><br><code>${escHtml(id || '(not set in Vercel)')}</code>` +
      (id !== id.trim() ? '<br>⚠️ It has spaces at the start or end: remove them in Vercel.' : '') +
      (id && !/\.apps\.googleusercontent\.com$/.test(id.trim()) ? '<br>⚠️ A Client ID ends in .apps.googleusercontent.com. This looks like something else.' : '') +
      '</p>' +
      `<p><b>Client secret set:</b> ${process.env.GOOGLE_OAUTH_CLIENT_SECRET ? 'yes' : 'no ⚠️'}</p>` +
      `<p><b>Redirect URI the app sends</b> (must be listed exactly under Authorised redirect URIs):<br><code>${escHtml(redirectUri)}</code></p>` +
      `<p><b>Permission asked for:</b> <code>${escHtml(DRIVE_SCOPE)}</code></p>` +
      `<p><a href="?key=${encodeURIComponent(String(req.query.key))}">Continue to Google sign-in →</a></p>`);
  }

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: env('GOOGLE_OAUTH_CLIENT_ID').trim(),
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: DRIVE_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state: sign('google-auth', 16)
  }).toString();
  res.setHeader('location', url.toString());
  res.status(302).send('Redirecting to Google…');
}
