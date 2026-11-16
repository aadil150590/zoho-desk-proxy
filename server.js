
const express = require('express');
// Node 18+ has global fetch built-in - no node-fetch needed
const app = express();
const PORT = process.env.PORT || 3001;

// ===== CORS - FIX FOR DASHBOARD FETCH =====
// Must be BEFORE all routes. Allows any origin (your Meta AI artifact + Render dashboard) to call the proxy.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.header('Access-Control-Max-Age', '86400');
  // Handle preflight - browser sends OPTIONS before GET/POST when cross-origin
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json());

const DC = process.env.ZOHO_DC || 'com';
const ORG_ID = process.env.ZOHO_ORG_ID;
const CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
let REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
let ACCESS_TOKEN = null;
let TOKEN_EXPIRY = 0;

async function getAccessToken() {
  if (ACCESS_TOKEN && Date.now() < TOKEN_EXPIRY - 60000) return ACCESS_TOKEN;
  const params = new URLSearchParams();
  params.append('refresh_token', REFRESH_TOKEN);
  params.append('client_id', CLIENT_ID);
  params.append('client_secret', CLIENT_SECRET);
  params.append('grant_type', 'refresh_token');
  const r = await fetch(`https://accounts.zoho.${DC}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  const j = await r.json();
  if (j.error) throw new Error(`Token refresh failed: ${JSON.stringify(j)}`);
  ACCESS_TOKEN = j.access_token;
  TOKEN_EXPIRY = Date.now() + (j.expires_in || 3600) * 1000;
  return ACCESS_TOKEN;
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, orgId: ORG_ID ? ORG_ID.slice(0,4) + '...' : null, dc: DC, hasClientId: !!CLIENT_ID, hasRefresh: !!REFRESH_TOKEN, time: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.send('<h2>Zoho Desk Proxy LIVE</h2><p>Health: <a href="/api/health">/api/health</a> | Tickets: <a href="/api/tickets?limit=100&from=1">/api/tickets?limit=100&from=1</a></p><p>CORS: * + OPTIONS enabled</p>');
});

app.get('/api/tickets', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 100); // Zoho max 100
    const from = parseInt(req.query.from) || 1;
    const sortBy = req.query.sortBy || 'createdTime';
    const token = await getAccessToken();
    // Zoho Desk API: GET /api/v1/tickets?orgId=...&limit=100&from=1&sortBy=createdTime&sortOrder=desc
    const url = `https://desk.zoho.${DC}/api/v1/tickets?orgId=${ORG_ID}&limit=${limit}&from=${from}&sortBy=${sortBy}&sortOrder=desc`;
    const r = await fetch(url, { headers: { 'Authorization': `Zoho-oauthtoken ${token}`, 'orgId': ORG_ID } });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch { j = { raw: text }; }
    if (j.error || j.errorCode) return res.status(502).json(j);
    // Return as {data:[...]} so dashboard can use j.data
    if (Array.isArray(j)) return res.json({ data: j });
    return res.json(j);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get('/api/agents', async (req, res) => {
  try {
    const token = await getAccessToken();
    const r = await fetch(`https://desk.zoho.${DC}/api/v1/agents?orgId=${ORG_ID}&limit=100`, { headers: { 'Authorization': `Zoho-oauthtoken ${token}` } });
    const j = await r.json();
    return res.json(j);
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.post('/webhook/zoho', (req, res) => {
  console.log('Zoho webhook:', JSON.stringify(req.body).slice(0, 500));
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Proxy listening on ${PORT} - CORS * + OPTIONS enabled`));
