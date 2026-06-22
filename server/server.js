require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const { google } = require('googleapis');
const gplay = require('google-play-scraper');
const store = require('app-store-scraper');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const ALLOWED_EMAIL = 'drabski@gmail.com';
const REPORT_TO = process.env.REPORT_TO || 'drabski.o@fibi.co.il';
const PORT = process.env.PORT || 3001;
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';
const DATA_DIR = process.env.DATA_DIR || __dirname;
const REPORT_CRON = process.env.REPORT_CRON || '0 7 * * *'; // 7:00 AM UTC daily

const app = express();

app.set('trust proxy', 1); // trust Fly.io's TLS termination proxy
app.use(express.json());
app.use(cors({
  origin: CLIENT_URL,
  credentials: true,
}));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
  },
}));

// ─── Persistence ─────────────────────────────────────────────────────────────

const LISTS_PATH = path.join(DATA_DIR, 'watchlists.json');
const TOKENS_PATH = path.join(DATA_DIR, 'tokens.json');

function loadAllLists() {
  // 1. Try DATA_DIR (the persistent volume in production)
  try {
    return JSON.parse(fs.readFileSync(LISTS_PATH, 'utf8'));
  } catch {}

  // 2. On first deploy: migrate from watchlists.json baked into the image
  if (DATA_DIR !== __dirname) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'watchlists.json'), 'utf8'));
      fs.writeFileSync(LISTS_PATH, JSON.stringify(data, null, 2), 'utf8');
      console.log('Migrated watchlists.json from image to data volume');
      return data;
    } catch {}
  }

  // 3. Legacy migration from watchlist.json + watchlistMeta.json
  let apps = [];
  try { apps = JSON.parse(fs.readFileSync(path.join(__dirname, 'watchlist.json'), 'utf8')); } catch {}
  let name = 'Competitor Watchlist';
  try { name = JSON.parse(fs.readFileSync(path.join(__dirname, 'watchlistMeta.json'), 'utf8')).name || name; } catch {}
  const id = `list-${Date.now()}`;
  return { activeId: id, lists: [{ id, name, apps }] };
}

function saveAllLists() {
  fs.writeFileSync(LISTS_PATH, JSON.stringify(listsData, null, 2), 'utf8');
}

function getActiveList() {
  return listsData.lists.find(l => l.id === listsData.activeId) ?? listsData.lists[0];
}

function loadStoredTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function saveTokens(tokens) {
  try {
    fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save tokens:', err.message);
  }
}

let listsData = loadAllLists();
// Persist immediately if we just migrated (LISTS_PATH didn't exist)
if (!fs.existsSync(LISTS_PATH)) {
  fs.writeFileSync(LISTS_PATH, JSON.stringify(listsData, null, 2), 'utf8');
}

const detailsCache = new Map();

function createOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/auth/google/callback'
  );
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ─── Auth ────────────────────────────────────────────────────────────────────

app.get('/auth/google', (req, res) => {
  const client = createOAuthClient();
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'openid',
      'email',
      'profile',
      'https://www.googleapis.com/auth/gmail.send',
    ],
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.redirect(`${CLIENT_URL}?error=access_denied`);
  }

  try {
    const client = createOAuthClient();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const { data } = await oauth2.userinfo.get();

    if (data.email !== ALLOWED_EMAIL) {
      return res.redirect(`${CLIENT_URL}?error=unauthorized`);
    }

    req.session.user = { email: data.email, name: data.name, picture: data.picture };
    req.session.tokens = tokens;
    saveTokens(tokens); // persist for the daily cron

    res.redirect(CLIENT_URL);
  } catch (err) {
    console.error('OAuth callback error:', err.message);
    res.redirect(`${CLIENT_URL}?error=auth_failed`);
  }
});

app.get('/auth/status', (req, res) => {
  if (req.session.user) {
    return res.json({ authenticated: true, user: req.session.user });
  }
  res.json({ authenticated: false });
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

// ─── Search ──────────────────────────────────────────────────────────────────

app.get('/api/search', requireAuth, async (req, res) => {
  const { q, platform, country = 'il' } = req.query;
  if (!q || q.trim().length < 2) return res.json([]);

  const searchOpts = { term: q.trim(), num: 6, lang: 'en', country };
  const results = [];

  try {
    if (platform !== 'ios') {
      const playResults = await gplay.search(searchOpts);
      for (const item of playResults) {
        if (!item.appId || item.appId === 'undefined') continue;
        results.push({
          id: `android-${item.appId}`,
          appId: String(item.appId),
          title: item.title,
          developer: item.developer,
          icon: item.icon,
          rating: item.score || null,
          platform: 'android',
          country,
          storeUrl: `https://play.google.com/store/apps/details?id=${item.appId}`,
        });
      }
    }
  } catch (err) {
    console.error('Google Play search error:', err.message);
  }

  try {
    if (platform !== 'android') {
      const iosResults = await store.search(searchOpts);
      for (const item of iosResults) {
        if (!item.id || !item.appId || item.appId === 'undefined') continue;
        results.push({
          id: `ios-${item.id}`,
          appId: String(item.appId),
          numericId: item.id,
          title: item.title,
          developer: item.developer,
          icon: item.icon,
          rating: item.score || null,
          platform: 'ios',
          country,
          storeUrl: `https://apps.apple.com/app/id${item.id}`,
        });
      }
    }
  } catch (err) {
    console.error('App Store search error:', err.message);
  }

  res.json(results);
});

// ─── Watchlist ───────────────────────────────────────────────────────────────

app.get('/api/watchlist', requireAuth, (req, res) => {
  res.json(getActiveList().apps);
});

app.post('/api/watchlist', requireAuth, (req, res) => {
  const entry = req.body;
  if (!entry?.appId || !entry?.platform || entry.appId === 'undefined' || !entry?.id || entry.id.includes('undefined')) {
    return res.status(400).json({ error: 'Invalid app data' });
  }
  const activeList = getActiveList();
  if (activeList.apps.find(w => w.id === entry.id)) {
    return res.status(409).json({ error: 'Already in watchlist' });
  }
  activeList.apps.push(entry);
  saveAllLists();
  fetchAppDetails(entry).catch(() => {});
  res.json({ success: true, watchlist: activeList.apps });
});

app.delete('/api/watchlist/:id', requireAuth, (req, res) => {
  const activeList = getActiveList();
  const idx = activeList.apps.findIndex(w => w.id === decodeURIComponent(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  activeList.apps.splice(idx, 1);
  saveAllLists();
  res.json({ success: true, watchlist: activeList.apps });
});

app.get('/api/watchlist/details', requireAuth, (req, res) => {
  const out = {};
  for (const w of getActiveList().apps) {
    const cached = detailsCache.get(w.id);
    out[w.id] = cached
      ? { updatedDate: cached.updatedDate, updatedTimestamp: cached.updatedTimestamp }
      : null;
  }
  res.json(out);
});

app.get('/api/watchlist/meta', requireAuth, (req, res) => {
  res.json({ name: getActiveList().name });
});

app.patch('/api/watchlist/meta', requireAuth, (req, res) => {
  const { name } = req.body;
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Name is required' });
  }
  const activeList = getActiveList();
  activeList.name = name.trim();
  saveAllLists();
  res.json({ name: activeList.name });
});

app.put('/api/watchlist/order', requireAuth, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids must be an array' });
  const activeList = getActiveList();
  const byId = Object.fromEntries(activeList.apps.map(w => [w.id, w]));
  const reordered = ids.map(id => byId[id]).filter(Boolean);
  const reorderedIds = new Set(ids);
  const orphans = activeList.apps.filter(w => !reorderedIds.has(w.id));
  activeList.apps.length = 0;
  [...reordered, ...orphans].forEach(w => activeList.apps.push(w));
  saveAllLists();
  res.json({ success: true, watchlist: activeList.apps });
});

// ─── Watchlists management ───────────────────────────────────────────────────

function listsResponse() {
  return {
    activeId: listsData.activeId,
    lists: listsData.lists.map(l => ({ id: l.id, name: l.name, count: l.apps.length, dailyReport: l.dailyReport ?? false })),
  };
}

app.get('/api/watchlists', requireAuth, (req, res) => {
  res.json(listsResponse());
});

app.post('/api/watchlists', requireAuth, (req, res) => {
  const { name } = req.body;
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Name is required' });
  }
  const id = `list-${Date.now()}`;
  listsData.lists.push({ id, name: name.trim(), apps: [] });
  listsData.activeId = id;
  saveAllLists();
  res.json(listsResponse());
});

app.put('/api/watchlists/active', requireAuth, (req, res) => {
  const { id } = req.body;
  if (!listsData.lists.find(l => l.id === id)) {
    return res.status(404).json({ error: 'List not found' });
  }
  listsData.activeId = id;
  saveAllLists();
  res.json(listsResponse());
});

app.patch('/api/watchlists/:id', requireAuth, (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const list = listsData.lists.find(l => l.id === id);
  if (!list) return res.status(404).json({ error: 'List not found' });
  if (typeof req.body.name === 'string' && req.body.name.trim()) {
    list.name = req.body.name.trim();
  }
  if (req.body.toggleDailyReport === true) {
    list.dailyReport = !(list.dailyReport ?? false);
  }
  saveAllLists();
  res.json(listsResponse());
});

app.delete('/api/watchlists/:id', requireAuth, (req, res) => {
  const id = decodeURIComponent(req.params.id);
  if (listsData.lists.length === 1) {
    return res.status(400).json({ error: 'Cannot delete the only list' });
  }
  const idx = listsData.lists.findIndex(l => l.id === id);
  if (idx === -1) return res.status(404).json({ error: 'List not found' });
  listsData.lists.splice(idx, 1);
  if (listsData.activeId === id) {
    listsData.activeId = listsData.lists[Math.min(idx, listsData.lists.length - 1)].id;
  }
  saveAllLists();
  res.json(listsResponse());
});

// ─── Report helpers ───────────────────────────────────────────────────────────

function formatDate(val) {
  if (!val) return null;
  const d = new Date(val);
  return isNaN(d) ? null : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Request timed out after ${ms / 1000}s`)), ms)
    ),
  ]);
}

async function fetchWithRetry(fn) {
  const isRateLimit = (msg) => msg.includes('429') || msg.toLowerCase().includes('rate limit') || msg.toLowerCase().includes('too many');
  const isPermanent = (msg) => msg.includes('404') || msg.toLowerCase().includes('not found') || msg.toLowerCase().includes('app not found');

  let lastErr;
  const attempts = [0, 1500, 4000];

  for (let i = 0; i < 3; i++) {
    if (attempts[i] > 0) await new Promise(r => setTimeout(r, attempts[i]));
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err.message || '';
      if (isPermanent(msg)) throw err;
      if (isRateLimit(msg)) {
        const backoff = i === 0 ? 5000 : 15000;
        console.warn(`Rate limited on attempt ${i + 1}, backing off ${backoff}ms…`);
        await new Promise(r => setTimeout(r, backoff));
        if (i < 2) continue;
        throw err;
      }
    }
  }
  throw lastErr;
}

async function fetchAppDetails(entry) {
  try {
    const country = entry.country ?? 'il';
    const details = await fetchWithRetry(async () => {
      if (entry.platform === 'android') {
        const d = await withTimeout(
          gplay.app({ appId: entry.appId, lang: 'he', country }),
          12000
        );
        return {
          ...entry,
          title: d.title,
          developer: d.developer,
          version: d.version || 'N/A',
          rating: d.score ? Number(d.score.toFixed(1)) : null,
          updatedDate: formatDate(d.updated),
          updatedTimestamp: d.updated ? new Date(d.updated).getTime() : 0,
          whatsNew: Array.isArray(d.recentChanges)
            ? d.recentChanges.join('\n')
            : d.recentChanges || 'No recent changes listed.',
        };
      } else {
        const lookupOpts = entry.numericId
          ? { id: Number(entry.numericId), lang: 'he', country }
          : { appId: entry.appId, lang: 'he', country };
        const d = await withTimeout(store.app(lookupOpts), 12000);
        return {
          ...entry,
          title: d.title,
          developer: d.developer,
          version: d.version || 'N/A',
          rating: d.score ? Number(d.score.toFixed(1)) : null,
          updatedDate: formatDate(d.updated),
          updatedTimestamp: d.updated ? new Date(d.updated).getTime() : 0,
          whatsNew: d.releaseNotes || 'No release notes available.',
        };
      }
    });

    detailsCache.set(entry.id, { ...details, cachedAt: new Date() });
    return details;

  } catch (err) {
    console.error(`Failed to fetch ${entry.appId}:`, err.message);
    const cached = detailsCache.get(entry.id);
    if (cached) {
      console.log(`Serving cached data for ${entry.appId} (from ${cached.cachedAt.toISOString()})`);
      return { ...cached, staleWarning: true };
    }
    return { ...entry, fetchError: `Could not retrieve data: ${err.message}` };
  }
}

function buildReportHTML(apps, reportDate, listName = 'Competitor Intelligence Report') {
  const isHebrew = text => /[֐-׿]/.test(text || '');
  const androidBadge = `<span style="font-size:11px;font-weight:600;color:#ffffff;background:#16a34a;padding:2px 8px;font-family:Arial,sans-serif;">אנדרואיד</span>`;
  const iosBadge = `<span style="font-size:11px;font-weight:600;color:#ffffff;background:#0369a1;padding:2px 8px;font-family:Arial,sans-serif;">iOS</span>`;

  const cards = apps.map(a => `
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;margin-bottom:16px;background:#ffffff;">
      <tr>
        <td style="padding:16px 20px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="text-align:right;direction:rtl;">
                <span style="font-size:16px;font-weight:700;color:#1a202c;font-family:Arial,sans-serif;">${a.title || a.appId}</span>
                &nbsp;&nbsp;
                ${a.platform === 'android' ? androidBadge : iosBadge}
              </td>
            </tr>
            <tr>
              <td style="padding-top:3px;font-size:12px;color:#718096;font-family:Arial,sans-serif;text-align:right;direction:rtl;">
                ${a.developer || 'לא ידוע'} &middot; ${a.platform === 'android' ? 'Google Play' : 'App Store'}
              </td>
            </tr>
          </table>
          <hr style="border:none;border-top:1px solid #e2e8f0;margin:12px 0;">
          ${a.fetchError
            ? `<p style="color:#e53e3e;font-size:13px;font-family:Arial,sans-serif;text-align:right;">לא ניתן לאחזר נתונים עבור אפליקציה זו.</p>`
            : `
          ${a.staleWarning && a.cachedAt ? `<p style="background:#fffbeb;border:1px solid #f6e05e;padding:8px 12px;margin:0 0 12px;font-size:12px;color:#92400e;font-family:Arial,sans-serif;text-align:right;direction:rtl;">מציג נתונים מהמטמון מ-${a.cachedAt.toLocaleDateString('he-IL', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} — שליפה חיה נכשלה</p>` : ''}
          <table cellpadding="0" cellspacing="0" style="font-size:13px;font-family:Arial,sans-serif;margin-bottom:12px;width:100%;" dir="rtl">
            <tr>
              <td width="80" style="color:#718096;font-weight:600;padding:3px 0;text-align:right;">גרסה</td>
              <td style="color:#2d3748;padding:3px 0 3px 12px;text-align:left;">${a.version || 'לא זמין'}</td>
            </tr>
            <tr>
              <td style="color:#718096;font-weight:600;padding:3px 0;text-align:right;">עודכן</td>
              <td style="color:#2d3748;padding:3px 0 3px 12px;text-align:left;">${a.updatedDate || 'לא זמין'}</td>
            </tr>
            <tr>
              <td style="color:#718096;font-weight:600;padding:3px 0;text-align:right;">דירוג</td>
              <td style="color:#2d3748;padding:3px 0 3px 12px;text-align:left;">${a.rating != null ? '&#11088; ' + a.rating + ' / 5.0' : 'לא זמין'}</td>
            </tr>
          </table>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="background:#f8fafc;padding:12px;">
                <div style="font-size:11px;font-weight:700;color:#4f46e5;letter-spacing:0.04em;font-family:Arial,sans-serif;margin-bottom:6px;text-align:right;">מה חדש</div>
                <div style="font-size:13px;color:#2d3748;line-height:1.6;font-family:Arial,sans-serif;white-space:pre-wrap;${isHebrew(a.whatsNew) ? 'direction:rtl;text-align:right;' : ''}">${a.whatsNew}</div>
              </td>
            </tr>
          </table>
          `}
        </td>
        <td width="4" style="background:#4f46e5;"></td>
      </tr>
    </table>
  `).join('');

  return `<!DOCTYPE html>
<html dir="rtl">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f1f5f9;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;">
    <tr>
      <td align="center" style="padding:24px 16px;">
        <table width="620" cellpadding="0" cellspacing="0">
          <tr>
            <td style="background:#4f46e5;padding:28px 24px;text-align:right;">
              <div style="font-size:22px;font-weight:800;color:#ffffff;font-family:Arial,sans-serif;">&#128640; ${listName}</div>
              <div style="font-size:14px;color:#c7d2fe;font-family:Arial,sans-serif;margin-top:6px;">${reportDate}</div>
              <div style="font-size:12px;color:#a5b4fc;font-family:Arial,sans-serif;margin-top:4px;">עוקב אחר ${apps.length} אפליקציות</div>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 0 16px;text-align:right;">
              <p style="margin:0;font-size:14px;line-height:1.7;color:#374151;font-family:Arial,sans-serif;direction:rtl;">
                היי! הנה העדכון היומי על מה שחדש בחוץ. ריכזנו לך את כל הגרסאות והשינויים האחרונים מה-App Store וה-Google Play. הנה מה שהשתנה:
              </p>
            </td>
          </tr>
          <tr>
            <td>${cards}</td>
          </tr>
          <tr>
            <td style="padding:16px 0;text-align:center;font-size:11px;color:#94a3b8;font-family:Arial,sans-serif;">
              נוצר על ידי עמרי דרבסקי
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

async function sendDailyReport(tokens, list) {
  if (!list) list = getActiveList();
  if (list.apps.length === 0) {
    console.log(`[cron] "${list.name}" is empty — skipping.`);
    return;
  }

  const apps = [];
  for (let i = 0; i < list.apps.length; i++) {
    apps.push(await fetchAppDetails(list.apps[i]));
    if (i < list.apps.length - 1)
      await new Promise(r => setTimeout(r, 200 + Math.floor(Math.random() * 300)));
  }

  const reportDate = new Date().toLocaleDateString('he-IL', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const html = buildReportHTML(apps, reportDate, list.name);

  const client = createOAuthClient();
  client.setCredentials(tokens);
  client.on('tokens', (refreshed) => {
    if (refreshed.access_token) saveTokens({ ...tokens, ...refreshed });
  });

  const gmail = google.gmail({ version: 'v1', auth: client });
  const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const subjectText = `AppFollow Report | ${list.name} | ${dateStr}`;
  const subject = `=?UTF-8?B?${Buffer.from(subjectText).toString('base64')}?=`;

  const raw = [
    `To: ${REPORT_TO}`,
    `From: ${ALLOWED_EMAIL}`,
    'Content-Type: text/html; charset=UTF-8',
    'MIME-Version: 1.0',
    `Subject: ${subject}`,
    '',
    html,
  ].join('\r\n');

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: Buffer.from(raw).toString('base64url') },
  });

  console.log(`[cron] Report sent for "${list.name}" — ${apps.length} apps`);
}

// ─── Report endpoints ─────────────────────────────────────────────────────────

app.post('/api/report/send', requireAuth, async (req, res) => {
  const { listId, sortedIds } = req.body || {};
  const tokens = req.session.tokens;

  let listsToSend;
  if (listId) {
    const list = listsData.lists.find(l => l.id === listId);
    if (!list) return res.status(404).json({ error: 'List not found' });
    const sortedList = sortedIds && sortedIds.length
      ? { ...list, apps: sortedIds.map(id => list.apps.find(a => a.id === id)).filter(Boolean) }
      : list;
    listsToSend = [sortedList];
  } else {
    listsToSend = listsData.lists.filter(l => l.dailyReport);
    if (listsToSend.length === 0) {
      return res.status(400).json({ error: 'No lists have daily report enabled.' });
    }
  }

  try {
    let totalApps = 0;
    for (const list of listsToSend) {
      await sendDailyReport(tokens, list);
      totalApps += list.apps.length;
    }
    saveTokens(tokens);
    res.json({ success: true, listsSent: listsToSend.length, appsReported: totalApps });
  } catch (err) {
    console.error('Report send error:', err.message);
    const authExpired = err.message?.includes('invalid_grant') || err.message?.includes('Token has been expired');
    res.status(authExpired ? 401 : 500).json({
      error: authExpired ? 'Session expired. Please log out and sign in again.' : 'Failed to send report.',
      details: err.message,
    });
  }
});

app.get('/api/report/preview', requireAuth, async (req, res) => {
  const activeList = getActiveList();
  if (activeList.apps.length === 0) {
    return res.status(400).json({ error: 'Your watchlist is empty. Add apps first.' });
  }
  try {
    const apps = [];
    for (let i = 0; i < activeList.apps.length; i++) {
      apps.push(await fetchAppDetails(activeList.apps[i]));
      if (i < activeList.apps.length - 1)
        await new Promise(r => setTimeout(r, 200 + Math.floor(Math.random() * 300)));
    }

    res.json(apps.map(a => ({
      id: a.id,
      title: a.title || a.appId,
      developer: a.developer,
      platform: a.platform,
      icon: a.icon,
      storeUrl: a.storeUrl,
      version: a.version,
      updatedDate: a.updatedDate,
      rating: a.rating,
      whatsNew: a.whatsNew,
      staleWarning: a.staleWarning || false,
      cachedAt: a.cachedAt ? a.cachedAt.toISOString() : null,
      fetchError: a.fetchError || null,
    })));
  } catch (err) {
    console.error('Preview error:', err.message);
    res.status(500).json({ error: 'Failed to generate preview.' });
  }
});

// ─── URL Lookup ──────────────────────────────────────────────────────────────

app.post('/api/lookup', requireAuth, async (req, res) => {
  const { url, country = 'il' } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  let playAppId = null;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'play.google.com' && parsed.pathname.startsWith('/store/apps/details')) {
      playAppId = parsed.searchParams.get('id');
    }
  } catch {}
  if (playAppId) {
    const appId = playAppId;
    try {
      const d = await gplay.app({ appId, lang: 'en', country });
      return res.json({
        id: `android-${appId}`,
        appId,
        title: d.title,
        developer: d.developer,
        icon: d.icon,
        rating: d.score || null,
        platform: 'android',
        country,
        storeUrl: `https://play.google.com/store/apps/details?id=${appId}`,
      });
    } catch {
      return res.status(404).json({ error: 'App not found on Google Play' });
    }
  }

  const iosMatch = url.match(/apps\.apple\.com\/.*\/id(\d+)/);
  if (iosMatch) {
    const numericId = Number(iosMatch[1]);
    try {
      const d = await store.app({ id: numericId, lang: 'en', country });
      return res.json({
        id: `ios-${numericId}`,
        appId: String(d.appId),
        numericId,
        title: d.title,
        developer: d.developer,
        icon: d.icon,
        rating: d.score || null,
        platform: 'ios',
        country,
        storeUrl: `https://apps.apple.com/app/id${numericId}`,
      });
    } catch {
      return res.status(404).json({ error: 'App not found on App Store' });
    }
  }

  res.status(400).json({ error: 'Paste a Google Play or App Store URL' });
});

// ─── Serve built React app (production) ──────────────────────────────────────

const PUBLIC_DIR = path.join(__dirname, 'public');
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
  app.get('*', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });
}

// ─── Daily cron ──────────────────────────────────────────────────────────────

cron.schedule(REPORT_CRON, async () => {
  console.log(`[cron] Firing at ${new Date().toISOString()}`);
  const tokens = loadStoredTokens();
  if (!tokens) {
    console.warn('[cron] No stored credentials — log in via the UI once to activate the daily report.');
    return;
  }
  const listsToSend = listsData.lists.filter(l => l.dailyReport);
  if (listsToSend.length === 0) {
    console.log('[cron] No lists have daily report enabled — nothing to send.');
    return;
  }
  for (const list of listsToSend) {
    try {
      await sendDailyReport(tokens, list);
    } catch (err) {
      console.error(`[cron] Failed for "${list.name}":`, err.message);
      if (err.message?.includes('invalid_grant') || err.message?.includes('Token has been expired')) {
        console.error('[cron] Refresh token expired — log in via the UI to re-activate.');
        break;
      }
    }
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Server → http://localhost:${PORT}`);
  console.log(`Daily report scheduled: ${REPORT_CRON} (UTC)`);
  const allApps = listsData.lists.flatMap(l => l.apps);
  if (allApps.length > 0) {
    (async () => {
      for (const entry of allApps) {
        await fetchAppDetails(entry).catch(() => {});
        await new Promise(r => setTimeout(r, 300));
      }
    })();
  }
});
